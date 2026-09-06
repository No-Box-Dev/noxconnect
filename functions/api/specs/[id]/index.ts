import { z } from "zod";
import { getCtx, jsonResponse, errorResponse } from "../../../lib/db";
import { validate } from "../../../lib/validate";
import { sanitizeSpecLinks } from "../../../lib/spec-links";
import { specRowToDto, type SpecRow } from "../../../lib/spec-dto";
import { callNoxTicket, type NoxTicketEnvironment } from "../../../lib/noxticket-service";

interface Env extends NoxTicketEnvironment {
  DB: D1Database;
}

interface Ctx {
  env: Env;
  data: { orgId: number; userLogin: string };
  request: Request;
  params: { id: string };
}

const SPEC_COLUMNS =
  "id, org_id, feature_number, is_primary, title, description, " +
  "links_json, archived, archived_at, created_by, created_at, updated_at";

const SpecLinkSchema = z.object({
  url: z.string(),
  label: z.string().optional(),
});

const UpdateSpecBody = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(20_000).optional(),
    /** null moves to Unfiled; undefined leaves unchanged. */
    featureNumber: z.number().int().positive().nullable().optional(),
    isPrimary: z.boolean().optional(),
    links: z.array(SpecLinkSchema).max(50).optional(),
  })
  .refine(
    (v) =>
      v.title !== undefined ||
      v.description !== undefined ||
      v.featureNumber !== undefined ||
      v.isPrimary !== undefined ||
      v.links !== undefined,
    { message: "Nothing to update" },
  );

// GET /api/specs/:id — fetch a single spec.
export async function onRequestGet(context: Ctx): Promise<Response> {
  const { orgId } = getCtx(context) as { orgId: number };
  if (!orgId) return errorResponse("Missing org context", 400);

  const id = Number.parseInt(context.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) return errorResponse("Invalid spec id", 400);

  const delegated = await callNoxTicket(context.env, (service) => service.getSpec(
    { orgId, userLogin: context.data.userLogin },
    id,
  ));
  if (delegated) return delegated;

  const row = await context.env.DB.prepare(
    `SELECT ${SPEC_COLUMNS} FROM specs WHERE id = ? AND org_id = ?`,
  )
    .bind(id, orgId)
    .first<SpecRow>();

  if (!row) return errorResponse(`Unknown spec ${id}`, 404);
  return jsonResponse(specRowToDto(row));
}

// PATCH /api/specs/:id — partial update. featureNumber: null moves to Unfiled;
// omit to leave unchanged.
export async function onRequestPatch(context: Ctx): Promise<Response> {
  const { orgId } = getCtx(context) as { orgId: number };
  if (!orgId) return errorResponse("Missing org context", 400);

  const id = Number.parseInt(context.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) return errorResponse("Invalid spec id", 400);

  let rawBody: unknown;
  try {
    rawBody = await context.request.json();
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }
  const delegated = await callNoxTicket(context.env, (service) => service.updateSpec(
    { orgId, userLogin: context.data.userLogin },
    id,
    rawBody,
  ));
  if (delegated) return delegated;
  const parsed = validate(UpdateSpecBody, rawBody);
  if (!parsed.ok) return parsed.response;
  const patch = parsed.data;

  const current = await context.env.DB.prepare(
    "SELECT feature_number, archived FROM specs WHERE id = ? AND org_id = ?",
  )
    .bind(id, orgId)
    .first<{ feature_number: number | null; archived: number }>();
  if (!current) return errorResponse(`Unknown spec ${id}`, 404);

  if (patch.featureNumber != null) {
    const feature = await context.env.DB.prepare(
      "SELECT 1 FROM features WHERE org_id = ? AND number = ?",
    )
      .bind(orgId, patch.featureNumber)
      .first<{ 1: number }>();
    if (!feature) return errorResponse(`Unknown feature #${patch.featureNumber}`, 400);
  }

  const targetFeatureNumber =
    patch.featureNumber !== undefined ? patch.featureNumber : current.feature_number;
  if (patch.isPrimary) {
    if (targetFeatureNumber == null || current.archived === 1) {
      return errorResponse("Only an active spec attached to a feature can be primary", 422);
    }
    const sibling = await context.env.DB.prepare(
      `SELECT 1 FROM specs
        WHERE org_id = ? AND feature_number = ? AND archived = 0 AND id != ?
        LIMIT 1`,
    )
      .bind(orgId, targetFeatureNumber, id)
      .first();
    if (!sibling) {
      return errorResponse("A primary spec can only be selected when a feature has multiple specs", 422);
    }
  }

  const sets: string[] = [];
  const binds: (string | number | null)[] = [];
  if (patch.title !== undefined) {
    sets.push("title = ?");
    binds.push(patch.title);
  }
  if (patch.description !== undefined) {
    sets.push("description = ?");
    binds.push(patch.description);
  }
  if (patch.featureNumber !== undefined) {
    sets.push("feature_number = ?");
    binds.push(patch.featureNumber);
    // Primary is a property of the old Feature relationship. Moving or
    // detaching a spec clears it unless this same request explicitly picks
    // the spec as primary in its new Feature.
    if (patch.isPrimary === undefined) sets.push("is_primary = 0");
  }
  if (patch.isPrimary !== undefined) {
    sets.push("is_primary = ?");
    binds.push(patch.isPrimary ? 1 : 0);
  }
  if (patch.links !== undefined) {
    sets.push("links_json = ?");
    binds.push(JSON.stringify(sanitizeSpecLinks(patch.links)));
  }
  sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')");

  const updateStatement = context.env.DB.prepare(
    `UPDATE specs
        SET ${sets.join(", ")}
      WHERE id = ? AND org_id = ?
      RETURNING ${SPEC_COLUMNS}`,
  )
    .bind(...binds, id, orgId);

  let row: SpecRow | null;
  if (patch.isPrimary && targetFeatureNumber != null) {
    // D1 batches are transactional, so concurrent requests never leave a
    // feature with two primaries (also guarded by the partial unique index).
    await context.env.DB.batch([
      context.env.DB.prepare(
        `UPDATE specs SET is_primary = 0
          WHERE org_id = ? AND feature_number = ? AND id != ? AND is_primary = 1`,
      ).bind(orgId, targetFeatureNumber, id),
      updateStatement,
    ]);
    row = await context.env.DB.prepare(
      `SELECT ${SPEC_COLUMNS} FROM specs WHERE id = ? AND org_id = ?`,
    )
      .bind(id, orgId)
      .first<SpecRow>();
  } else {
    row = await updateStatement.first<SpecRow>();
  }

  if (!row) return errorResponse(`Unknown spec ${id}`, 404);
  return jsonResponse(specRowToDto(row));
}
