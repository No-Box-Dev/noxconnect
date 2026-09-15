import { z } from "zod";
import { getCtx, jsonResponse, errorResponse } from "../../lib/db";
import { validate } from "../../lib/validate";
import { sanitizeSpecLinks } from "../../lib/spec-links";
import { specRowToDto, type SpecRow } from "../../lib/spec-dto";
import { callNoxTicket, type NoxTicketEnvironment } from "../../lib/noxticket-service";

interface Env extends NoxTicketEnvironment {
  DB: D1Database;
}

interface Ctx {
  env: Env;
  data: { orgId: number; projectId?: string | null; userLogin: string };
  request: Request;
}

const SPEC_COLUMNS =
  "id, org_id, project_id, feature_number, is_primary, title, description, " +
  "links_json, archived, archived_at, created_by, created_at, updated_at";

const SpecLinkSchema = z.object({
  url: z.string(),
  label: z.string().optional(),
});

const CreateSpecBody = z.object({
  title: z.string().trim().min(1, "Title is required").max(200, "Title too long (max 200)"),
  description: z.string().max(20_000, "Description too long (max 20000)").optional(),
  // Feature the spec belongs to. `null` explicitly means Unfiled.
  featureNumber: z.number().int().positive().nullable().optional(),
  links: z.array(SpecLinkSchema).max(50).optional(),
});

// GET /api/specs?featureNumber=<n|unfiled>&include=all
// Lists specs for the current org. Filters:
//   featureNumber=<n>       — specs owned by that Feature (issue number)
//   featureNumber=unfiled   — specs with feature_number IS NULL
//   (omitted)               — every spec in the org
//   include=all             — include archived (default hides them)
export async function onRequestGet(context: Ctx): Promise<Response> {
  const { orgId, projectId } = getCtx(context) as Ctx["data"];
  if (!orgId) return errorResponse("Missing org context", 400);

  const url = new URL(context.request.url);
  const includeArchived = url.searchParams.get("include") === "all";
  const featureParam = url.searchParams.get("featureNumber");

  const clauses: string[] = ["org_id = ?"];
  const binds: (string | number)[] = [orgId];
  if (projectId) {
    clauses.push("project_id = ?");
    binds.push(projectId);
  }

  if (featureParam === "unfiled") {
    clauses.push("feature_number IS NULL");
  } else if (featureParam !== null && featureParam !== "") {
    const n = Number.parseInt(featureParam, 10);
    if (!Number.isFinite(n) || n <= 0) return errorResponse("Invalid featureNumber", 400);
    clauses.push("feature_number = ?");
    binds.push(n);
  }

  const delegated = projectId ? await callNoxTicket(context.env, (service) => service.listSpecs(
    { orgId, projectId, userLogin: context.data.userLogin },
    {
      includeArchived,
      ...(featureParam === "unfiled"
        ? { featureNumber: "unfiled" as const }
        : featureParam ? { featureNumber: Number.parseInt(featureParam, 10) } : {}),
    },
  )) : null;
  if (delegated) return delegated;

  if (!includeArchived) clauses.push("archived = 0");

  const { results } = await context.env.DB.prepare(
    `SELECT ${SPEC_COLUMNS}
       FROM specs
      WHERE ${clauses.join(" AND ")}
      ORDER BY archived ASC, updated_at DESC`,
  )
    .bind(...binds)
    .all<SpecRow>();

  return jsonResponse({ specs: (results ?? []).map(specRowToDto) });
}

// POST /api/specs — create a spec. Server verifies the target feature (if
// any) exists in this org and sanitizes links before storage.
export async function onRequestPost(context: Ctx): Promise<Response> {
  const { orgId, projectId, userLogin } = getCtx(context) as Ctx["data"];
  if (!orgId) return errorResponse("Missing org context", 400);
  if (!userLogin) return errorResponse("Missing user context", 400);

  let rawBody: unknown;
  try {
    rawBody = await context.request.json();
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }
  const delegated = projectId ? await callNoxTicket(context.env, (service) => service.createSpec(
    { orgId, projectId, userLogin },
    rawBody,
  )) : null;
  if (delegated) return delegated;
  const parsed = validate(CreateSpecBody, rawBody);
  if (!parsed.ok) return parsed.response;
  const { title, description, featureNumber, links } = parsed.data;

  if (featureNumber != null) {
    const feature = await context.env.DB.prepare(projectId
      ? "SELECT 1 FROM features WHERE org_id = ? AND project_id = ? AND number = ?"
      : "SELECT 1 FROM features WHERE org_id = ? AND number = ?")
      .bind(...(projectId ? [orgId, projectId, featureNumber] : [orgId, featureNumber]))
      .first<{ 1: number }>();
    if (!feature) return errorResponse(`Unknown feature #${featureNumber}`, 400);
  }

  const cleanLinks = sanitizeSpecLinks(links ?? []);
  const linksJson = JSON.stringify(cleanLinks);

  const row = await context.env.DB.prepare(
    `INSERT INTO specs (org_id, project_id, feature_number, title, description, links_json, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     RETURNING ${SPEC_COLUMNS}`,
  )
    .bind(orgId, projectId ?? null, featureNumber ?? null, title, description ?? "", linksJson, userLogin)
    .first<SpecRow>();

  if (!row) return errorResponse("Failed to create spec", 500);
  return jsonResponse(specRowToDto(row), 201);
}
