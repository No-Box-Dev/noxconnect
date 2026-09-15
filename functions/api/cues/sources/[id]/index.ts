import { getCtx, errorResponse, jsonResponse } from "../../../../lib/db";
import { getNoxDb, type NoxDatabaseEnv } from "../../../../lib/nox-db";
import { cueSourceInputSchema } from "../../../../lib/noxcue-settings";
import { validateProjectSlackDestination } from "../../../../lib/project-routing";
import { validate } from "../../../../lib/validate";

interface Ctx {
  env: NoxDatabaseEnv;
  data: { orgId: number; projectId?: string | null; orgLogin: string; isAdmin: boolean };
  params: { id: string };
  request: Request;
}

export async function onRequestPut(context: Ctx): Promise<Response> {
  const { orgId, projectId, orgLogin, isAdmin } = getCtx(context) as Ctx["data"];
  if (!orgId) return errorResponse("Missing org context", 400);
  if (!isAdmin) return errorResponse("Admin required", 403);
  const db = getNoxDb(context.env);
  let raw: unknown;
  try { raw = await context.request.json(); }
  catch { return errorResponse("Invalid JSON body", 400); }
  const parsed = validate(cueSourceInputSchema, raw);
  if (!parsed.ok) return parsed.response;
  if (projectId && parsed.data.projectId && parsed.data.projectId !== projectId) {
    return errorResponse("The requested resource was not found", 404);
  }

  const existing = await db.prepare(
    `SELECT source.environment, source.project_id,
            EXISTS(SELECT 1 FROM cue_source_keys key
                    WHERE key.source_id = source.id AND key.last_used_at IS NOT NULL) AS has_events
       FROM cue_sources source
      WHERE source.id = ? AND source.org_id = ?${projectId ? " AND source.project_id = ?" : ""} AND source.owner_id = ?`,
  ).bind(...(projectId
    ? [context.params.id, orgId, projectId, orgLogin]
    : [context.params.id, orgId, orgLogin])).first<{ environment: string; project_id: string; has_events: number }>();
  if (!existing) return errorResponse("Cue source not found", 404);
  const targetProjectId = projectId || parsed.data.projectId || existing.project_id;
  if (targetProjectId !== existing.project_id) {
    const target = await db.prepare(
      `SELECT project.id FROM projects project
        JOIN project_routing_settings routing
          ON routing.org_id = ? AND routing.project_id = project.id AND routing.enabled = 1
       WHERE project.id = ? AND project.org_id = ? AND COALESCE(project.archived, 0) = 0`,
    ).bind(orgId, targetProjectId, orgId).first();
    if (!target) return errorResponse("Active project not found in this organization", 404);
  }
  if (existing.has_events === 1 && parsed.data.environment !== existing.environment) {
    return errorResponse("Environment cannot change after this source receives events. Create a separate source for the other environment.", 409);
  }

  let slackConnectionId: string | null = null;
  try {
    slackConnectionId = await validateProjectSlackDestination({ ...context.env, DB: db }, orgId, targetProjectId, {
      connectionId: parsed.data.slackConnectionId,
      channelId: parsed.data.slackChannelId,
    });
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "Slack channel is unavailable", 409);
  }
  const result = await db.prepare(
    `UPDATE cue_sources SET name = ?, environment = ?, project_id = ?, enabled = ?, alerts_enabled = ?,
       timezone = ?, digest_enabled = ?, digest_time_local = ?, allowed_origins_json = ?, slack_channel_id = ?,
       slack_connection_id = ?,
       updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
     WHERE id = ? AND org_id = ? AND project_id = ? AND owner_id = ?`,
  ).bind(
    parsed.data.name, parsed.data.environment, targetProjectId, parsed.data.enabled ? 1 : 0,
    parsed.data.alertsEnabled ? 1 : 0,
    parsed.data.timezone,
    parsed.data.digestEnabled ? 1 : 0, parsed.data.digestTimeLocal, JSON.stringify(parsed.data.allowedOrigins),
    parsed.data.slackChannelId, slackConnectionId, context.params.id, orgId, existing.project_id, orgLogin,
  ).run();
  if (!result.meta.changes) return errorResponse("Cue source not found", 404);
  await db.prepare(
    `INSERT INTO cue_endpoint_monitors (org_id, source_id, enabled, url, updated_at)
     VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
     ON CONFLICT(source_id) DO UPDATE SET
       status = CASE WHEN excluded.url IS NOT cue_endpoint_monitors.url
         OR excluded.enabled IS NOT cue_endpoint_monitors.enabled THEN 'waiting' ELSE cue_endpoint_monitors.status END,
       consecutive_failures = CASE WHEN excluded.url IS NOT cue_endpoint_monitors.url
         OR excluded.enabled IS NOT cue_endpoint_monitors.enabled THEN 0 ELSE cue_endpoint_monitors.consecutive_failures END,
       consecutive_successes = CASE WHEN excluded.url IS NOT cue_endpoint_monitors.url
         OR excluded.enabled IS NOT cue_endpoint_monitors.enabled THEN 0 ELSE cue_endpoint_monitors.consecutive_successes END,
       incident_started_at = CASE WHEN excluded.url IS NOT cue_endpoint_monitors.url
         OR excluded.enabled IS NOT cue_endpoint_monitors.enabled THEN NULL ELSE cue_endpoint_monitors.incident_started_at END,
       last_error = CASE WHEN excluded.url IS NOT cue_endpoint_monitors.url THEN NULL ELSE cue_endpoint_monitors.last_error END,
       last_status_code = CASE WHEN excluded.url IS NOT cue_endpoint_monitors.url THEN NULL ELSE cue_endpoint_monitors.last_status_code END,
       last_latency_ms = CASE WHEN excluded.url IS NOT cue_endpoint_monitors.url THEN NULL ELSE cue_endpoint_monitors.last_latency_ms END,
       enabled = excluded.enabled, url = excluded.url, updated_at = excluded.updated_at`,
  ).bind(orgId, context.params.id, parsed.data.healthEnabled ? 1 : 0, parsed.data.healthUrl).run();
  return jsonResponse({ ok: true });
}

export async function onRequestDelete(context: Ctx): Promise<Response> {
  const { orgId, projectId, orgLogin, isAdmin } = getCtx(context) as Ctx["data"];
  if (!orgId) return errorResponse("Missing org context", 400);
  if (!isAdmin) return errorResponse("Admin required", 403);
  const result = await getNoxDb(context.env).prepare(
    `DELETE FROM cue_sources
      WHERE id = ? AND org_id = ?${projectId ? " AND project_id = ?" : ""} AND owner_id = ?`,
  ).bind(...(projectId
    ? [context.params.id, orgId, projectId, orgLogin]
    : [context.params.id, orgId, orgLogin])).run();
  if (!result.meta.changes) return errorResponse("Cue source not found", 404);
  return jsonResponse({ ok: true });
}
