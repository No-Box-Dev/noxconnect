import { appForApiPath } from "./apps.js";

const PROJECT_ID_MAX_LENGTH = 240;

/**
 * Return the product service selected by a request. Service control-plane
 * routes name the service in the URL; product resource routes are classified
 * by appForApiPath.
 */
export function serviceForProjectRequest(pathname) {
  if (pathname === "/api/v1/services") return "noxconnect";
  const serviceMatch = pathname.match(/^\/api\/v1\/services\/([^/]+)(?:\/|$)/);
  if (serviceMatch) return decodeURIComponent(serviceMatch[1]);
  return appForApiPath(pathname);
}

export function projectIdInPath(pathname) {
  const patterns = [
    /^\/api\/(?:v1\/)?projects\/([^/]+)\/(?:archive|routing|backfill-prs)$/,
    /^\/api\/(?:v1\/)?projects\/routing\/([^/]+)$/,
    /^\/api\/(?:v1\/)?cues\/projects\/([^/]+)(?:\/|$)/,
  ];
  for (const pattern of patterns) {
    const match = pathname.match(pattern);
    if (match) return decodeURIComponent(match[1]);
  }
  return null;
}

export function presentedProjectId(request) {
  // NoxFeed's released native clients send their repository selection as the
  // legacy project_id query filter. Treat it as the same optional scope so it
  // receives the middleware's organization/project membership validation.
  const header = request.headers.get("X-Project-ID")?.trim() ?? "";
  const query = new URL(request.url).searchParams.get("project_id")?.trim() ?? "";
  const value = header || query;
  if (!value || value.length > PROJECT_ID_MAX_LENGTH) return null;
  return value;
}

export async function resolveActiveOrganizationProject(db, orgId, orgLogin, projectId) {
  return db.prepare(
    `SELECT project.id, COALESCE(project.archived, 0) AS archived,
            COALESCE(routing.enabled, 0) AS enabled
       FROM projects project
       LEFT JOIN project_routing_settings routing
         ON routing.org_id = ? AND routing.project_id = project.id
      WHERE project.id = ?
        AND (project.org_id = ? OR (project.org_id IS NULL AND project.owner_id = ? COLLATE NOCASE))
      LIMIT 1`,
  ).bind(orgId, projectId, orgId, orgLogin).first();
}
