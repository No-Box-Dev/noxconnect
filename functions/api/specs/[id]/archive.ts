import { getCtx, jsonResponse, errorResponse } from "../../../lib/db";
import { callNoxTicket, type NoxTicketEnvironment } from "../../../lib/noxticket-service";

interface Env extends NoxTicketEnvironment {
  DB: D1Database;
}

interface Ctx {
  env: Env;
  data: { orgId: number; userLogin: string; isAdmin: boolean };
  request: Request;
  params: { id: string };
}

// POST   /api/specs/:id/archive  → archive spec.
// DELETE /api/specs/:id/archive  → unarchive spec.
// Admin-gated. Soft delete only — the row stays so admins can restore later.

export async function onRequestPost(context: Ctx): Promise<Response> {
  return setArchived(context, true);
}

export async function onRequestDelete(context: Ctx): Promise<Response> {
  return setArchived(context, false);
}

async function setArchived(context: Ctx, archive: boolean): Promise<Response> {
  const { orgId, isAdmin } = getCtx(context) as { orgId: number; isAdmin: boolean };
  if (!orgId) return errorResponse("Missing org context", 400);
  if (!isAdmin) return errorResponse("Admin required", 403);

  const id = Number.parseInt(context.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) return errorResponse("Invalid spec id", 400);

  const delegated = await callNoxTicket(context.env, (service) => service.setSpecArchived(
    { orgId, userLogin: context.data.userLogin, isAdmin },
    id,
    archive,
  ));
  if (delegated) return delegated;

  const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const targetFlag = archive ? 1 : 0;
  const targetAt = archive ? nowIso : null;
  const currentFlag = archive ? 0 : 1;

  const res = await context.env.DB.prepare(
    `UPDATE specs
        SET archived = ?, archived_at = ?,
            is_primary = 0,
            updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      WHERE id = ? AND org_id = ? AND archived = ?`,
  )
    .bind(targetFlag, targetAt, id, orgId, currentFlag)
    .run();

  const changes = res.meta?.changes ?? 0;
  if (!changes) {
    return errorResponse(
      `Unknown spec ${id} (or already ${archive ? "archived" : "active"})`,
      404,
    );
  }

  return jsonResponse({ ok: true, id, archived: archive });
}
