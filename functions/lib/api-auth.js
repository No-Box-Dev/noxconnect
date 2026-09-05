import { decryptToken, encryptToken } from "./crypto";
import { findOAuthRow, refreshWithGitHub, saveOAuthTokens } from "./oauth-tokens.js";

export const SESSION_COOKIE = "__Host-nox_session";
export const CSRF_COOKIE = "nox_csrf";
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export const API_TOKEN_SCOPES = Object.freeze([
  "services:read",
  "noxfeed:read", "noxfeed:write",
  "noxspot:read", "noxspot:write",
  "noxcue:read", "noxcue:write",
]);

const encoder = new TextEncoder();

export async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function randomToken(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

export function parseCookies(header = "") {
  const cookies = {};
  for (const pair of header.split(";")) {
    const [rawName, ...rest] = pair.trim().split("=");
    if (rawName) cookies[rawName] = decodeURIComponent(rest.join("="));
  }
  return cookies;
}

export function sessionCookies(sessionToken, csrfToken, { secure = true } = {}) {
  const securePart = secure ? "; Secure" : "";
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(sessionToken)}; Path=/; HttpOnly; SameSite=Lax${securePart}; Max-Age=${SESSION_MAX_AGE_SECONDS}`,
    `${CSRF_COOKIE}=${encodeURIComponent(csrfToken)}; Path=/; SameSite=Lax${securePart}; Max-Age=${SESSION_MAX_AGE_SECONDS}`,
  ];
}

export function clearSessionCookies({ secure = true } = {}) {
  const securePart = secure ? "; Secure" : "";
  return [
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax${securePart}; Max-Age=0`,
    `${CSRF_COOKIE}=; Path=/; SameSite=Lax${securePart}; Max-Age=0`,
  ];
}

export async function createBrowserSession(db, encryptionKey, {
  githubLogin,
  githubToken,
  githubTokenExpiresAt = null,
}) {
  const sessionToken = randomToken();
  const csrfToken = randomToken();
  const [tokenHash, csrfHash, encryptedGitHubToken] = await Promise.all([
    sha256(sessionToken),
    sha256(csrfToken),
    encryptToken(githubToken, encryptionKey),
  ]);
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000).toISOString();
  await db.prepare(
    `INSERT INTO browser_sessions
       (token_hash, github_login, encrypted_github_token, csrf_hash,
        github_token_expires_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(tokenHash, githubLogin, encryptedGitHubToken, csrfHash, githubTokenExpiresAt, expiresAt).run();
  return { sessionToken, csrfToken, expiresAt };
}

export async function resolveBrowserSession(db, encryptionKey, request) {
  const cookies = parseCookies(request.headers.get("Cookie") || "");
  const sessionToken = cookies[SESSION_COOKIE];
  if (!sessionToken) return null;
  const tokenHash = await sha256(sessionToken);
  const row = await db.prepare(
    `SELECT token_hash, github_login, encrypted_github_token, csrf_hash,
            github_token_expires_at, expires_at
       FROM browser_sessions
      WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`,
  ).bind(tokenHash, new Date().toISOString()).first();
  if (!row) return null;
  const githubToken = await decryptToken(row.encrypted_github_token, encryptionKey);
  return { ...row, githubToken };
}

export async function refreshBrowserSession(db, env, session) {
  if (!env.GITHUB_APP_CLIENT_ID || !env.GITHUB_APP_CLIENT_SECRET || !env.ENCRYPTION_KEY) return null;
  const oauth = await findOAuthRow(db, session.githubToken);
  if (!oauth?.encrypted_refresh_token) return null;
  if (oauth.refresh_token_expires_at && Date.parse(oauth.refresh_token_expires_at) <= Date.now()) return null;
  const refreshToken = await decryptToken(oauth.encrypted_refresh_token, env.ENCRYPTION_KEY);
  const refreshed = await refreshWithGitHub({
    clientId: env.GITHUB_APP_CLIENT_ID,
    clientSecret: env.GITHUB_APP_CLIENT_SECRET,
    refreshToken,
  });
  if (refreshed.error || refreshed.transportError || !refreshed.accessToken) return null;
  await saveOAuthTokens(db, {
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken,
    expiresInSec: refreshed.expiresInSec,
    refreshTokenExpiresInSec: refreshed.refreshTokenExpiresInSec,
    githubLogin: session.github_login,
    encryptionKey: env.ENCRYPTION_KEY,
    oldAccessHash: oauth.hash,
  });
  const encrypted = await encryptToken(refreshed.accessToken, env.ENCRYPTION_KEY);
  const accessExpiresAt = refreshed.expiresInSec
    ? new Date(Date.now() + refreshed.expiresInSec * 1000).toISOString()
    : null;
  await db.prepare(
    `UPDATE browser_sessions
        SET encrypted_github_token = ?, github_token_expires_at = ?,
            last_used_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      WHERE token_hash = ? AND revoked_at IS NULL`,
  ).bind(encrypted, accessExpiresAt, session.token_hash).run();
  return { ...session, githubToken: refreshed.accessToken, github_token_expires_at: accessExpiresAt };
}

export async function validateSessionCsrf(session, request) {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase())) return true;
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) return false;
  const cookies = parseCookies(request.headers.get("Cookie") || "");
  const headerToken = request.headers.get("X-CSRF-Token") || "";
  const cookieToken = cookies[CSRF_COOKIE] || "";
  if (!headerToken || !cookieToken || !constantTimeEqual(headerToken, cookieToken)) return false;
  return constantTimeEqual(await sha256(headerToken), session.csrf_hash);
}

export function createApiTokenValue(environment = "live") {
  const id = `noxkey_${crypto.randomUUID().replaceAll("-", "")}`;
  const secret = randomToken();
  const token = `nox_sk_${environment}_${id.slice(-12)}_${secret}`;
  return { id, token, prefix: token.slice(0, 24) };
}

export function normalizeApiTokenScopes(scopes) {
  const unique = [...new Set(scopes)];
  if (!unique.length || unique.some((scope) => !API_TOKEN_SCOPES.includes(scope))) return null;
  return unique.sort();
}

export async function resolveApiToken(db, bearer) {
  if (!bearer.startsWith("nox_sk_")) return null;
  const tokenHash = await sha256(bearer);
  const row = await db.prepare(
    `SELECT t.id, t.org_id, t.project_id, t.name, t.environment, t.scopes_json,
            t.created_by, o.github_login AS org_login, project.name AS project_name,
            CASE WHEN routing.enabled = 1 AND COALESCE(project.archived, 0) = 0
                 THEN 1 ELSE 0 END AS project_enabled
       FROM api_tokens t JOIN orgs o ON o.id = t.org_id
       LEFT JOIN projects project ON project.id = t.project_id
       LEFT JOIN project_routing_settings routing
         ON routing.org_id = t.org_id AND routing.project_id = t.project_id
      WHERE t.token_hash = ? AND t.revoked_at IS NULL
        AND (t.expires_at IS NULL OR t.expires_at > ?)`,
  ).bind(tokenHash, new Date().toISOString()).first();
  if (!row) return null;
  let scopes;
  try { scopes = JSON.parse(row.scopes_json); } catch { return null; }
  return { ...row, scopes };
}

export async function apiTokenProjectResource(db, pathname, orgId, searchParams = new URLSearchParams()) {
  if (pathname === "/api/cues/metrics" && searchParams.get("sourceId")) {
    const row = await db.prepare(
      "SELECT project_id FROM cue_sources WHERE org_id = ? AND id = ?",
    ).bind(orgId, searchParams.get("sourceId")).first();
    return { kind: "resource", projectId: row?.project_id ?? null };
  }
  let match = pathname.match(/^\/api\/projects\/([^/]+)/);
  if (match) return { kind: "project", projectId: decodeURIComponent(match[1]) };

  match = pathname.match(/^\/api\/(?:issues|prs)\/([^/]+)/);
  if (match) {
    const row = await db.prepare(
      "SELECT project_id FROM project_repositories WHERE org_id = ? AND repo = ?",
    ).bind(orgId, decodeURIComponent(match[1])).first();
    return { kind: "resource", projectId: row?.project_id ?? null };
  }

  match = pathname.match(/^\/api\/spots\/sites\/([^/]+)/);
  if (match) {
    const row = await db.prepare(
      "SELECT project_id FROM spot_sites WHERE org_id = ? AND id = ?",
    ).bind(orgId, decodeURIComponent(match[1])).first();
    return { kind: "resource", projectId: row?.project_id ?? null };
  }

  match = pathname.match(/^\/api\/spots\/shares\/([^/]+)/);
  if (match) {
    const row = await db.prepare(
      "SELECT project_id FROM external_project_shares WHERE org_id = ? AND id = ?",
    ).bind(orgId, decodeURIComponent(match[1])).first();
    return { kind: "resource", projectId: row?.project_id ?? null };
  }

  match = pathname.match(/^\/api\/cues\/projects\/([^/]+)/);
  if (match) return { kind: "project", projectId: decodeURIComponent(match[1]) };

  match = pathname.match(/^\/api\/cues\/sources\/([^/]+)/);
  if (match) {
    const row = await db.prepare(
      "SELECT project_id FROM cue_sources WHERE org_id = ? AND id = ?",
    ).bind(orgId, decodeURIComponent(match[1])).first();
    return { kind: "resource", projectId: row?.project_id ?? null };
  }

  match = pathname.match(/^\/api\/cues\/shares\/([^/]+)/);
  if (match) {
    const row = await db.prepare(
      "SELECT project_id FROM cue_dashboard_shares WHERE org_id = ? AND id = ?",
    ).bind(orgId, decodeURIComponent(match[1])).first();
    return { kind: "resource", projectId: row?.project_id ?? null };
  }
  return null;
}

export function requiredApiTokenScope(pathname, method) {
  const access = ["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase()) ? "read" : "write";
  const match = pathname.match(/^\/api\/v1\/services\/([^/]+)/);
  if (match) return `${match[1]}:${access}`;
  if (pathname === "/api/v1/services" && access === "read") return "services:read";
  if (pathname === "/api/v1/feed" || /^\/api\/(issues|prs|engineer-activity|llm-settings)(?:\/|$)/.test(pathname) || /^\/api\/projects\/[^/]+\/backfill-prs$/.test(pathname)) return `noxfeed:${access}`;
  if (/^\/api\/spots(?:\/|$)/.test(pathname)) return `noxspot:${access}`;
  if (/^\/api\/cues(?:\/|$)/.test(pathname)) return `noxcue:${access}`;
  return null;
}

export function projectScopedApiTokenPathSupported(pathname, method) {
  const verb = method.toUpperCase();
  if (verb === "GET" && /^\/api\/v1\/services(?:\/[^/]+(?:\/(?:setup|health))?)?$/.test(pathname)) return true;
  if (verb === "GET" && pathname === "/api/v1/feed") return true;
  if (verb === "GET" && /^\/api\/(?:issues|prs)(?:\/|$)/.test(pathname)) return true;
  if (verb === "POST" && /^\/api\/projects\/[^/]+\/backfill-prs$/.test(pathname)) return true;
  if (/^\/api\/spots\/sites(?:\/|$)/.test(pathname)) return true;
  if (/^\/api\/cues\/sources(?:\/|$)/.test(pathname)) return true;
  if (verb === "GET" && (pathname === "/api/cues/events" || pathname === "/api/cues/metrics")) return true;
  if (/^\/api\/cues\/projects\/[^/]+\/metrics$/.test(pathname)) return true;
  return false;
}

export async function auditAuth(db, entry) {
  await db.prepare(
    `INSERT INTO auth_audit_log
       (org_id, actor_type, actor_id, action, target_id, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(
    entry.orgId ?? null,
    entry.actorType,
    entry.actorId,
    entry.action,
    entry.targetId ?? null,
    JSON.stringify(entry.metadata ?? {}),
  ).run();
}

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function constantTimeEqual(left, right) {
  const a = encoder.encode(String(left));
  const b = encoder.encode(String(right));
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return difference === 0;
}
