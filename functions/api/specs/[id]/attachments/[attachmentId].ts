import { getCtx, jsonResponse, errorResponse } from "../../../../lib/db";
import type { SpecAttachmentRow } from "../../../../lib/spec-attachments";
import { callNoxTicket, type NoxTicketEnvironment } from "../../../../lib/noxticket-service";

interface Env extends NoxTicketEnvironment {
  DB: D1Database;
  SPEC_ATTACHMENTS?: R2Bucket;
}

interface Ctx {
  env: Env;
  data: { orgId: number; userLogin: string };
  request: Request;
  params: { id: string; attachmentId: string };
}

function parseIds(context: Ctx): { specId: number; attachmentId: number } | null {
  const specId = Number.parseInt(context.params.id, 10);
  const attachmentId = Number.parseInt(context.params.attachmentId, 10);
  if (!Number.isFinite(specId) || specId <= 0) return null;
  if (!Number.isFinite(attachmentId) || attachmentId <= 0) return null;
  return { specId, attachmentId };
}

// GET /api/specs/:id/attachments/:attachmentId
// Streams the file bytes back with the stored Content-Type. HTML gets a
// strict Content-Security-Policy header so a hostile upload can't turn
// into an XSS pivot — no scripts, no plugins, no forms. Same-origin
// image/style loads are still allowed so a mostly-static spec renders
// as intended.
//
// `?disposition=attachment` forces a download prompt; default is inline
// so the client-side viewer modal can iframe/embed the file.
export async function onRequestGet(context: Ctx): Promise<Response> {
  const { orgId } = getCtx(context) as { orgId: number };
  if (!orgId) return errorResponse("Missing org context", 400);
  const ids = parseIds(context);
  if (!ids) return errorResponse("Invalid ids", 400);

  if (context.env.NOXTICKET_SERVICE) {
    try {
      const response = await context.env.NOXTICKET_SERVICE.getAttachment(
        { orgId, userLogin: context.data.userLogin },
        ids.specId,
        ids.attachmentId,
      );
      const disposition = new URL(context.request.url).searchParams.get("disposition") === "attachment";
      if (!disposition) return response;
      const headers = new Headers(response.headers);
      const current = headers.get("Content-Disposition") ?? "attachment";
      headers.set("Content-Disposition", current.replace(/^inline/, "attachment"));
      return new Response(response.body, { status: response.status, headers });
    } catch (error) {
      console.error(JSON.stringify({ event: "noxticket_service_unavailable", error: error instanceof Error ? error.message : String(error) }));
      return Response.json({ error: "NoxTicket is temporarily unavailable", code: "service_unavailable", service: "noxticket" }, { status: 503 });
    }
  }

  if (!context.env.SPEC_ATTACHMENTS) {
    return errorResponse("Attachment storage not provisioned", 503);
  }

  const row = await context.env.DB.prepare(
    `SELECT id, org_id, spec_id, filename, content_type, size, r2_key,
            uploaded_by, uploaded_at
       FROM spec_attachments
      WHERE id = ? AND spec_id = ? AND org_id = ?`,
  )
    .bind(ids.attachmentId, ids.specId, orgId)
    .first<SpecAttachmentRow>();
  if (!row) return errorResponse("Attachment not found", 404);

  const obj = await context.env.SPEC_ATTACHMENTS.get(row.r2_key);
  if (!obj) return errorResponse("Attachment object missing in storage", 404);

  const url = new URL(context.request.url);
  const disposition = url.searchParams.get("disposition") === "attachment"
    ? `attachment; filename="${encodeURIComponent(row.filename)}"`
    : `inline; filename="${encodeURIComponent(row.filename)}"`;

  const headers = new Headers({
    "Content-Type": row.content_type,
    "Content-Length": String(row.size),
    "Content-Disposition": disposition,
    // Attachment content is user-supplied and lives on the same origin
    // as the app; the strict CSP keeps HTML uploads from executing JS,
    // opening popups, or embedding same-origin iframes back into the app.
    "Content-Security-Policy":
      "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none';",
    "X-Content-Type-Options": "nosniff",
  });

  return new Response(obj.body, { headers });
}

// DELETE /api/specs/:id/attachments/:attachmentId
// Removes both the R2 object and the D1 row. Any authenticated org member
// can delete; a more granular ACL can be added later if needed.
export async function onRequestDelete(context: Ctx): Promise<Response> {
  const { orgId } = getCtx(context) as { orgId: number };
  if (!orgId) return errorResponse("Missing org context", 400);
  const ids = parseIds(context);
  if (!ids) return errorResponse("Invalid ids", 400);

  const delegated = await callNoxTicket(context.env, (service) => service.deleteAttachment(
    { orgId, userLogin: context.data.userLogin },
    ids.specId,
    ids.attachmentId,
  ));
  if (delegated) return delegated;

  const row = await context.env.DB.prepare(
    "SELECT id, r2_key FROM spec_attachments WHERE id = ? AND spec_id = ? AND org_id = ?",
  )
    .bind(ids.attachmentId, ids.specId, orgId)
    .first<{ id: number; r2_key: string }>();
  if (!row) return errorResponse("Attachment not found", 404);

  // Delete R2 first; if it fails we keep the row so the object stays
  // reachable (a re-run of DELETE will retry). If R2 succeeded but D1
  // fails, the next list() returns a stale row pointing at nothing —
  // rare, and the download endpoint 404s cleanly.
  if (context.env.SPEC_ATTACHMENTS) {
    try {
      await context.env.SPEC_ATTACHMENTS.delete(row.r2_key);
    } catch (err) {
      console.error("[spec-attachments] R2 delete failed", {
        attachmentId: row.id,
        msg: (err as Error)?.message,
      });
      return errorResponse("Failed to delete attachment from storage", 500);
    }
  }

  await context.env.DB.prepare("DELETE FROM spec_attachments WHERE id = ?")
    .bind(row.id)
    .run();

  return jsonResponse({ ok: true, id: row.id });
}
