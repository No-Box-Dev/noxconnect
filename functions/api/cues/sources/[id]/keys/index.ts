import { getCtx, errorResponse, jsonResponse } from "../../../../../lib/db";
import { getNoxDb, type NoxDatabaseEnv } from "../../../../../lib/nox-db";
import { createCueKey, createCueKeySchema, hashCueKey } from "../../../../../lib/noxcue-settings";
import { validate } from "../../../../../lib/validate";

interface Ctx {
  env: NoxDatabaseEnv;
  data: { orgId: number; projectId?: string | null; userLogin: string; isAdmin: boolean };
  params: { id: string };
  request: Request;
}

export async function onRequestPost(context: Ctx): Promise<Response> {
  const { orgId, projectId, userLogin, isAdmin } = getCtx(context) as Ctx["data"];
  if (!orgId) return errorResponse("Missing org context", 400);
  if (!isAdmin) return errorResponse("Admin required", 403);
  const db = getNoxDb(context.env);
  let raw: unknown;
  try { raw = await context.request.json(); }
  catch { return errorResponse("Invalid JSON body", 400); }
  const parsed = validate(createCueKeySchema, raw);
  if (!parsed.ok) return parsed.response;

  const source = await db.prepare(
    `SELECT id FROM cue_sources
      WHERE id = ? AND org_id = ?${projectId ? " AND project_id = ?" : ""}`,
  ).bind(...(projectId ? [context.params.id, orgId, projectId] : [context.params.id, orgId])).first<{ id: string }>();
  if (!source) return errorResponse("Cue source not found", 404);

  const value = createCueKey(parsed.data.kind);
  const id = crypto.randomUUID();
  await db.prepare(
    `INSERT INTO cue_source_keys
       (id, org_id, source_id, name, kind, key_prefix, key_hash, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id, orgId, source.id, parsed.data.name, parsed.data.kind,
    value.slice(0, 20), await hashCueKey(value), userLogin,
  ).run();
  return jsonResponse({
    key: { id, name: parsed.data.name, kind: parsed.data.kind, prefix: value.slice(0, 20), value },
    warning: "Copy this key now. It cannot be shown again.",
  }, 201);
}
