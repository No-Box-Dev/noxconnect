import { getCtx, errorResponse, jsonResponse } from "../../lib/db";
import { getNoxDb, type NoxDatabaseEnv } from "../../lib/nox-db";
import { findCueFeatureScope, loadCueFeatureCatalog } from "../../lib/noxcue-feature-catalog";

interface Ctx {
  env: NoxDatabaseEnv;
  data: { orgId: number; orgLogin: string; projectId?: string | null; isAdmin: boolean };
  request: Request;
}

export async function onRequestGet(context: Ctx): Promise<Response> {
  const { orgId, orgLogin, projectId, isAdmin } = getCtx(context) as Ctx["data"];
  if (!orgId) return errorResponse("Missing org context", 400);
  if (!isAdmin) return errorResponse("Admin required", 403);
  const sourceId = new URL(context.request.url).searchParams.get("sourceId")?.trim();
  if (!sourceId) return errorResponse("sourceId is required", 400);
  const db = getNoxDb(context.env);
  const scope = await findCueFeatureScope(db, orgId, orgLogin, sourceId, projectId);
  if (!scope) return errorResponse("Cue source not found", 404);
  return jsonResponse(await loadCueFeatureCatalog(db, orgId, scope));
}
