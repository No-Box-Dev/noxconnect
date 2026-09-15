import { getCtx, errorResponse, jsonResponse } from "../../../../../lib/db";
import { getNoxDb, type NoxDatabaseEnv } from "../../../../../lib/nox-db";

interface Ctx {
  env: NoxDatabaseEnv;
  data: { orgId: number; projectId?: string | null; isAdmin: boolean };
  params: { id: string; keyId: string };
}

export async function onRequestDelete(context: Ctx): Promise<Response> {
  const { orgId, projectId, isAdmin } = getCtx(context) as Ctx["data"];
  if (!orgId) return errorResponse("Missing org context", 400);
  if (!isAdmin) return errorResponse("Admin required", 403);
  const result = await getNoxDb(context.env).prepare(
    `UPDATE cue_source_keys
        SET revoked_at = COALESCE(revoked_at, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      WHERE id = ? AND source_id = ? AND org_id = ?
        ${projectId ? "AND EXISTS (SELECT 1 FROM cue_sources source WHERE source.id = cue_source_keys.source_id AND source.project_id = ?)" : ""}`,
  ).bind(...(projectId
    ? [context.params.keyId, context.params.id, orgId, projectId]
    : [context.params.keyId, context.params.id, orgId])).run();
  if (!result.meta.changes) return errorResponse("Ingest key not found", 404);
  return jsonResponse({ ok: true });
}
