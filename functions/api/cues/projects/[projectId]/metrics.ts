import { z } from "zod";
import { getCtx, errorResponse, jsonResponse } from "../../../../lib/db";
import { getNoxDb, type NoxDatabaseEnv } from "../../../../lib/nox-db";
import {
  NOXCUE_USER_METRIC_KEYS,
  loadNoxCueProjectMetrics,
  saveNoxCueProjectMetrics,
} from "../../../../lib/noxcue-project-metrics.js";
import { validate } from "../../../../lib/validate";
import { canReadProjectResource } from "../../../../lib/api-auth.js";

const MetricKeySchema = z.enum(NOXCUE_USER_METRIC_KEYS);
const UpdateSchema = z.object({
  enabledMetricKeys: z.array(MetricKeySchema).min(1).max(NOXCUE_USER_METRIC_KEYS.length),
}).strict().refine(
  ({ enabledMetricKeys }) => new Set(enabledMetricKeys).size === enabledMetricKeys.length,
  { message: "Metric keys must be unique", path: ["enabledMetricKeys"] },
);

interface Ctx {
  env: NoxDatabaseEnv;
  data: { orgId: number; orgLogin: string; userLogin: string; isAdmin: boolean; auth?: { type?: string } };
  params: { projectId: string };
  request: Request;
}

async function findProject(context: Ctx) {
  const { orgId, orgLogin } = getCtx(context) as Ctx["data"];
  return getNoxDb(context.env).prepare(
    `SELECT project.id, project.name
       FROM projects project
       JOIN orgs org ON lower(org.github_login) = lower(project.owner_id)
       JOIN project_routing_settings routing
         ON routing.project_id = project.id AND routing.org_id = org.id
      WHERE project.id = ? AND project.owner_id = ? AND org.id = ?
        AND routing.enabled = 1 AND COALESCE(project.archived, 0) = 0`,
  ).bind(context.params.projectId, orgLogin, orgId).first<{ id: string; name: string }>();
}

export async function onRequestGet(context: Ctx): Promise<Response> {
  const { orgId } = getCtx(context) as Ctx["data"];
  if (!orgId) return errorResponse("Missing org context", 400);
  if (!canReadProjectResource(context.data)) return errorResponse("Admin required", 403);
  const project = await findProject(context);
  if (!project) return errorResponse("Active project not found", 404);
  const state = await loadNoxCueProjectMetrics(getNoxDb(context.env), orgId, project.id);
  return jsonResponse({ project, ...state });
}

export async function onRequestPut(context: Ctx): Promise<Response> {
  const { orgId, userLogin, isAdmin } = getCtx(context) as Ctx["data"];
  if (!orgId) return errorResponse("Missing org context", 400);
  if (!isAdmin) return errorResponse("Admin required", 403);
  const project = await findProject(context);
  if (!project) return errorResponse("Active project not found", 404);
  let raw: unknown;
  try { raw = await context.request.json(); }
  catch { return errorResponse("Invalid JSON body", 400); }
  const parsed = validate(UpdateSchema, raw);
  if (!parsed.ok) return parsed.response;
  await saveNoxCueProjectMetrics(
    getNoxDb(context.env),
    orgId,
    project.id,
    parsed.data.enabledMetricKeys,
    userLogin,
  );
  const state = await loadNoxCueProjectMetrics(getNoxDb(context.env), orgId, project.id);
  return jsonResponse({ project, ...state });
}
