import { z } from "zod";
import { getCtx, errorResponse, jsonResponse } from "../../../../../lib/db";
import { getNoxDb, type NoxDatabaseEnv } from "../../../../../lib/nox-db";
import { loadCueCustomMetrics } from "../../../../../lib/noxcue-custom-metrics";
import { findCueFeatureScope } from "../../../../../lib/noxcue-feature-catalog";
import { validate } from "../../../../../lib/validate";

const METRIC_KEY = /^custom\.[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){0,4}$/;
const UpdateSchema = z.object({ label: z.string().trim().min(1).max(80), enabled: z.boolean() }).strict();
const SCOPE_WHERE = `org_id = ? AND metric_key = ? AND ((? IS NOT NULL AND project_id = ?) OR (? IS NULL AND source_id = ?))`;

interface Ctx {
  env: NoxDatabaseEnv;
  data: { orgId: number; orgLogin: string; projectId?: string | null; isAdmin: boolean };
  params: { id: string; metricKey: string };
  request: Request;
}

async function metricContext(context: Ctx) {
  const { orgId, orgLogin, projectId } = getCtx(context) as Ctx["data"];
  const scope = await findCueFeatureScope(getNoxDb(context.env), orgId, orgLogin, context.params.id, projectId);
  return { orgId, scope, key: context.params.metricKey };
}

function scopeValues(scope: NonNullable<Awaited<ReturnType<typeof metricContext>>["scope"]>) {
  return [scope.projectId, scope.projectId, scope.projectId, scope.sourceId] as const;
}

export async function onRequestPut(context: Ctx): Promise<Response> {
  const { isAdmin } = getCtx(context) as Ctx["data"];
  if (!isAdmin) return errorResponse("Admin required", 403);
  const { orgId, scope, key } = await metricContext(context);
  if (!orgId) return errorResponse("Missing org context", 400);
  if (!scope) return errorResponse("Cue source not found", 404);
  if (!METRIC_KEY.test(key)) return errorResponse("Invalid custom metric key", 400);
  let raw: unknown;
  try { raw = await context.request.json(); } catch { return errorResponse("Invalid JSON body", 400); }
  const parsed = validate(UpdateSchema, raw);
  if (!parsed.ok) return parsed.response;
  const db = getNoxDb(context.env);
  const result = await db.prepare(
    `UPDATE cue_custom_metrics SET label = ?, enabled = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE ${SCOPE_WHERE}`,
  ).bind(parsed.data.label, parsed.data.enabled ? 1 : 0, orgId, key, ...scopeValues(scope)).run();
  if (!result.meta.changes) return errorResponse("Custom metric not found", 404);
  return jsonResponse(await loadCueCustomMetrics(db, orgId, scope));
}

export async function onRequestDelete(context: Ctx): Promise<Response> {
  const { isAdmin } = getCtx(context) as Ctx["data"];
  if (!isAdmin) return errorResponse("Admin required", 403);
  const { orgId, scope, key } = await metricContext(context);
  if (!orgId) return errorResponse("Missing org context", 400);
  if (!scope) return errorResponse("Cue source not found", 404);
  if (!METRIC_KEY.test(key)) return errorResponse("Invalid custom metric key", 400);
  const db = getNoxDb(context.env);
  const result = await db.prepare(`DELETE FROM cue_custom_metrics WHERE ${SCOPE_WHERE}`)
    .bind(orgId, key, ...scopeValues(scope)).run();
  if (!result.meta.changes) return errorResponse("Custom metric not found", 404);
  return jsonResponse(await loadCueCustomMetrics(db, orgId, scope));
}
