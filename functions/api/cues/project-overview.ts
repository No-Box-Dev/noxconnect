import { getCtx, jsonResponse, errorResponse } from "../../lib/db";

interface Ctx {
  env: { DB: D1Database };
  data: { orgId: number; projectId?: string | null };
}

export async function onRequestGet(context: Ctx): Promise<Response> {
  const { orgId, projectId } = getCtx(context) as Ctx["data"];
  const project = projectId ? await context.env.DB.prepare(
    `SELECT id, name FROM projects
      WHERE id = ? AND org_id = ? AND COALESCE(archived, 0) = 0`,
  ).bind(projectId, orgId).first<{ id: string; name: string }>() : null;
  if (projectId && !project) return errorResponse("Project not found", 404);
  const sourceScope = projectId ? " AND project_id = ?" : "";
  const joinedSourceScope = projectId ? " AND source.project_id = ?" : "";
  const scopeBinds = projectId ? [orgId, projectId] : [orgId];
  const [sources, metrics, errors] = await context.env.DB.batch([
    context.env.DB.prepare(
      `SELECT id, name, environment, last_registration_at, last_activity_at
         FROM cue_sources
        WHERE org_id = ?${sourceScope} AND enabled = 1
        ORDER BY name`,
    ).bind(...scopeBinds),
    context.env.DB.prepare(
      `SELECT metric.source_id, source.name AS source_name, metric.period,
              metric.metric_key, metric.value, metric.origin
         FROM cue_daily_metrics metric
         JOIN cue_sources source ON source.id = metric.source_id
        WHERE source.org_id = ?${joinedSourceScope}
          AND metric.period >= date('now', '-13 days')
        ORDER BY metric.period DESC, source.name, metric.metric_key`,
    ).bind(...scopeBinds),
    context.env.DB.prepare(
      `SELECT error.source_id, source.name AS source_name, error.fingerprint,
              error.title, error.environment, error.last_seen_at, error.occurrence_count
         FROM cue_error_groups error
         JOIN cue_sources source ON source.id = error.source_id
        WHERE source.org_id = ?${joinedSourceScope} AND COALESCE(error.status, 'open') != 'resolved'
        ORDER BY error.last_seen_at DESC LIMIT 50`,
    ).bind(...scopeBinds),
  ]);
  return jsonResponse({ project, sources: sources.results ?? [], metrics: metrics.results ?? [], errors: errors.results ?? [] });
}
