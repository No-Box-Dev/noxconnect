import { normalizeLegacyError } from "./lib/api-v1";
import { appForApiPath, isAppEnabled, serviceDisabledResponse } from "./lib/apps.js";
import {
  apiTokenProjectResource,
  projectScopedApiTokenPathSupported,
} from "./lib/api-auth.js";
import { reportNoxCueHttpFailure } from "./lib/noxcue-client";
import { resolveIdentityConnection } from "./lib/connection-identity";
import { verifyNoxHereAssertion } from "./lib/noxhere-assertion";
import {
  presentedProjectId,
  projectIdInPath,
  resolveActiveOrganizationProject,
  serviceForProjectRequest,
} from "./lib/request-project-scope.js";

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
  if (url.pathname === "/api/postmark/webhook") {
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
  if (url.pathname.startsWith("/api/public/project-shares/")
      || url.pathname.startsWith("/api/public/cue-dashboards/")) {
    return apiError(url, "guest_access_required", "Password shares have been retired. Ask an organization admin for an email invitation.", 410);
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

  if (/^\/api\/(?:v1\/)?(?:spots|cues)\/shares(?:\/|$)/.test(url.pathname)) {
    return apiError(url, "password_shares_retired", "Use project guest invitations instead of password shares", 410);
  }

  if (auth.accessLevel === "guest") {
    if (!["GET", "HEAD", "OPTIONS"].includes(context.request.method.toUpperCase())) {
      return apiError(url, "guest_read_only", "Guest access is read-only", 403);
    }
    const guestService = serviceForProjectRequest(url.pathname) || appForApiPath(url.pathname);
    const guestCollection = url.pathname === "/api/projects"
      || url.pathname === "/api/v1/projects"
      || url.pathname === "/api/me"
      || url.pathname === "/api/v1/me"
      || url.pathname === "/api/v1/services";
    if (!guestCollection && !guestService) {
      return apiError(url, "guest_scope_forbidden", "This operation is not available to guests", 403);
    }
    if (!guestCollection && guestService === "noxconnect") {
      return apiError(url, "guest_scope_forbidden", "This operation is not available to guests", 403);
    }
    if (guestService && guestService !== "noxconnect") {
      const projectId = presentedProjectId(context.request) || projectIdInPath(url.pathname) || auth.projectId;
      if (!guestCanAccess(auth.guestAccess, projectId, guestService)) {
        return apiError(url, "resource_not_found", "The requested resource was not found", 404);
      }
    }
  }

  const org = await context.env.DB.prepare(
    "SELECT id, github_login, suspended_at FROM orgs WHERE id = ? AND github_login = ? COLLATE NOCASE",
  ).bind(auth.orgId, auth.orgLogin).first();
  if (!org) return apiError(url, "organization_forbidden", "Organization is unavailable", 403);
  if (org.suspended_at) {
    return apiError(url, "organization_suspended", "This organization has been suspended. Contact support.", 403);
  }

  const presentedProject = presentedProjectId(context.request);
  const pathProject = projectIdInPath(url.pathname);
  const headerProject = context.request.headers.get("X-Project-ID")?.trim() || null;
  const queryProject = url.searchParams.get("project_id")?.trim() || null;
  if ((headerProject || queryProject) && !presentedProject) {
    return apiError(url, "invalid_project_scope", "Project scope is invalid", 400);
  }
  const selectors = [headerProject, queryProject, pathProject, auth.projectId].filter(Boolean);
  if (new Set(selectors).size > 1) {
    return apiError(url, "resource_not_found", "The requested resource was not found", 404);
  }
  const requestedProject = presentedProject || pathProject || auth.projectId;
  let projectId = null;

  if (requestedProject) {
    if ((presentedProject && presentedProject !== requestedProject)
        || (pathProject && pathProject !== requestedProject)
        || (auth.projectId && auth.projectId !== requestedProject)) {
      return apiError(url, "resource_not_found", "The requested resource was not found", 404);
    }

    const project = await resolveActiveOrganizationProject(
      context.env.DB,
      org.id,
      org.github_login,
      requestedProject,
    );
    if (!project) {
      return apiError(url, "project_not_found", "The project is unavailable in this organization", 404);
    }
    const serviceProject = Boolean(serviceForProjectRequest(url.pathname));
    if (serviceProject && project.archived === 1) {
      return apiError(url, "project_not_found", "The project is unavailable in this organization", 404);
    }
    if (serviceProject && project.enabled !== 1) {
      return apiError(url, "project_not_enabled", "The project is not enabled for service operations", 409);
    }
    const resource = await apiTokenProjectResource(
      context.env.DB,
      url.pathname,
      auth.orgId,
      url.searchParams,
    );
    if (resource && resource.projectId !== requestedProject) {
      return apiError(url, "resource_not_found", "The requested resource was not found", 404);
    }
    projectId = project.id;
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
    const requestedProjectId = presentedProject;
    if (requestedProjectId && requestedProjectId !== auth.projectId) {
      return apiError(url, "resource_not_found", "The requested resource was not found", 404);
    }
  }

  // Service switches are an authorization boundary, independent of the
  // credential type. Keep shared NoxConnect routes available so an admin can
  // enable a service again, but stop disabled product code before it runs.
  const appId = serviceForProjectRequest(url.pathname) || appForApiPath(url.pathname);
  if (appId && !(await isAppEnabled(context.env.DB, org.id, appId, projectId))) {
    const response = serviceDisabledResponse(appId);
    if (!url.pathname.startsWith("/api/v1/")) return response;
    const body = await response.json();
    return apiError(url, body.code ?? "service_not_enabled", body.error, response.status, {
      service: body.service,
      remediation: body.remediation,
    });
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
  context.data.projectId = projectId;
  context.data.auth = {
    type: auth.credentialType,
    id: auth.credentialId,
    scopes: auth.scopes,
    projectId,
    accessLevel: auth.accessLevel ?? "member",
    guestAccess: auth.guestAccess ?? null,
  };
  return nextApiResponse(context, url);
}

function guestCanAccess(access, projectId, service) {
  if (!access || typeof access !== "object") return false;
  if (access.organizationWide === true) return true;
  if (!projectId) return false;
  const services = access.projects?.[projectId];
  return services === null || (Array.isArray(services) && services.includes(service));
}

async function nextApiResponse(context, url) {
  const versioned = url.pathname.startsWith("/api/v1/");
  try {
    const rawResponse = await context.next();
    let response = versioned ? await normalizeLegacyError(rawResponse) : rawResponse;
    if (context.data?.projectId) {
      const headers = new Headers(response.headers);
      headers.set("X-Project-ID", context.data.projectId);
      response = new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }
    if (isDeprecatedCompatibilityPath(url.pathname)) {
      const headers = new Headers(response.headers);
      headers.set("Deprecation", "true");
      headers.append("Link", '</openapi.json>; rel="deprecation"; type="application/vnd.oai.openapi+json"');
      response = new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }
    if (response.status >= 500) reportNoxCueHttpFailure(context, null, response.status);
    return response;
  } catch (error) {
    reportNoxCueHttpFailure(context, error);
    if (!versioned) throw error;
    console.error("[noxconnect] API v1 handler failed:", error);
    return apiError(url, "internal_error", "Request failed", 500);
  }
}

function isDeprecatedCompatibilityPath(pathname) {
  if (!pathname.startsWith("/api/") || pathname.startsWith("/api/v1/")) return false;
  return !/^\/api\/(?:auth|health|webhook|review|public)(?:\/|$)/.test(pathname)
    && !/^\/api\/slack\/(?:oauth|events|interactions)(?:\/|$)/.test(pathname);
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
