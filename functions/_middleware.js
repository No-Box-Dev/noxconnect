import { normalizeLegacyError } from "./lib/api-v1";
import {
  apiTokenProjectResource,
  projectScopedApiTokenPathSupported,
} from "./lib/api-auth.js";
import { reportNoxCueHttpFailure } from "./lib/noxcue-client";
import { resolveIdentityConnection } from "./lib/connection-identity";
import { verifyNoxHereAssertion } from "./lib/noxhere-assertion";

export function isPlatformOperator(env, githubUserId) {
  if (!Number.isSafeInteger(githubUserId)) return false;
  const allowed = String(env.PLATFORM_ADMIN_GITHUB_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return allowed.includes(String(githubUserId));
}

export async function onRequest(context) {
  const url = new URL(context.request.url);

  // These routes authenticate themselves and never consume a NoxHere user
  // credential. All other API traffic must carry a signed NoxHere assertion.
  if (url.pathname === "/api/health/live" || url.pathname === "/api/health/ready") {
    return nextApiResponse(context, url);
  }
  if (url.pathname === "/api/cues/public/v1/events" || url.pathname === "/api/v1/cues/public/events") {
    return nextApiResponse(context, url);
  }
  if (url.pathname === "/api/webhook") {
    return nextApiResponse(context, url);
  }
  if (url.pathname === "/api/slack/oauth/callback" || url.pathname === "/api/slack/oauth/handoff") {
    return context.next();
  }
  if (url.pathname === "/api/slack/events" || url.pathname === "/api/slack/interactions") {
    return context.next();
  }
  if (url.pathname.startsWith("/api/review/")) {
    return context.next();
  }
  if (url.pathname.startsWith("/api/public/project-shares/")) {
    return context.next();
  }
  if (url.pathname.startsWith("/api/public/cue-dashboards/")) {
    return context.next();
  }
  if (!url.pathname.startsWith("/api/")) {
    return context.next();
  }

  let auth;
  try {
    auth = await verifyNoxHereAssertion(
      context.request,
      context.env.NOXHERE_INTERNAL_SECRET,
      context.env.NOXHERE_INTERNAL_SECRET_PREVIOUS,
    );
  } catch {
    return apiError(url, "invalid_internal_assertion", "Invalid NoxHere authorization assertion", 401);
  }
  if (!auth) {
    return apiError(
      url,
      "missing_internal_assertion",
      "NoxConnect accepts authenticated requests only from NoxHere",
      401,
    );
  }

  const org = await context.env.DB.prepare(
    "SELECT id, github_login, suspended_at FROM orgs WHERE id = ? AND github_login = ? COLLATE NOCASE",
  ).bind(auth.orgId, auth.orgLogin).first();
  if (!org) return apiError(url, "organization_forbidden", "Organization is unavailable", 403);
  if (org.suspended_at) {
    return apiError(url, "organization_suspended", "This organization has been suspended. Contact support.", 403);
  }

  if (auth.credentialType === "api_token") {
    if (!auth.projectId || !projectScopedApiTokenPathSupported(url.pathname, context.request.method)) {
      return apiError(
        url,
        "project_scope_unsupported",
        "This organization-level operation is not available to project-scoped tokens",
        403,
      );
    }
    const resource = await apiTokenProjectResource(
      context.env.DB,
      url.pathname,
      auth.orgId,
      url.searchParams,
    );
    if (resource && resource.projectId !== auth.projectId) {
      return apiError(url, "resource_not_found", "The requested resource was not found", 404);
    }
  }

  let providerToken = null;
  if (auth.connectionId) {
    const identity = await resolveIdentityConnection(context.env, auth.connectionId);
    if (!identity || identity.user.login.toLowerCase() !== auth.userLogin.toLowerCase()) {
      return apiError(url, "identity_connection_expired", "Connection identity expired; sign in again", 401);
    }
    providerToken = identity.token;
  }

  context.data.orgId = auth.orgId;
  context.data.orgLogin = auth.orgLogin;
  context.data.userLogin = auth.userLogin;
  context.data.userId = auth.userId;
  context.data.token = providerToken;
  context.data.isAdmin = auth.isAdmin;
  context.data.isPlatformOperator = isPlatformOperator(context.env, auth.userId);
  context.data.projectId = auth.projectId;
  context.data.auth = {
    type: auth.credentialType,
    id: auth.credentialId,
    scopes: auth.scopes,
    projectId: auth.projectId,
  };
  return nextApiResponse(context, url);
}

async function nextApiResponse(context, url) {
  const versioned = url.pathname.startsWith("/api/v1/");
  try {
    const rawResponse = await context.next();
    const response = versioned ? await normalizeLegacyError(rawResponse) : rawResponse;
    if (response.status >= 500) reportNoxCueHttpFailure(context, null, response.status);
    return response;
  } catch (error) {
    reportNoxCueHttpFailure(context, error);
    if (!versioned) throw error;
    console.error("[noxconnect] API v1 handler failed:", error);
    return apiError(url, "internal_error", "Request failed", 500);
  }
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
