import { z } from "zod";
import { getCtx, errorResponse, jsonResponse } from "../../../lib/db";
import { getActiveRepoNames } from "../../../lib/inactive-repos.js";
import {
  PROJECT_ROUTE_KEYS,
  type ProjectRouteKey,
  validateProjectSlackDestination,
} from "../../../lib/project-routing";
import { validate } from "../../../lib/validate";

interface Ctx {
  env: { DB: D1Database; ENCRYPTION_KEY?: string };
  data: { orgId: number; orgLogin: string; isAdmin: boolean };
  params: { id: string };
  request: Request;
}

const Destination = z.object({
  connectionId: z.string().trim().max(120),
  channelId: z.string().trim().max(80),
}).superRefine((value, ctx) => {
  if (Boolean(value.connectionId) !== Boolean(value.channelId)) {
    ctx.addIssue({ code: "custom", message: "Workspace and channel must be selected together" });
  }
});

const ProjectRouting = z.object({
  enabled: z.boolean(),
  repositories: z.array(z.string().trim().min(1).max(240)).max(500),
  routes: z.object({
    noxfeedPosts: Destination,
    noxfeedReleaseNotes: Destination,
    noxCue: Destination,
    noxCueAlerts: Destination,
  }).strict(),
}).strict();

const ROUTE_FIELDS: Array<[keyof z.infer<typeof ProjectRouting>["routes"], ProjectRouteKey]> = [
  ["noxfeedPosts", "noxfeed_posts"],
  ["noxfeedReleaseNotes", "noxfeed_release_notes"],
  ["noxCue", "noxcue"],
  ["noxCueAlerts", "noxcue_alerts"],
];

export async function onRequestPut(context: Ctx): Promise<Response> {
  const { orgId, orgLogin, isAdmin } = getCtx(context) as Ctx["data"];
  if (!orgId) return errorResponse("Missing org context", 400);
  if (!isAdmin) return errorResponse("Admin required", 403);

  let raw: unknown;
  try { raw = await context.request.json(); }
  catch { return errorResponse("Invalid JSON body", 400); }
  const parsed = validate(ProjectRouting, raw);
  if (!parsed.ok) return parsed.response;
  const input = parsed.data;
  const normalizedRepositories = input.repositories.map((repo) => repo.toLowerCase());
  if (new Set(normalizedRepositories).size !== normalizedRepositories.length) {
    return errorResponse("A repository may only be selected once", 422);
  }

  const project = await context.env.DB.prepare(
    "SELECT id FROM projects WHERE id = ? AND org_id = ? AND COALESCE(archived, 0) = 0",
  ).bind(context.params.id, orgId).first<{ id: string }>();
  if (!project) return errorResponse("Active project not found in this organization", 404);

  if (input.enabled && input.repositories.length > 0) {
    const available = await getActiveRepoNames(context.env.DB, orgId, orgLogin);
    const allowed = new Set(available.map((repo) => repo.toLowerCase()));
    const unknown = input.repositories.filter((repo) => !allowed.has(repo.toLowerCase()));
    if (unknown.length > 0) return errorResponse(`Repositories are unavailable: ${unknown.join(", ")}`, 422);
  }

  if (input.enabled) {
    try {
      await Promise.all(ROUTE_FIELDS.map(async ([field]) => {
        const destination = input.routes[field];
        await validateProjectSlackDestination(context.env, orgId, project.id, destination);
      }));
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : "Slack channel is unavailable", 409);
    }
  }

  const statements = [
    context.env.DB.prepare(
      `INSERT OR IGNORE INTO project_config (org_id, project_id, key, data, updated_at)
       SELECT ?, ?, 'settings', COALESCE(config.data, '{}'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
         FROM (SELECT 1) seed
         LEFT JOIN config ON config.org_id = ? AND config.key = 'settings'`,
    ).bind(orgId, project.id, orgId),
    context.env.DB.prepare(
      `INSERT OR IGNORE INTO project_ai_settings (org_id, project_id, mode, updated_at)
       SELECT ?, ?, COALESCE(ai.mode, 'managed'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
         FROM (SELECT 1) seed LEFT JOIN ai_settings ai ON ai.org_id = ?`,
    ).bind(orgId, project.id, orgId),
    context.env.DB.prepare(
      `INSERT INTO project_routing_settings (org_id, project_id, enabled, updated_at)
       VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
       ON CONFLICT(org_id, project_id) DO UPDATE SET
         enabled = excluded.enabled, updated_at = excluded.updated_at`,
    ).bind(orgId, project.id, input.enabled ? 1 : 0),
    context.env.DB.prepare(
      "DELETE FROM project_repositories WHERE org_id = ? AND project_id = ?",
    ).bind(orgId, project.id),
    ...input.repositories.map((repo) => context.env.DB.prepare(
      `INSERT INTO project_repositories (org_id, repo, project_id, updated_at)
       VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
       ON CONFLICT(org_id, repo) DO UPDATE SET
         project_id = excluded.project_id, updated_at = excluded.updated_at`,
    ).bind(orgId, repo, project.id)),
    context.env.DB.prepare(
      `DELETE FROM project_slack_routes
        WHERE org_id = ? AND project_id = ?
          AND route_key IN (${PROJECT_ROUTE_KEYS.map(() => "?").join(", ")})`,
    ).bind(orgId, project.id, ...PROJECT_ROUTE_KEYS),
    ...ROUTE_FIELDS.flatMap(([field, routeKey]) => {
      const destination = input.routes[field];
      return destination.channelId ? [context.env.DB.prepare(
        `INSERT INTO project_slack_routes
           (org_id, project_id, route_key, connection_id, channel_id, updated_at)
         VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
      ).bind(orgId, project.id, routeKey, destination.connectionId, destination.channelId)] : [];
    }),
  ];
  await context.env.DB.batch(statements);
  return jsonResponse({ ok: true, projectId: project.id, enabled: input.enabled, repositories: input.repositories });
}
