import { z } from "zod";
import { errorResponse, getCtx, jsonResponse } from "../../../../lib/db";
import { validate } from "../../../../lib/validate";

const BodySchema = z.object({
  status: z.enum(["open", "acknowledged", "resolved"]),
}).strict();

interface Ctx {
  env: { DB: D1Database };
  data: { orgId: number; userLogin: string; isAdmin: boolean };
  params: { sourceId: string; fingerprint: string };
  request: Request;
}

export async function onRequestPut(context: Ctx): Promise<Response> {
  const { orgId, userLogin, isAdmin } = getCtx(context) as Ctx["data"];
  if (!orgId) return errorResponse("Missing org context", 400);
  if (!isAdmin) return errorResponse("Admin required", 403);

  let raw: unknown;
  try { raw = await context.request.json(); }
  catch { return errorResponse("Invalid JSON body", 400); }
  const parsed = validate(BodySchema, raw);
  if (!parsed.ok) return parsed.response;

  const now = new Date().toISOString();
  const result = await context.env.DB.prepare(
    `UPDATE cue_error_groups
        SET status = ?,
            acknowledged_at = CASE WHEN ? = 'acknowledged' THEN ? ELSE NULL END,
            acknowledged_by = CASE WHEN ? = 'acknowledged' THEN ? ELSE NULL END,
            resolved_at = CASE WHEN ? = 'resolved' THEN ? ELSE NULL END,
            resolved_by = CASE WHEN ? = 'resolved' THEN ? ELSE NULL END
      WHERE source_id = ? AND fingerprint = ? AND org_id = ?
        AND EXISTS (SELECT 1 FROM cue_sources source
          WHERE source.id = cue_error_groups.source_id AND source.org_id = ?)`,
  ).bind(
    parsed.data.status,
    parsed.data.status, now,
    parsed.data.status, userLogin,
    parsed.data.status, now,
    parsed.data.status, userLogin,
    context.params.sourceId, context.params.fingerprint, orgId, orgId,
  ).run();
  if (!result.meta.changes) return errorResponse("NoxCue error incident not found", 404);
  return jsonResponse({ status: parsed.data.status, updatedAt: now });
}
