import { getCtx, jsonResponse, errorResponse } from "../../../../lib/db";
import {
  buildR2Key,
  contentTypeFromFilename,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_SPEC,
  rowToDto,
  sanitizeFilename,
  type SpecAttachmentRow,
} from "../../../../lib/spec-attachments";
import { callNoxTicket, type NoxTicketEnvironment } from "../../../../lib/noxticket-service";

interface Env extends NoxTicketEnvironment {
  DB: D1Database;
  SPEC_ATTACHMENTS?: R2Bucket;
}

interface Ctx {
  env: Env;
  data: { orgId: number; userLogin: string };
  request: Request;
  params: { id: string };
}

// GET /api/specs/:id/attachments — list attachments for a spec.
// (The spec DTO also inlines this list, so this endpoint is mostly for
// manual refetch after upload/delete when a full spec refetch is
// overkill.)
export async function onRequestGet(context: Ctx): Promise<Response> {
  const { orgId } = getCtx(context) as { orgId: number };
  if (!orgId) return errorResponse("Missing org context", 400);

  const specId = Number.parseInt(context.params.id, 10);
  if (!Number.isFinite(specId) || specId <= 0) return errorResponse("Invalid spec id", 400);

  const delegated = await callNoxTicket(context.env, (service) => service.listAttachments(
    { orgId, userLogin: context.data.userLogin },
    specId,
  ));
  if (delegated) return delegated;

  const { results } = await context.env.DB.prepare(
    `SELECT id, org_id, spec_id, filename, content_type, size, r2_key,
            uploaded_by, uploaded_at
       FROM spec_attachments
      WHERE org_id = ? AND spec_id = ?
      ORDER BY uploaded_at DESC`,
  )
    .bind(orgId, specId)
    .all<SpecAttachmentRow>();

  return jsonResponse({ attachments: (results ?? []).map(rowToDto) });
}

// POST /api/specs/:id/attachments — upload one file via multipart/form-data.
// Field name: `file`. Server enforces the extension allowlist, size cap,
// and a per-spec attachment count so a stray script can't fill R2.
export async function onRequestPost(context: Ctx): Promise<Response> {
  const { orgId, userLogin } = getCtx(context) as { orgId: number; userLogin: string };
  if (!orgId) return errorResponse("Missing org context", 400);
  if (!userLogin) return errorResponse("Missing user context", 400);

  const specId = Number.parseInt(context.params.id, 10);
  if (!Number.isFinite(specId) || specId <= 0) return errorResponse("Invalid spec id", 400);

  let form: FormData;
  try {
    form = await context.request.formData();
  } catch {
    return errorResponse("Expected multipart/form-data body", 400);
  }

  // FormDataEntryValue is `string | File` but the Workers types don't
  // declare a File shape — sniff for the fields we need instead.
  const file = form.get("file") as unknown as
    | { name: string; size: number; stream: () => ReadableStream }
    | null;
  if (!file || typeof file !== "object" || typeof file.name !== "string" || typeof file.stream !== "function") {
    return errorResponse("Missing `file` field", 400);
  }

  const filename = sanitizeFilename(file.name);
  if (!filename) {
    return errorResponse(
      "Unsupported filename. Allowed extensions: .md, .pdf, .docx, .html",
      415,
    );
  }
  if (file.size <= 0) return errorResponse("File is empty", 400);
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return errorResponse(
      `File too large — max ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB per attachment`,
      413,
    );
  }

  const delegated = await callNoxTicket(context.env, async (service) => service.putAttachment(
    { orgId, userLogin },
    specId,
    filename,
    await new Response(file.stream()).arrayBuffer(),
  ));
  if (delegated) return delegated;

  if (!context.env.SPEC_ATTACHMENTS) {
    return errorResponse(
      "Nox attachment storage is not provisioned for this deployment.",
      503,
    );
  }

  const spec = await context.env.DB.prepare(
    "SELECT id FROM specs WHERE id = ? AND org_id = ?",
  ).bind(specId, orgId).first<{ id: number }>();
  if (!spec) return errorResponse(`Unknown spec ${specId}`, 404);

  const countRow = await context.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM spec_attachments WHERE org_id = ? AND spec_id = ?",
  ).bind(orgId, specId).first<{ n: number }>();
  if ((countRow?.n ?? 0) >= MAX_ATTACHMENTS_PER_SPEC) {
    return errorResponse(`Spec already has ${MAX_ATTACHMENTS_PER_SPEC} attachments (the cap)`, 409);
  }

  // Two-phase: insert D1 row first so we get an id, then write to R2
  // with a key derived from that id. If the R2 write fails we roll back
  // the D1 row so an orphan row never surfaces in list()/download().
  const inserted = await context.env.DB.prepare(
    `INSERT INTO spec_attachments (org_id, spec_id, filename, content_type, size, r2_key, uploaded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     RETURNING id, org_id, spec_id, filename, content_type, size, r2_key, uploaded_by, uploaded_at`,
  )
    .bind(
      orgId,
      specId,
      filename,
      contentTypeFromFilename(filename),
      file.size,
      // Placeholder; we UPDATE below once we have the real id (which is
      // also part of the key). Cheaper than a second SELECT.
      `pending/${orgId}/${specId}/${crypto.randomUUID()}`,
      userLogin,
    )
    .first<SpecAttachmentRow>();

  if (!inserted) return errorResponse("Failed to record attachment", 500);

  const r2Key = buildR2Key(orgId, specId, inserted.id);

  try {
    await context.env.SPEC_ATTACHMENTS.put(r2Key, file.stream(), {
      httpMetadata: {
        contentType: contentTypeFromFilename(filename),
      },
    });
  } catch (err) {
    console.error("[spec-attachments] R2 put failed", {
      attachmentId: inserted.id,
      msg: (err as Error)?.message,
    });
    await context.env.DB.prepare("DELETE FROM spec_attachments WHERE id = ?")
      .bind(inserted.id)
      .run();
    return errorResponse("Failed to store attachment", 500);
  }

  // Backfill the real r2_key now that the file lives in R2.
  await context.env.DB.prepare(
    "UPDATE spec_attachments SET r2_key = ? WHERE id = ?",
  )
    .bind(r2Key, inserted.id)
    .run();

  return jsonResponse(
    rowToDto({ ...inserted, r2_key: r2Key }),
    201,
  );
}
