import { encryptToken } from "./lib/crypto";
import { appForApiPath, isAppEnabled, serviceDisabledResponse } from "./lib/apps.js";
import {
  apiTokenProjectResource,
  projectScopedApiTokenPathSupported,
  requiredApiTokenScope,
  refreshBrowserSession,
  resolveApiToken,
  resolveBrowserSession,
  sha256,
  validateSessionCsrf,
} from "./lib/api-auth.js";
import {
  NativeAuthError,
  refreshProviderIfNeeded,
  resolveNativeSession,
  revokeNativeSession,
} from "./lib/native-auth.js";

// Cache validated tokens for 5 min to avoid hammering GitHub /user
const tokenCache = new Map();
// Cache org membership checks (keyed by tokenHash:orgLogin)
const membershipCache = new Map();

// Fraction of authenticated requests that also sweep expired sessions.
// At ~5 req/s steady state this fires every ~20s — frequent enough to keep the
// sessions table small without paying for it on every request.
const SESSION_CLEANUP_RATE = 0.01;

/** Hash a token with SHA-256 so raw tokens are never used as Map keys. */
async function hashToken(token) {
  return sha256(token);
}

/**
 * Validates a GitHub token. Returns:
 *   { login: string }             — valid token
 *   { error: "rate_limited", ... } — GitHub rate-limited the validation call
 *   { error: "invalid" }          — bad / revoked token
 */
async function validateGitHubToken(token) {
  const cacheKey = await hashToken(token);
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { login: cached.login, _cacheKey: cacheKey };
  }

  const res = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "NoxConnect",
    },
  });

  if (!res.ok) {
    // 403 from GitHub /user is almost always rate limiting, never an invalid
    // token (invalid tokens get 401). Treat all 403s as rate-limited to avoid
    // accidentally force-logging the user out.
    const retryAfter = res.headers.get("Retry-After");
    const isRateLimited = res.status === 429 || res.status === 403;
    if (isRateLimited) {
      const resetEpoch = res.headers.get("X-RateLimit-Reset");
      return { error: "rate_limited", resetEpoch, retryAfter };
    }
    // Token revoked / invalid — drop any stale cache entry so a re-auth
    // with a fresh token isn't blocked by a poisoned cache.
    tokenCache.delete(cacheKey);
    return { error: "invalid" };
  }

  const user = await res.json();
  tokenCache.set(cacheKey, {
    login: user.login,
    expiresAt: Date.now() + 5 * 60 * 1000,
  });
  return { login: user.login, _cacheKey: cacheKey };
}

/**
 * Verify user is a member of the given org. Caches for 5 min.
 * Returns true if member, false otherwise.
 */
async function verifyOrgMembership(token, tokenHash, orgLogin, userLogin) {
  const cacheKey = `${tokenHash}:${orgLogin}`;
  const cached = membershipCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.isMember;
  }

  const res = await fetch(
    `https://api.github.com/orgs/${encodeURIComponent(orgLogin)}/members/${encodeURIComponent(userLogin)}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "NoxConnect",
      },
    },
  );

  // 204 = member, 302 = requester is not an org member, 404 = not a member
  const isMember = res.status === 204;
  // Only cache positive results. A negative cache would lock the user out for
  // the full TTL after they're freshly added to the org.
  if (isMember) {
    membershipCache.set(cacheKey, {
      isMember: true,
      expiresAt: Date.now() + 5 * 60 * 1000,
    });
  }
  return isMember;
}

async function verifyOrgAdmin(token, orgLogin, userLogin) {
  const res = await fetch(
    `https://api.github.com/orgs/${encodeURIComponent(orgLogin)}/memberships/${encodeURIComponent(userLogin)}`,
    { headers: { Authorization: `Bearer ${token}`, "User-Agent": "NoxConnect" } },
  );
  if (!res.ok) return false;
  const membership = await res.json();
  return membership?.state === "active" && membership?.role === "admin";
}

export async function onRequest(context) {
  const url = new URL(context.request.url);

  // Public ingestion is authenticated by the NoxCue source key inside the
  // bound product Worker, not by a GitHub user bearer token.
  if (url.pathname === "/api/cues/public/v1/events") {
    return context.next();
  }

  // Skip auth for OAuth callback and webhook
  if (url.pathname.startsWith("/api/auth/") || url.pathname === "/api/webhook") {
    return context.next();
  }

  // Slack OAuth callback is hit by Slack as a browser redirect — no
  // Authorization header. The callback validates the ut_slack_state cookie
  // for CSRF and uses orgId embedded in `state` to persist the install.
  if (url.pathname === "/api/slack/oauth/callback" || url.pathname === "/api/slack/oauth/handoff") {
    return context.next();
  }

  // Slack Events API — the link_shared unfurl webhook. Verified inside
  // the handler with the signing secret + timestamp, so no bearer here.
  if (url.pathname === "/api/slack/events" || url.pathname === "/api/slack/interactions") {
    return context.next();
  }

  // NoxReview runner API — called by the local noxreview runner on Jasper's
  // Mac, not by a browser session. Handlers verify their own bearer token
  // (REVIEW_RUNNER_TOKEN) with a constant-time compare.
  if (url.pathname.startsWith("/api/review/")) {
    return context.next();
  }

  // Password-protected external NoxSpot project portals authenticate with a
  // scoped HttpOnly share-session cookie inside their own handlers. They do
  // not accept or expose NoxConnect/GitHub bearer credentials.
  if (url.pathname.startsWith("/api/public/project-shares/")) {
    return context.next();
  }

  // Password-protected NoxCue dashboards use their own narrowly scoped
  // HttpOnly session and never accept NoxConnect/GitHub credentials.
  if (url.pathname.startsWith("/api/public/cue-dashboards/")) {
    return context.next();
  }

  // Skip middleware for non-API routes
  if (!url.pathname.startsWith("/api/")) {
    return context.next();
  }

  const authHeader = context.request.headers.get("Authorization") || "";
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  const presentedOrg = context.request.headers.get("X-Org") || url.searchParams.get("org");
  let credentialType;
  let credentialId;
  let token = null;
  let userLogin;
  let orgLogin;
  let orgRow;
  let isAdmin = false;
  let scopes = [];
  let projectId = null;

  const apiCredential = bearer.startsWith("nox_sk_")
    ? await resolveApiToken(context.env.DB, bearer)
    : null;

  if (bearer.startsWith("nox_sk_")) {
    if (!apiCredential) return apiError(url, "unauthorized", "Invalid or expired API token", 401);
    const requiredScope = requiredApiTokenScope(url.pathname, context.request.method);
    if (!requiredScope) {
      return apiError(url, "api_token_not_supported", "This endpoint does not accept automation tokens", 403);
    }
    const writeEquivalent = requiredScope.endsWith(":read") ? requiredScope.replace(/:read$/, ":write") : null;
    if (!apiCredential.scopes.includes(requiredScope) && !(writeEquivalent && apiCredential.scopes.includes(writeEquivalent))) {
      return apiError(url, "insufficient_scope", `This operation requires ${requiredScope}`, 403, { requiredScope });
    }
    if (presentedOrg && presentedOrg.toLowerCase() !== apiCredential.org_login.toLowerCase()) {
      return apiError(url, "organization_forbidden", "API token belongs to a different organization", 403);
    }
    if (!apiCredential.project_id || apiCredential.project_enabled !== 1) {
      return apiError(url, "project_not_enabled", "This token's project is no longer enabled in NoxConnect", 403);
    }
    if (!projectScopedApiTokenPathSupported(url.pathname, context.request.method)) {
      return apiError(
        url,
        "project_scope_unsupported",
        "This organization-level operation is not available to project-scoped tokens",
        403,
      );
    }
    projectId = apiCredential.project_id;
    const presentedProject = context.request.headers.get("X-Project-ID")
      || url.searchParams.get("projectId")
      || url.searchParams.get("project");
    if (presentedProject && presentedProject !== projectId) {
      return apiError(url, "resource_not_found", "The requested resource was not found", 404);
    }
    const resource = await apiTokenProjectResource(context.env.DB, url.pathname, apiCredential.org_id, url.searchParams);
    if (resource && resource.projectId !== projectId) {
      return apiError(url, "resource_not_found", "The requested resource was not found", 404);
    }
    credentialType = "api_token";
    credentialId = apiCredential.id;
    userLogin = `api-token:${apiCredential.id}`;
    orgLogin = apiCredential.org_login;
    scopes = apiCredential.scopes;
    const serviceWriteScope = requiredScope.replace(/:(read|write)$/, ":write");
    isAdmin = apiCredential.scopes.includes(serviceWriteScope);
    orgRow = await context.env.DB.prepare(
      "SELECT id, suspended_at FROM orgs WHERE id = ?",
    ).bind(apiCredential.org_id).first();
    context.waitUntil?.(context.env.DB.prepare(
      "UPDATE api_tokens SET last_used_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?",
    ).bind(apiCredential.id).run());
  } else {
    let browserSession = null;
    let nativeSession = null;
    if (!bearer) {
      try {
        browserSession = await resolveBrowserSession(context.env.DB, context.env.ENCRYPTION_KEY, context.request);
      } catch (error) {
        console.error("[noxconnect] Browser session resolution failed:", error);
      }
      if (!browserSession) return apiError(url, "unauthorized", "Authentication required", 401);
      if (!(await validateSessionCsrf(browserSession, context.request))) {
        return apiError(url, "csrf_failed", "CSRF validation failed", 403);
      }
      if (browserSession.github_token_expires_at && Date.parse(browserSession.github_token_expires_at) <= Date.now() + 60_000) {
        browserSession = await refreshBrowserSession(context.env.DB, context.env, browserSession);
        if (!browserSession) return apiError(url, "unauthorized", "Session expired; sign in again", 401);
      }
      credentialType = "session";
      credentialId = browserSession.token_hash;
      token = browserSession.githubToken;
    } else if (bearer.startsWith("nox_at_")) {
      try {
        nativeSession = await resolveNativeSession(context.env.DB, context.env.ENCRYPTION_KEY, bearer);
        if (nativeSession) {
          nativeSession = await refreshProviderIfNeeded(context.env.DB, context.env, nativeSession);
        }
      } catch (error) {
        console.error("[noxconnect] Native session resolution failed:", error);
        if (error instanceof NativeAuthError) {
          return apiError(url, error.code, error.message, error.status);
        }
      }
      if (!nativeSession) return apiError(url, "unauthorized", "Native session expired; sign in again", 401);
      credentialType = "native_session";
      credentialId = nativeSession.id;
      token = nativeSession.githubToken;
    } else {
      // Compatibility path for native clients and local `gh auth token` use.
      // Browser code no longer stores or sends this provider credential.
      credentialType = "github_legacy";
      credentialId = await sha256(bearer);
      token = bearer;
    }

    const validation = await validateGitHubToken(token);
    if (validation.error === "rate_limited") {
      const resetInfo = validation.resetEpoch
        ? ` Resets at ${new Date(Number(validation.resetEpoch) * 1000).toISOString()}`
        : "";
      return apiError(
        url, "rate_limited", `GitHub API rate limit exceeded.${resetInfo}`, 429, undefined,
        validation.resetEpoch ? { "Retry-After": String(Math.max(0, Number(validation.resetEpoch) - Math.floor(Date.now() / 1000))) } : undefined,
      );
    }
    if (validation.error === "invalid") {
      if (credentialType === "session") {
        context.waitUntil?.(context.env.DB.prepare(
          "UPDATE browser_sessions SET revoked_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE token_hash = ?",
        ).bind(credentialId).run());
      }
      if (credentialType === "native_session") {
        context.waitUntil?.(revokeNativeSession(context.env.DB, credentialId));
      }
      return apiError(url, "unauthorized", "Invalid session", 401);
    }

    userLogin = validation.login;
    if (!presentedOrg) return apiError(url, "missing_organization", "Missing X-Org header or org query param", 400);
    orgLogin = presentedOrg;
    const isMember = await verifyOrgMembership(token, validation._cacheKey, orgLogin, userLogin);
    if (!isMember) return apiError(url, "organization_forbidden", "Not a member of this organization", 403);

    orgRow = await context.env.DB.prepare(
      "SELECT id, suspended_at FROM orgs WHERE github_login = ?",
    ).bind(orgLogin).first();
    if (!orgRow) {
      try {
        orgRow = await context.env.DB.prepare(
          "INSERT INTO orgs (github_login) VALUES (?) RETURNING id, suspended_at",
        ).bind(orgLogin).first();
      } catch {
        orgRow = await context.env.DB.prepare(
          "SELECT id, suspended_at FROM orgs WHERE github_login = ?",
        ).bind(orgLogin).first();
      }
      if (!orgRow) return apiError(url, "organization_resolution_failed", "Failed to resolve organization", 500);
    }

    const encryptedToken = await encryptToken(token, context.env.ENCRYPTION_KEY);
    const [, adminCheck, adminCount] = await context.env.DB.batch([
      context.env.DB.prepare(
        `INSERT INTO sessions (org_id, github_login, encrypted_token, updated_at)
         VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
         ON CONFLICT(org_id, github_login) DO UPDATE SET
           encrypted_token = excluded.encrypted_token,
           updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`,
      ).bind(orgRow.id, userLogin, encryptedToken),
      context.env.DB.prepare(
        "SELECT 1 AS is_admin FROM org_admins WHERE org_id = ? AND login = ?",
      ).bind(orgRow.id, userLogin),
      context.env.DB.prepare(
        "SELECT COUNT(*) AS count FROM org_admins WHERE org_id = ?",
      ).bind(orgRow.id),
    ]);
    isAdmin = (adminCheck.results?.length ?? 0) > 0;
    // Secure bootstrap: an unconfigured organization can only be claimed by
    // an active GitHub organization owner, never merely by the first member
    // who happens to make a request.
    const configuredAdmins = Number(adminCount.results?.[0]?.count ?? 0);
    if (!isAdmin && configuredAdmins === 0 && await verifyOrgAdmin(token, orgLogin, userLogin)) {
      await context.env.DB.prepare(
        `INSERT OR IGNORE INTO org_admins (org_id, login, granted_by_login)
         VALUES (?, ?, ?)`,
      ).bind(orgRow.id, userLogin, userLogin).run();
      isAdmin = true;
    }
    if (credentialType === "session") {
      context.waitUntil?.(context.env.DB.prepare(
        "UPDATE browser_sessions SET last_used_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE token_hash = ?",
      ).bind(credentialId).run());
    }
    if (credentialType === "native_session") {
      context.waitUntil?.(context.env.DB.prepare(
        "UPDATE native_sessions SET last_used_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?",
      ).bind(credentialId).run());
    }
  }

  if (!orgRow) return apiError(url, "organization_forbidden", "Organization is unavailable", 403);

  // Operator kill-switch: a suspended org is blocked before any work runs.
  if (orgRow.suspended_at) {
    return apiError(url, "organization_suspended", "This organization has been suspended. Contact support.", 403);
  }

  // App switches are enforced before service code runs. Shared NoxConnect
  // routes stay available so an admin can turn a service back on. No rows are
  // removed when a service is off.
  const appId = appForApiPath(url.pathname);
  if (appId && !(await isAppEnabled(context.env.DB, orgRow.id, appId))) {
    const response = serviceDisabledResponse(appId);
    if (!url.pathname.startsWith("/api/v1/")) return response;
    const body = await response.json();
    return apiError(url, body.code ?? "service_not_enabled", body.error, response.status, { service: body.service });
  }

  // Probabilistic session cleanup: SESSION_CLEANUP_RATE of requests trigger a sweep
  // of sessions older than 30 days. Keeping this here (vs a cron) means cleanup is
  // free-rolling and self-throttling at request volume.
  if (Math.random() < SESSION_CLEANUP_RATE) {
    // Route failures through recordFailure so a schema drift on the
    // sessions table surfaces in Settings → Background failures instead
    // of silently letting the table grow. Import inline — this file is
    // hot-path middleware and we don't want the require every request.
    context.waitUntil?.(
      context.env.DB.batch([
        context.env.DB.prepare("DELETE FROM sessions WHERE updated_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-30 days')"),
        context.env.DB.prepare("DELETE FROM browser_sessions WHERE expires_at <= strftime('%Y-%m-%dT%H:%M:%SZ', 'now') OR revoked_at IS NOT NULL"),
        context.env.DB.prepare("DELETE FROM native_sessions WHERE refresh_expires_at <= strftime('%Y-%m-%dT%H:%M:%SZ', 'now') OR revoked_at IS NOT NULL"),
        context.env.DB.prepare("DELETE FROM native_device_authorizations WHERE expires_at <= strftime('%Y-%m-%dT%H:%M:%SZ', 'now') OR consumed_at IS NOT NULL"),
      ]).catch(async (err) => {
        console.error("[noxconnect] Session cleanup failed:", err);
        try {
          const { recordFailure } = await import("./lib/op-failures.js");
          await recordFailure(context.env.DB, {
            ownerId: orgLogin,
            op: "middleware.session_cleanup",
            deliveryId: null,
            error: err,
          });
        } catch { /* recordFailure swallows its own errors; ignore any import miss too */ }
      })
    );
  }

  // Set context data for downstream handlers (plaintext token for API calls)
  context.data.orgId = orgRow.id;
  context.data.orgLogin = orgLogin;
  context.data.userLogin = userLogin;
  context.data.token = token;
  context.data.isAdmin = isAdmin;
  context.data.projectId = projectId;
  context.data.auth = { type: credentialType, id: credentialId, scopes, projectId };

  return context.next();
}

function apiError(url, code, message, status, details, extraHeaders) {
  const versioned = url.pathname.startsWith("/api/v1/");
  const body = versioned
    ? { apiVersion: 1, error: { code, message, ...(details === undefined ? {} : { details }) } }
    : { error: message };
  const headers = new Headers(extraHeaders);
  headers.set("Content-Type", "application/json");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  if (versioned) headers.set("Link", '</openapi.json>; rel="service-desc"');
  return new Response(JSON.stringify(body), { status, headers });
}
