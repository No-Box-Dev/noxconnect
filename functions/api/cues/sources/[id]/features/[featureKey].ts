import { z } from "zod";
import { getCtx, errorResponse, jsonResponse } from "../../../../../lib/db";
import { getNoxDb, type NoxDatabaseEnv } from "../../../../../lib/nox-db";
import { findCueFeatureScope, loadCueFeatureCatalog } from "../../../../../lib/noxcue-feature-catalog";
import { validate } from "../../../../../lib/validate";

const FEATURE_KEY = /^custom\.[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){0,4}$/;
const UpdateSchema = z.object({
  label: z.string().trim().min(1).max(80),
  failureMessage: z.string().trim().min(1).max(500),
  enabled: z.boolean(),
}).strict();

interface Ctx {
  env: NoxDatabaseEnv;
  data: { orgId: number; orgLogin: string; projectId?: string | null; isAdmin: boolean };
  params: { id: string; featureKey: string };
  request: Request;
}

async function featureContext(context: Ctx) {
  const { orgId, orgLogin, projectId } = getCtx(context) as Ctx["data"];
  const scope = await findCueFeatureScope(getNoxDb(context.env), orgId, orgLogin, context.params.id, projectId);
  return { orgId, scope, key: context.params.featureKey };
}

function scopeValues(scope: NonNullable<Awaited<ReturnType<typeof featureContext>>["scope"]>) {
  return [scope.projectId, scope.projectId, scope.projectId, scope.sourceId] as const;
}

const SCOPE_WHERE = `org_id = ? AND feature_key = ?
  AND ((? IS NOT NULL AND project_id = ?)
    OR (? IS NULL AND source_id = ?))`;

export async function onRequestPut(context: Ctx): Promise<Response> {
  const { isAdmin } = getCtx(context) as Ctx["data"];
  if (!isAdmin) return errorResponse("Admin required", 403);
  const { orgId, scope, key } = await featureContext(context);
  if (!orgId) return errorResponse("Missing org context", 400);
  if (!scope) return errorResponse("Cue source not found", 404);
  if (!FEATURE_KEY.test(key)) return errorResponse("Invalid custom feature key", 400);
  let raw: unknown;
  try { raw = await context.request.json(); }
  catch { return errorResponse("Invalid JSON body", 400); }
  const parsed = validate(UpdateSchema, raw);
  if (!parsed.ok) return parsed.response;
  const db = getNoxDb(context.env);
  const result = await db.prepare(
    `UPDATE cue_custom_features
        SET label = ?, failure_message = ?, enabled = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      WHERE ${SCOPE_WHERE}`,
  ).bind(parsed.data.label, parsed.data.failureMessage, parsed.data.enabled ? 1 : 0,
    orgId, key, ...scopeValues(scope)).run();
  if (!result.meta.changes) return errorResponse("Custom feature not found", 404);
  return jsonResponse(await loadCueFeatureCatalog(db, orgId, scope));
}

export async function onRequestDelete(context: Ctx): Promise<Response> {
  const { isAdmin } = getCtx(context) as Ctx["data"];
  if (!isAdmin) return errorResponse("Admin required", 403);
  const { orgId, scope, key } = await featureContext(context);
  if (!orgId) return errorResponse("Missing org context", 400);
  if (!scope) return errorResponse("Cue source not found", 404);
  if (!FEATURE_KEY.test(key)) return errorResponse("Invalid custom feature key", 400);
  const db = getNoxDb(context.env);
  const result = await db.prepare(`DELETE FROM cue_custom_features WHERE ${SCOPE_WHERE}`)
    .bind(orgId, key, ...scopeValues(scope)).run();
  if (!result.meta.changes) return errorResponse("Custom feature not found", 404);
  return jsonResponse(await loadCueFeatureCatalog(db, orgId, scope));
}
