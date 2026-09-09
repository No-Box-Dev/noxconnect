import { z } from "zod";
import { getCtx, errorResponse, jsonResponse } from "../../../../../lib/db";
import { getNoxDb, type NoxDatabaseEnv } from "../../../../../lib/nox-db";
import { loadCueCustomMetrics } from "../../../../../lib/noxcue-custom-metrics";
import { findCueFeatureScope } from "../../../../../lib/noxcue-feature-catalog";
import { validate } from "../../../../../lib/validate";
import { canReadProjectResource } from "../../../../../lib/api-auth.js";

const METRIC_KEY = /^custom\.[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){0,4}$/;
const CreateSchema = z.object({
  key: z.string().trim().min(8).max(120).regex(METRIC_KEY, "Use a custom.* lowercase dot-separated key"),
  label: z.string().trim().min(1).max(80),
}).strict();

interface Ctx {
  env: NoxDatabaseEnv;
  data: { orgId: number; orgLogin: string; userLogin: string; isAdmin: boolean; auth?: { type?: string } };
  params: { id: string };
  request: Request;
}

async function getScope(context: Ctx) {
  const { orgId, orgLogin } = getCtx(context) as Ctx["data"];
  return findCueFeatureScope(getNoxDb(context.env), orgId, orgLogin, context.params.id);
}

export async function onRequestGet(context: Ctx): Promise<Response> {
  const { orgId } = getCtx(context) as Ctx["data"];
  if (!orgId) return errorResponse("Missing org context", 400);
  if (!canReadProjectResource(context.data)) return errorResponse("Admin required", 403);
  const scope = await getScope(context);
  if (!scope) return errorResponse("Cue source not found", 404);
  return jsonResponse(await loadCueCustomMetrics(getNoxDb(context.env), orgId, scope));
}

export async function onRequestPost(context: Ctx): Promise<Response> {
  const { orgId, userLogin, isAdmin } = getCtx(context) as Ctx["data"];
  if (!orgId) return errorResponse("Missing org context", 400);
  if (!isAdmin) return errorResponse("Admin required", 403);
  const scope = await getScope(context);
  if (!scope) return errorResponse("Cue source not found", 404);
  let raw: unknown;
  try { raw = await context.request.json(); } catch { return errorResponse("Invalid JSON body", 400); }
  const parsed = validate(CreateSchema, raw);
  if (!parsed.ok) return parsed.response;
  const db = getNoxDb(context.env);
  try {
    await db.prepare(
      `INSERT INTO cue_custom_metrics
         (id, org_id, project_id, source_id, metric_key, label, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(crypto.randomUUID(), orgId, scope.projectId, scope.projectId ? null : scope.sourceId,
      parsed.data.key, parsed.data.label, userLogin).run();
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
      return errorResponse(`That custom metric is already registered for this ${scope.projectId ? "project" : "source"}`, 409);
    }
    throw error;
  }
  return jsonResponse(await loadCueCustomMetrics(db, orgId, scope), 201);
}
