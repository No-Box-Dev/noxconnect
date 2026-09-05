import { z } from "zod";
import { getCtx, jsonResponse, errorResponse } from "../../lib/db";
import { DEFAULT_ACTOR_TONE } from "../../lib/actors";
import { validate } from "../../lib/validate";
import { requireAdmin } from "../../lib/access.js";

interface Env {
  DB: D1Database;
}

interface Ctx {
  env: Env;
  data: { orgId: number; orgLogin: string; isAdmin: boolean };
  request: Request;
  params: { id: string };
}

const PATCH_COLS = new Set(["name", "avatar_url", "tone", "kind", "github_user_id"]);

// Body schema — the handler only consumes keys in PATCH_COLS, so the schema just
// guards "the body is a JSON object". Declaring no known keys keeps every key
// passing through in insertion order (the original iterated Object.entries on the
// raw body, so SET-clause order follows the request); per-field allow-listing is
// still done by the PATCH_COLS filter below. This mirrors the original
// hand-rolled behavior exactly.
const PatchBody = z.object({}).passthrough();

// GET /api/actors/:id — single actor (joined or standalone).
export async function onRequestGet(context: Ctx): Promise<Response> {
  const { orgLogin } = getCtx(context) as { orgLogin: string };
  const { id } = context.params;
  if (!orgLogin) return errorResponse("Missing org context", 400);
  if (!id) return errorResponse("Missing id", 400);

  const row = await selectActorById(context.env.DB, orgLogin, id);
  if (!row) return errorResponse("Unknown actor", 404);
  return jsonResponse({ actor: row });
}

// PATCH /api/actors/:id — update tone / name / avatar_url / kind.
// Materializes a synthesized 'actor_<login>' id into a real row first.
export async function onRequestPatch(context: Ctx): Promise<Response> {
  const accessError = requireAdmin(context);
  if (accessError) return accessError;
  const { orgLogin } = getCtx(context) as { orgLogin: string };
  const { id } = context.params;
  if (!orgLogin) return errorResponse("Missing org context", 400);
  if (!id) return errorResponse("Missing id", 400);

  let rawBody: unknown;
  try {
    rawBody = await context.request.json();
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  const parsed = validate(PatchBody, rawBody);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const materialized = await ensureActorRow(context.env.DB, orgLogin, id);
  if (!materialized) return errorResponse("Unknown actor", 404);

  const setClauses: string[] = [];
  const values: unknown[] = [];
  for (const [k, v] of Object.entries(body)) {
    if (!PATCH_COLS.has(k)) continue;
    setClauses.push(`${k} = ?`);
    values.push(v === "" ? null : v);
  }
  if (setClauses.length === 0) return errorResponse("No editable fields supplied", 400);

  await context.env.DB.prepare(
    `UPDATE actors SET ${setClauses.join(", ")}, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ? AND owner_id = ?`
  ).bind(...values, materialized.id, orgLogin).run();

  const fresh = await selectActorById(context.env.DB, orgLogin, materialized.id);
  return jsonResponse({ actor: fresh });
}

async function selectActorById(db: D1Database, orgLogin: string, id: string) {
  const joined = await db.prepare(
    `SELECT
        COALESCE(a.id, 'actor_' || u.login)             AS id,
        u.login                                         AS github_login,
        COALESCE(a.github_user_id, CAST(u.id AS TEXT))  AS github_user_id,
        COALESCE(NULLIF(a.name, ''), u.name, u.login)   AS name,
        COALESCE(a.avatar_url, u.avatar_url)            AS avatar_url,
        COALESCE(NULLIF(a.tone, ''), ?)                 AS tone,
        COALESCE(a.kind, CASE WHEN u.type = 'Bot' THEN 'bot' ELSE 'human' END) AS kind,
        ?                                               AS owner_id,
        COALESCE(a.created_at, u.synced_at)             AS created_at,
        COALESCE(a.updated_at, u.synced_at)             AS updated_at
     FROM gh_users u
     LEFT JOIN actors a ON a.owner_id = ? AND a.github_user_id = CAST(u.id AS TEXT)
     WHERE COALESCE(a.id, 'actor_' || u.login) = ?
       AND u.id IN (
         SELECT m.gh_user_id FROM gh_members m
         JOIN installations i ON i.installation_id = m.installation_id
         WHERE i.owner_id = ?
       )
     LIMIT 1`
  ).bind(DEFAULT_ACTOR_TONE, orgLogin, orgLogin, id, orgLogin).first();
  if (joined) return joined;

  const standalone = await db.prepare(
    `SELECT a.id, NULL AS github_login, a.github_user_id, a.name, a.avatar_url,
            COALESCE(NULLIF(a.tone, ''), ?) AS tone,
            a.kind, a.owner_id, a.created_at, a.updated_at
     FROM actors a
     WHERE a.owner_id = ? AND a.id = ?
     LIMIT 1`
  ).bind(DEFAULT_ACTOR_TONE, orgLogin, id).first();
  return standalone ?? null;
}

// Materialize an actors row when the caller passes a synthesized id.
// 'actor_<login>' → look up gh_users by login, insert overlay row.
async function ensureActorRow(db: D1Database, orgLogin: string, id: string) {
  const existing = await db.prepare(
    "SELECT id FROM actors WHERE id = ? AND owner_id = ?"
  ).bind(id, orgLogin).first<{ id: string }>();
  if (existing) return existing;

  if (!id.startsWith("actor_")) return null;
  const login = id.slice("actor_".length);
  if (!login) return null;

  const ghUser = await db.prepare(
    `SELECT u.id, u.login, u.avatar_url, u.type, u.name
       FROM gh_users u
      WHERE u.login = ?
        AND u.id IN (
          SELECT m.gh_user_id FROM gh_members m
          JOIN installations i ON i.installation_id = m.installation_id
          WHERE i.owner_id = ?
        )
      LIMIT 1`
  ).bind(login, orgLogin).first<{ id: number | string; login: string; avatar_url: string | null; type: string; name: string | null }>();
  if (!ghUser) return null;

  await db.prepare(
    `INSERT INTO actors (id, github_user_id, name, avatar_url, tone, kind, owner_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`
  ).bind(
    id,
    String(ghUser.id),
    ghUser.name || ghUser.login,
    ghUser.avatar_url,
    DEFAULT_ACTOR_TONE,
    ghUser.type === "Bot" ? "bot" : "human",
    orgLogin,
  ).run();

  const row = await db.prepare(
    "SELECT id FROM actors WHERE id = ? AND owner_id = ?"
  ).bind(id, orgLogin).first<{ id: string }>();
  return row ?? null;
}
