import { decryptToken, encryptToken } from "./crypto";
import { randomToken, sha256 } from "./api-auth.js";
import { refreshWithGitHub } from "./oauth-tokens.js";

export const NATIVE_ACCESS_MAX_AGE_SECONDS = 15 * 60;
export const NATIVE_REFRESH_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export class NativeAuthError extends Error {
  constructor(code, message, status = 503) {
    super(message);
    this.name = "NativeAuthError";
    this.code = code;
    this.status = status;
  }
}

export async function nativeAuthRateLimit(env, request, operation) {
  const limiter = env?.NATIVE_AUTH_RATE_LIMITER;
  if (!limiter || typeof limiter.limit !== "function") return "unavailable";
  const ip = request.headers.get("CF-Connecting-IP") || "local";
  const key = await sha256(`${operation}:${ip}`);
  try {
    return (await limiter.limit({ key })).success ? "allowed" : "limited";
  } catch {
    return "unavailable";
  }
}

export function createNativeCredentialValues() {
  return {
    accessToken: `nox_at_${randomToken()}`,
    refreshToken: `nox_rt_${randomToken()}`,
  };
}

/**
 * @param {D1Database} db
 * @param {string} encryptionKey
 * @param {{
 *   clientName?: string,
 *   githubLogin: string,
 *   githubToken: string,
 *   githubRefreshToken?: string | null,
 *   githubExpiresIn?: unknown,
 *   githubRefreshExpiresIn?: unknown,
 * }} input
 */
export async function createNativeSession(db, encryptionKey, {
  clientName = "noxfeed-mac",
  githubLogin,
  githubToken,
  githubRefreshToken = null,
  githubExpiresIn = null,
  githubRefreshExpiresIn = null,
}) {
  const id = `noxns_${crypto.randomUUID().replaceAll("-", "")}`;
  const { accessToken, refreshToken } = createNativeCredentialValues();
  const now = Date.now();
  const accessExpiresAt = new Date(now + NATIVE_ACCESS_MAX_AGE_SECONDS * 1000).toISOString();
  const refreshExpiresAt = new Date(now + NATIVE_REFRESH_MAX_AGE_SECONDS * 1000).toISOString();
  const githubTokenExpiresAt = positiveSeconds(githubExpiresIn)
    ? new Date(now + Number(githubExpiresIn) * 1000).toISOString() : null;
  const githubRefreshExpiresAt = positiveSeconds(githubRefreshExpiresIn)
    ? new Date(now + Number(githubRefreshExpiresIn) * 1000).toISOString() : null;
  const [accessHash, refreshHash, encryptedGitHubToken, encryptedGitHubRefreshToken] = await Promise.all([
    sha256(accessToken),
    sha256(refreshToken),
    encryptToken(githubToken, encryptionKey),
    githubRefreshToken ? encryptToken(githubRefreshToken, encryptionKey) : Promise.resolve(null),
  ]);
  await db.prepare(
    `INSERT INTO native_sessions
       (id, client_name, github_login, access_token_hash, refresh_token_hash,
        encrypted_github_token, encrypted_github_refresh_token,
        github_token_expires_at, github_refresh_expires_at,
        access_expires_at, refresh_expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id, clientName, githubLogin, accessHash, refreshHash,
    encryptedGitHubToken, encryptedGitHubRefreshToken,
    githubTokenExpiresAt, githubRefreshExpiresAt,
    accessExpiresAt, refreshExpiresAt,
  ).run();
  return {
    id, accessToken, refreshToken, accessExpiresAt, refreshExpiresAt,
    expiresIn: NATIVE_ACCESS_MAX_AGE_SECONDS,
  };
}

export async function resolveNativeSession(db, encryptionKey, bearer) {
  if (!bearer?.startsWith("nox_at_")) return null;
  const hash = await sha256(bearer);
  const row = await db.prepare(
    `SELECT * FROM native_sessions
      WHERE access_token_hash = ? AND revoked_at IS NULL
        AND access_expires_at > ? AND refresh_expires_at > ?`,
  ).bind(hash, new Date().toISOString(), new Date().toISOString()).first();
  if (!row) return null;
  return decryptNativeSession(row, encryptionKey);
}

export async function refreshNativeSession(db, env, refreshToken) {
  if (!refreshToken?.startsWith("nox_rt_") || !env.ENCRYPTION_KEY) return null;
  const refreshHash = await sha256(refreshToken);
  const row = await db.prepare(
    `SELECT * FROM native_sessions
      WHERE refresh_token_hash = ? AND revoked_at IS NULL AND refresh_expires_at > ?`,
  ).bind(refreshHash, new Date().toISOString()).first();
  if (!row) return null;
  let session = await decryptNativeSession(row, env.ENCRYPTION_KEY);
  session = await refreshProviderIfNeeded(db, env, session);
  if (!session) return null;

  const next = createNativeCredentialValues();
  const now = Date.now();
  const accessExpiresAt = new Date(now + NATIVE_ACCESS_MAX_AGE_SECONDS * 1000).toISOString();
  const refreshExpiresAt = new Date(now + NATIVE_REFRESH_MAX_AGE_SECONDS * 1000).toISOString();
  const [accessHash, nextRefreshHash] = await Promise.all([
    sha256(next.accessToken), sha256(next.refreshToken),
  ]);
  const result = await db.prepare(
    `UPDATE native_sessions
        SET access_token_hash = ?, refresh_token_hash = ?, access_expires_at = ?,
            refresh_expires_at = ?, rotated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
            last_used_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      WHERE id = ? AND refresh_token_hash = ? AND revoked_at IS NULL
      RETURNING id`,
  ).bind(accessHash, nextRefreshHash, accessExpiresAt, refreshExpiresAt, row.id, refreshHash).first();
  if (!result) return null;
  return {
    accessToken: next.accessToken,
    refreshToken: next.refreshToken,
    accessExpiresAt,
    refreshExpiresAt,
    expiresIn: NATIVE_ACCESS_MAX_AGE_SECONDS,
  };
}

export async function refreshProviderIfNeeded(db, env, session) {
  const expiresSoon = session.github_token_expires_at
    && Date.parse(session.github_token_expires_at) <= Date.now() + 60_000;
  if (!expiresSoon) return session;
  if (!session.githubRefreshToken || !env.GITHUB_APP_CLIENT_ID || !env.GITHUB_APP_CLIENT_SECRET) {
    return null;
  }
  if (session.github_refresh_expires_at && Date.parse(session.github_refresh_expires_at) <= Date.now()) return null;
  let refreshed;
  try {
    refreshed = await refreshWithGitHub({
      clientId: env.GITHUB_APP_CLIENT_ID,
      clientSecret: env.GITHUB_APP_CLIENT_SECRET,
      refreshToken: session.githubRefreshToken,
    });
  } catch {
    throw new NativeAuthError("provider_unavailable", "GitHub session refresh is temporarily unavailable");
  }
  if (refreshed.transportError) {
    throw new NativeAuthError("provider_unavailable", "GitHub session refresh is temporarily unavailable");
  }
  if (refreshed.error || !refreshed.accessToken) return null;
  const now = Date.now();
  const githubTokenExpiresAt = positiveSeconds(refreshed.expiresInSec)
    ? new Date(now + Number(refreshed.expiresInSec) * 1000).toISOString() : null;
  const githubRefreshExpiresAt = positiveSeconds(refreshed.refreshTokenExpiresInSec)
    ? new Date(now + Number(refreshed.refreshTokenExpiresInSec) * 1000).toISOString()
    : session.github_refresh_expires_at;
  const githubRefreshToken = refreshed.refreshToken || session.githubRefreshToken;
  const [encryptedGitHubToken, encryptedGitHubRefreshToken] = await Promise.all([
    encryptToken(refreshed.accessToken, env.ENCRYPTION_KEY),
    encryptToken(githubRefreshToken, env.ENCRYPTION_KEY),
  ]);
  await db.prepare(
    `UPDATE native_sessions
        SET encrypted_github_token = ?, encrypted_github_refresh_token = ?,
            github_token_expires_at = ?, github_refresh_expires_at = ?,
            last_used_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      WHERE id = ? AND revoked_at IS NULL`,
  ).bind(
    encryptedGitHubToken, encryptedGitHubRefreshToken,
    githubTokenExpiresAt, githubRefreshExpiresAt, session.id,
  ).run();
  return {
    ...session,
    githubToken: refreshed.accessToken,
    githubRefreshToken,
    github_token_expires_at: githubTokenExpiresAt,
    github_refresh_expires_at: githubRefreshExpiresAt,
  };
}

export async function revokeNativeSession(db, sessionId) {
  await db.prepare(
    "UPDATE native_sessions SET revoked_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?",
  ).bind(sessionId).run();
}

export async function revokeNativeSessionWithRefreshToken(db, refreshToken) {
  if (!refreshToken?.startsWith("nox_rt_")) return false;
  const refreshHash = await sha256(refreshToken);
  const result = await db.prepare(
    `UPDATE native_sessions
        SET revoked_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      WHERE refresh_token_hash = ? AND revoked_at IS NULL
      RETURNING id`,
  ).bind(refreshHash).first();
  return Boolean(result);
}

async function decryptNativeSession(row, encryptionKey) {
  const [githubToken, githubRefreshToken] = await Promise.all([
    decryptToken(row.encrypted_github_token, encryptionKey),
    row.encrypted_github_refresh_token
      ? decryptToken(row.encrypted_github_refresh_token, encryptionKey) : Promise.resolve(null),
  ]);
  return { ...row, githubToken, githubRefreshToken };
}

function positiveSeconds(value) {
  return Number.isFinite(Number(value)) && Number(value) > 0;
}
