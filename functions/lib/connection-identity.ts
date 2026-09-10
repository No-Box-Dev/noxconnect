import { decryptToken, encryptToken } from "./crypto";
import { refreshWithGitHub } from "./oauth-tokens.js";

interface IdentityEnvironment {
  DB: D1Database;
  GITHUB_APP_CLIENT_ID?: string;
  GITHUB_APP_CLIENT_SECRET?: string;
  ENCRYPTION_KEY?: string;
  NOXHERE_OAUTH_CALLBACK_URL?: string;
}

interface GitHubTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_token_expires_in?: number;
  error?: string;
  error_description?: string;
}

interface GitHubUser {
  id: number;
  login: string;
  avatar_url?: string | null;
}

interface GitHubMembership {
  role?: string;
  state?: string;
  organization?: { login?: string };
}

interface ConnectionRow {
  id: string;
  github_user_id: number;
  github_login: string;
  avatar_url: string | null;
  encrypted_access_token: string;
  encrypted_refresh_token: string | null;
  access_token_expires_at: string | null;
  refresh_token_expires_at: string | null;
}

export interface IdentityExchangeResult {
  version: 1;
  connectionId: string;
  user: { id: number; login: string; avatarUrl: string | null };
  organizations: Array<{ id: number; login: string; role: "member" | "admin" }>;
}

export interface DeviceStartResult {
  version: 1;
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

export type DevicePollResult =
  | { version: 1; status: "pending" | "slow_down"; retryAfter: number }
  | { version: 1; status: "expired" | "denied" }
  | ({ version: 1; status: "complete" } & IdentityExchangeResult);

export async function exchangeGitHubOAuthIdentity(
  env: IdentityEnvironment,
  input: unknown,
): Promise<IdentityExchangeResult> {
  const parsed = parseExchangeInput(input, env.NOXHERE_OAUTH_CALLBACK_URL);
  if (!env.GITHUB_APP_CLIENT_ID || !env.GITHUB_APP_CLIENT_SECRET || !env.ENCRYPTION_KEY) {
    throw new Error("identity_provider_not_configured");
  }
  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": "NoxConnect" },
    body: JSON.stringify({
      client_id: env.GITHUB_APP_CLIENT_ID,
      client_secret: env.GITHUB_APP_CLIENT_SECRET,
      code: parsed.code,
      redirect_uri: parsed.redirectUri,
    }),
  });
  if (!tokenResponse.ok) throw new Error(`github_oauth_transport_${tokenResponse.status}`);
  const token = await tokenResponse.json<GitHubTokenResponse>();
  if (token.error || !token.access_token) throw new Error(token.error ?? "github_oauth_missing_token");

  return persistGitHubIdentity(env, token);
}

async function persistGitHubIdentity(
  env: IdentityEnvironment,
  token: GitHubTokenResponse,
): Promise<IdentityExchangeResult> {
  if (!token.access_token || !env.ENCRYPTION_KEY) throw new Error("identity_provider_not_configured");
  const identity = await loadGitHubIdentity(env.DB, token.access_token);
  const now = Date.now();
  const accessExpiry = positiveSeconds(token.expires_in)
    ? new Date(now + Number(token.expires_in) * 1000).toISOString()
    : null;
  const refreshExpiry = positiveSeconds(token.refresh_token_expires_in)
    ? new Date(now + Number(token.refresh_token_expires_in) * 1000).toISOString()
    : null;
  const connectionId = `noxic_${crypto.randomUUID().replaceAll("-", "")}`;
  const [encryptedAccess, encryptedRefresh] = await Promise.all([
    encryptToken(token.access_token, env.ENCRYPTION_KEY),
    token.refresh_token ? encryptToken(token.refresh_token, env.ENCRYPTION_KEY) : Promise.resolve(null),
  ]);
  const saved = await env.DB.prepare(
    `INSERT INTO identity_connections
       (id, github_user_id, github_login, avatar_url, encrypted_access_token,
        encrypted_refresh_token, access_token_expires_at, refresh_token_expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(github_user_id) DO UPDATE SET
       github_login = excluded.github_login,
       avatar_url = excluded.avatar_url,
       encrypted_access_token = excluded.encrypted_access_token,
       encrypted_refresh_token = excluded.encrypted_refresh_token,
       access_token_expires_at = excluded.access_token_expires_at,
       refresh_token_expires_at = excluded.refresh_token_expires_at,
       updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
       revoked_at = NULL
     RETURNING id`,
  ).bind(
    connectionId, identity.user.id, identity.user.login, identity.user.avatarUrl,
    encryptedAccess, encryptedRefresh, accessExpiry, refreshExpiry,
  ).first<{ id: string }>();
  if (!saved) throw new Error("identity_connection_not_saved");
  return { ...identity, version: 1, connectionId: saved.id };
}

export async function startGitHubDeviceIdentity(
  env: IdentityEnvironment,
  input: unknown,
): Promise<DeviceStartResult> {
  const client = parseDeviceClient(input);
  if (!env.GITHUB_APP_CLIENT_ID || !env.ENCRYPTION_KEY) throw new Error("identity_provider_not_configured");
  const response = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "NoxConnect" },
    body: new URLSearchParams({ client_id: env.GITHUB_APP_CLIENT_ID }),
  });
  const data = await response.json<Record<string, unknown>>().catch(() => null);
  if (!response.ok || !data || typeof data.device_code !== "string"
      || typeof data.user_code !== "string" || typeof data.verification_uri !== "string") {
    throw new Error("github_device_start_unavailable");
  }
  const interval = Math.min(60, Math.max(5, Number(data.interval) || 5));
  const expiresIn = Math.min(900, Math.max(60, Number(data.expires_in) || 900));
  const id = `noxid_${crypto.randomUUID().replaceAll("-", "")}`;
  await env.DB.prepare(
    `INSERT INTO identity_device_authorizations
       (id, client_name, encrypted_device_code, interval_seconds, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).bind(
    id, client, await encryptToken(data.device_code, env.ENCRYPTION_KEY), interval,
    new Date(Date.now() + expiresIn * 1000).toISOString(),
  ).run();
  return {
    version: 1,
    deviceCode: id,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    expiresIn,
    interval,
  };
}

export async function pollGitHubDeviceIdentity(
  env: IdentityEnvironment,
  input: unknown,
): Promise<DevicePollResult> {
  if (!env.GITHUB_APP_CLIENT_ID || !env.GITHUB_APP_CLIENT_SECRET || !env.ENCRYPTION_KEY) {
    throw new Error("identity_provider_not_configured");
  }
  const { client, deviceCode } = parseDevicePoll(input);
  const row = await env.DB.prepare(
    `SELECT id, encrypted_device_code, interval_seconds, expires_at, last_polled_at, result_json
       FROM identity_device_authorizations WHERE id = ? AND client_name = ?`,
  ).bind(deviceCode, client).first<Record<string, unknown>>();
  if (!row || Date.parse(String(row.expires_at)) <= Date.now()) return { version: 1, status: "expired" };
  if (typeof row.result_json === "string") {
    return { ...JSON.parse(row.result_json) as IdentityExchangeResult, status: "complete" };
  }
  const interval = Number(row.interval_seconds) || 5;
  const lastPolled = row.last_polled_at ? Date.parse(String(row.last_polled_at)) : 0;
  const remaining = interval * 1000 - (Date.now() - lastPolled);
  if (remaining > 0) return { version: 1, status: "slow_down", retryAfter: Math.ceil(remaining / 1000) };
  const claimed = await env.DB.prepare(
    `UPDATE identity_device_authorizations SET last_polled_at = ?
      WHERE id = ? AND result_json IS NULL
        AND (last_polled_at IS NULL OR last_polled_at <= ?) RETURNING id`,
  ).bind(
    new Date().toISOString(), deviceCode,
    new Date(Date.now() - interval * 1000).toISOString(),
  ).first();
  if (!claimed) return { version: 1, status: "slow_down", retryAfter: interval };
  const providerCode = await decryptToken(String(row.encrypted_device_code), env.ENCRYPTION_KEY);
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "NoxConnect" },
    body: new URLSearchParams({
      client_id: env.GITHUB_APP_CLIENT_ID,
      client_secret: env.GITHUB_APP_CLIENT_SECRET,
      device_code: providerCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  });
  const token = await response.json<GitHubTokenResponse>().catch(() => null);
  if (!response.ok || !token) throw new Error("github_device_poll_unavailable");
  if (token.error === "authorization_pending") return { version: 1, status: "pending", retryAfter: interval };
  if (token.error === "slow_down") return { version: 1, status: "slow_down", retryAfter: interval + 5 };
  if (token.error) return { version: 1, status: token.error === "expired_token" ? "expired" : "denied" };
  const identity = await persistGitHubIdentity(env, token);
  await env.DB.prepare(
    `UPDATE identity_device_authorizations
        SET result_json = ?, completed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
            encrypted_device_code = ''
      WHERE id = ? AND result_json IS NULL`,
  ).bind(JSON.stringify(identity), deviceCode).run();
  return { ...identity, status: "complete" };
}

export async function resolveIdentityConnection(
  env: IdentityEnvironment,
  connectionId: string,
): Promise<{ token: string; user: { id: number; login: string } } | null> {
  if (!env.ENCRYPTION_KEY) return null;
  const row = await env.DB.prepare(
    `SELECT id, github_user_id, github_login, avatar_url, encrypted_access_token,
            encrypted_refresh_token, access_token_expires_at, refresh_token_expires_at
       FROM identity_connections
      WHERE id = ? AND revoked_at IS NULL`,
  ).bind(connectionId).first<ConnectionRow>();
  if (!row) return null;
  let token = await decryptToken(row.encrypted_access_token, env.ENCRYPTION_KEY);
  const expiresSoon = row.access_token_expires_at
    && Date.parse(row.access_token_expires_at) <= Date.now() + 60_000;
  if (expiresSoon) {
    if (!row.encrypted_refresh_token || !env.GITHUB_APP_CLIENT_ID || !env.GITHUB_APP_CLIENT_SECRET) return null;
    if (row.refresh_token_expires_at && Date.parse(row.refresh_token_expires_at) <= Date.now()) return null;
    const refreshToken = await decryptToken(row.encrypted_refresh_token, env.ENCRYPTION_KEY);
    const refreshed = await refreshWithGitHub({
      clientId: env.GITHUB_APP_CLIENT_ID,
      clientSecret: env.GITHUB_APP_CLIENT_SECRET,
      refreshToken,
    });
    if (refreshed.error || refreshed.transportError || !refreshed.accessToken) return null;
    token = refreshed.accessToken;
    const nextAccessExpiry = positiveSeconds(refreshed.expiresInSec)
      ? new Date(Date.now() + Number(refreshed.expiresInSec) * 1000).toISOString()
      : null;
    const nextRefresh = refreshed.refreshToken || refreshToken;
    const nextRefreshExpiry = positiveSeconds(refreshed.refreshTokenExpiresInSec)
      ? new Date(Date.now() + Number(refreshed.refreshTokenExpiresInSec) * 1000).toISOString()
      : row.refresh_token_expires_at;
    const [encryptedAccess, encryptedRefresh] = await Promise.all([
      encryptToken(token, env.ENCRYPTION_KEY),
      encryptToken(nextRefresh, env.ENCRYPTION_KEY),
    ]);
    await env.DB.prepare(
      `UPDATE identity_connections
          SET encrypted_access_token = ?, encrypted_refresh_token = ?,
              access_token_expires_at = ?, refresh_token_expires_at = ?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
        WHERE id = ? AND revoked_at IS NULL`,
    ).bind(encryptedAccess, encryptedRefresh, nextAccessExpiry, nextRefreshExpiry, row.id).run();
  }
  return { token, user: { id: row.github_user_id, login: row.github_login } };
}

async function loadGitHubIdentity(
  db: D1Database,
  accessToken: string,
): Promise<Omit<IdentityExchangeResult, "version" | "connectionId">> {
  const headers = { Authorization: `Bearer ${accessToken}`, Accept: "application/vnd.github+json", "User-Agent": "NoxConnect" };
  const [userResponse, membershipsResponse] = await Promise.all([
    fetch("https://api.github.com/user", { headers }),
    fetch("https://api.github.com/user/memberships/orgs?state=active&per_page=100", { headers }),
  ]);
  if (!userResponse.ok || !membershipsResponse.ok) throw new Error("github_identity_unavailable");
  const user = await userResponse.json<GitHubUser>();
  const memberships = await membershipsResponse.json<GitHubMembership[]>();
  if (!Number.isSafeInteger(user.id) || !user.login || !Array.isArray(memberships)) {
    throw new Error("github_identity_invalid");
  }
  const organizations: IdentityExchangeResult["organizations"] = [];
  for (const membership of memberships) {
    const login = membership.organization?.login;
    if (!login || membership.state !== "active") continue;
    let org = await db.prepare("SELECT id FROM orgs WHERE github_login = ? COLLATE NOCASE")
      .bind(login).first<{ id: number }>();
    if (!org) {
      org = await db.prepare("INSERT INTO orgs (github_login) VALUES (?) RETURNING id")
        .bind(login).first<{ id: number }>();
    }
    if (!org) throw new Error("organization_resolution_failed");
    organizations.push({
      id: org.id,
      login,
      role: membership.role === "admin" ? "admin" as const : "member" as const,
    });
  }
  return {
    user: { id: user.id, login: user.login, avatarUrl: user.avatar_url ?? null },
    organizations,
  };
}

function parseExchangeInput(
  input: unknown,
  configuredCallback = "https://app.noxhere.com/api/auth/callback",
): { code: string; redirectUri: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid_identity_exchange");
  const value = input as Record<string, unknown>;
  if (typeof value.code !== "string" || !value.code || value.code.length > 512) throw new Error("invalid_identity_exchange_code");
  if (typeof value.redirectUri !== "string" || value.redirectUri.length > 2048) throw new Error("invalid_identity_redirect_uri");
  const redirect = new URL(value.redirectUri);
  const allowed = new URL(configuredCallback);
  if (redirect.toString() !== allowed.toString()) throw new Error("invalid_identity_redirect_uri");
  return { code: value.code, redirectUri: redirect.toString() };
}

function positiveSeconds(value: unknown): boolean {
  return Number.isFinite(Number(value)) && Number(value) > 0;
}

function parseDeviceClient(input: unknown): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid_device_request");
  const client = (input as Record<string, unknown>).client;
  if (client !== "noxfeed-mac") throw new Error("invalid_device_client");
  return client;
}

function parseDevicePoll(input: unknown): { client: string; deviceCode: string } {
  const client = parseDeviceClient(input);
  const deviceCode = (input as Record<string, unknown>).deviceCode;
  if (typeof deviceCode !== "string" || !deviceCode.startsWith("noxid_") || deviceCode.length > 96) {
    throw new Error("invalid_device_code");
  }
  return { client, deviceCode };
}
