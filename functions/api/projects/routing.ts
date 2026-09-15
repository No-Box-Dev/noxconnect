import { getCtx, errorResponse, jsonResponse } from "../../lib/db";
import { getActiveRepoNames } from "../../lib/inactive-repos.js";
import { PROJECT_ROUTE_KEYS, type ProjectRouteKey } from "../../lib/project-routing";

interface Ctx {
  env: { DB: D1Database };
  data: { orgId: number; orgLogin: string; isAdmin: boolean };
}

interface ProjectRow { id: string; name: string; repo: string | null; archived: number; routing_enabled: number }
interface AssignmentRow { project_id: string; repo: string }
interface RouteRow { project_id: string; route_key: ProjectRouteKey; connection_id: string; channel_id: string }

export async function onRequestGet(context: Ctx): Promise<Response> {
  const { orgId, orgLogin, isAdmin } = getCtx(context) as Ctx["data"];
  if (!orgId) return errorResponse("Missing org context", 400);
  if (!isAdmin) return errorResponse("Admin required", 403);

  const [projectsResult, assignmentsResult, routesResult, activeRepositories] = await Promise.all([
    context.env.DB.prepare(
      `SELECT project.id, project.name, project.repo, COALESCE(project.archived, 0) AS archived,
              COALESCE(settings.enabled, 0) AS routing_enabled
         FROM projects project
         LEFT JOIN project_routing_settings settings
           ON settings.project_id = project.id AND settings.org_id = ?
        WHERE project.org_id = ?
        ORDER BY archived, routing_enabled DESC, lower(project.name)`,
    ).bind(orgId, orgId).all<ProjectRow>(),
    context.env.DB.prepare(
      `SELECT assignment.project_id, assignment.repo
         FROM project_repositories assignment
         JOIN projects project ON project.id = assignment.project_id
        WHERE assignment.org_id = ? AND project.owner_id = ?
        ORDER BY lower(assignment.repo)`,
    ).bind(orgId, orgLogin).all<AssignmentRow>(),
    context.env.DB.prepare(
      `SELECT route.project_id, route.route_key, route.connection_id, route.channel_id
         FROM project_slack_routes route
         JOIN projects project ON project.id = route.project_id
        WHERE route.org_id = ? AND project.owner_id = ?
          AND route.route_key IN (${PROJECT_ROUTE_KEYS.map(() => "?").join(", ")})`,
    ).bind(orgId, orgLogin, ...PROJECT_ROUTE_KEYS).all<RouteRow>(),
    getActiveRepoNames(context.env.DB, orgId, orgLogin),
  ]);

  const repositoriesByProject = new Map<string, string[]>();
  for (const assignment of assignmentsResult.results ?? []) {
    repositoriesByProject.set(assignment.project_id, [
      ...(repositoriesByProject.get(assignment.project_id) ?? []),
      assignment.repo,
    ]);
  }
  const routesByProject = new Map<string, Map<ProjectRouteKey, { connectionId: string; channelId: string }>>();
  for (const route of routesResult.results ?? []) {
    const projectRoutes = routesByProject.get(route.project_id) ?? new Map();
    projectRoutes.set(route.route_key, { connectionId: route.connection_id, channelId: route.channel_id });
    routesByProject.set(route.project_id, projectRoutes);
  }
  const empty = () => ({ connectionId: "", channelId: "" });
  const projects = (projectsResult.results ?? []).map((project) => {
    const routes = routesByProject.get(project.id);
    return {
      id: project.id,
      name: project.name,
      archived: Boolean(project.archived),
      enabled: project.routing_enabled === 1,
      repositories: repositoriesByProject.get(project.id) ?? [],
      routes: {
        noxfeedPosts: routes?.get("noxfeed_posts") ?? empty(),
        noxfeedReleaseNotes: routes?.get("noxfeed_release_notes") ?? empty(),
        noxCue: routes?.get("noxcue") ?? empty(),
        noxCueAlerts: routes?.get("noxcue_alerts") ?? empty(),
      },
    };
  });
  // Keep an inactive legacy assignment visible so an admin can remove it.
  const repositories = [...new Set([
    ...activeRepositories,
    ...(assignmentsResult.results ?? []).map((assignment) => assignment.repo),
  ])]
    .sort((a, b) => a.localeCompare(b));
  return jsonResponse({ projects, repositories });
}
