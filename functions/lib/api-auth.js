import { compatibilityApiPath } from "./api-paths.js";

// Project API tokens have already passed NoxHere lifecycle, route, service,
// and project checks. Connector handlers may admit them to project reads
// without presenting them as organization administrators.
export function canReadProjectResource(data) {
  return Boolean(data?.isAdmin || data?.auth?.type === "api_token");
}

export async function apiTokenProjectResource(db, pathname, orgId, searchParams = new URLSearchParams()) {
  pathname = compatibilityApiPath(pathname);
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

export function projectScopedApiTokenPathSupported(pathname, method) {
  const verb = method.toUpperCase();
  if (verb === "GET" && /^\/api\/v1\/services(?:\/[^/]+(?:\/(?:setup|health))?)?$/.test(pathname)) return true;
  pathname = compatibilityApiPath(pathname);
  if (verb === "GET" && pathname === "/api/v1/feed") return true;
  if (verb === "GET" && /^\/api\/(?:issues|prs)(?:\/|$)/.test(pathname)) return true;
  if (verb === "POST" && /^\/api\/projects\/[^/]+\/backfill-prs$/.test(pathname)) return true;
  if (/^\/api\/spots\/sites(?:\/|$)/.test(pathname)) return true;
  if (/^\/api\/cues\/sources(?:\/|$)/.test(pathname)) return true;
  if (verb === "GET" && (pathname === "/api/cues/events" || pathname === "/api/cues/metrics")) return true;
  if (/^\/api\/cues\/projects\/[^/]+\/metrics$/.test(pathname)) return true;
  return false;
}
