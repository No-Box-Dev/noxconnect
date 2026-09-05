// GET /api/v1/feed — versioned public Feed API.
//
// Query params:
//   mode    "opened" | "merged" | "release-notes"   default "merged"
//   repo    string                                    optional (repo name)
//   actor   string                                    optional (GitHub login)
//   limit   number, 1..200                            default 25
//   before  string cursor "<createdAt>:<id>"          optional
//
// Auth: same as everything else — Bearer + X-Org header, validated by the
// middleware. This endpoint is stable public shape v1; internal names
// (actor_id, project_id, payload_json, etc.) never leak.
//
// Response 200:
//   { events: FeedEvent[], nextCursor: string | null }
//
// FeedEvent (public):
//   {
//     id: string,
//     type: "opened" | "merged" | "release-notes",
//     createdAt: ISO8601,
//     actor: { login, name, avatarUrl },
//     repo: string,
//     summary: string,
//     technicalSummary: string,
//     pr: { number, title, url } | null
//   }
//
// Actor + PR data is extracted from payload_json (denormalized on write by
// the webhook + narrator) so no join is required. Downside: reflects the
// author identity at event time, not the current actors-table overlay. For
// v1 that's acceptable — the overlay editor is admin-only web surface, and
// the payload's github login/avatar is authoritative for external clients.

import { z } from "zod";
import { getCtx } from "../../lib/db";
import { normalizeLegacyError, v1Error, v1Response } from "../../lib/api-v1";
import { validate } from "../../lib/validate";

interface Env {
  DB: D1Database;
}

interface Ctx {
  env: Env;
  request: Request;
  data: { orgLogin: string; projectId?: string | null };
}

// ---------- Public shape ----------

type PublicType = "opened" | "merged" | "release-notes";

interface PublicActor {
  login: string;
  name: string | null;
  avatarUrl: string | null;
}

interface PublicPR {
  number: number;
  title: string;
  url: string;
}

interface FeedEvent {
  id: string;
  type: PublicType;
  createdAt: string;
  actor: PublicActor;
  repo: string;
  summary: string;
  technicalSummary: string;
  pr: PublicPR | null;
}

// ---------- Mode → internal filter ----------

interface ModeFilter {
  eventType: string;      // events.type
  triggerType: string;    // payload_json.trigger_type
}

const MODE_FILTER: Record<PublicType, ModeFilter> = {
  "opened":        { eventType: "pr_narrative", triggerType: "github:pr:opened" },
  "merged":        { eventType: "narrative",    triggerType: "github:pr:merged" },
  "release-notes": { eventType: "release_notes", triggerType: "github:pr:merged" },
};

// ---------- Query schema ----------

const QuerySchema = z.object({
  mode: z.enum(["opened", "merged", "release-notes"]).default("merged"),
  repo: z.string().min(1).max(200).optional(),
  actor: z.string().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(25),
  before: z.string().min(1).max(200).optional(),
});

// ---------- Handler ----------

export async function onRequestGet(context: Ctx): Promise<Response> {
  const { orgLogin, projectId } = getCtx(context) as Ctx["data"];
  if (!orgLogin) return v1Error("missing_org_context", "Missing organization context", 400);

  const url = new URL(context.request.url);
  const raw = Object.fromEntries(url.searchParams.entries());
  const parsed = validate(QuerySchema, raw);
  if (!parsed.ok) return normalizeLegacyError(parsed.response);
  const { mode, repo, actor, limit, before } = parsed.data;

  const filter = MODE_FILTER[mode];

  const conds: string[] = [
    "owner_id = ?",
    "type = ?",
    "json_extract(payload_json, '$.trigger_type') = ?",
  ];
  const binds: (string | number)[] = [orgLogin, filter.eventType, filter.triggerType];

  if (projectId) {
    conds.push("project_id = ?");
    binds.push(projectId);
  }

  if (repo) {
    conds.push("repo = ?");
    binds.push(repo);
  }
  if (actor) {
    // Filter on the denormalized author login in the PR payload. Case-
    // insensitive because GitHub logins normalize that way and users type
    // them however they remember.
    conds.push("LOWER(json_extract(payload_json, '$.pr.author.login')) = LOWER(?)");
    binds.push(actor);
  }

  const cursor = parseCursor(before);
  if (cursor) {
    conds.push("(created_at < ? OR (created_at = ? AND id < ?))");
    binds.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }

  const sql = `
    SELECT id, type, created_at, repo, summary, technical_summary, payload_json
    FROM events
    WHERE ${conds.join(" AND ")}
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `;
  binds.push(limit);

  const rows = await context.env.DB.prepare(sql).bind(...binds).all();
  const events = (rows.results ?? []).map((r) => mapRow(r, mode));

  const last = events[events.length - 1];
  const nextCursor = last && events.length === limit
    ? `${last.createdAt}:${last.id}`
    : null;

  return v1Response({ events, nextCursor });
}

// ---------- Mapping ----------

interface RawRow {
  id: number;
  type: string;
  created_at: string;
  repo: string | null;
  summary: string | null;
  technical_summary: string | null;
  payload_json: string | null;
}

function mapRow(row: unknown, mode: PublicType): FeedEvent {
  const r = row as RawRow;
  const payload = parsePayload(r.payload_json);
  const author = payload?.pr?.author ?? null;
  const pr = payload?.pr ?? null;

  return {
    id: String(r.id),
    type: mode,
    createdAt: r.created_at,
    actor: {
      login: (author?.login as string | undefined) ?? "unknown",
      name: (author?.name as string | undefined) ?? null,
      avatarUrl: (author?.avatar_url as string | undefined) ?? null,
    },
    repo: r.repo ?? "",
    summary: r.summary ?? "",
    technicalSummary: r.technical_summary ?? "",
    pr: pr
      ? {
          number: Number(pr.number ?? 0),
          title: String(pr.title ?? ""),
          url: String(pr.html_url ?? ""),
        }
      : null,
  };
}

interface PRPayload {
  number?: number;
  title?: string;
  html_url?: string;
  author?: Record<string, unknown>;
}

function parsePayload(raw: string | null): { pr?: PRPayload } | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as { pr?: PRPayload };
  } catch {
    return null;
  }
}

// ---------- Cursor ----------

function parseCursor(value: string | undefined): { createdAt: string; id: number } | null {
  if (!value) return null;
  const idx = value.lastIndexOf(":");
  if (idx <= 0) return null;
  const createdAt = value.slice(0, idx);
  const id = parseInt(value.slice(idx + 1), 10);
  if (!Number.isFinite(id) || !createdAt) return null;
  return { createdAt, id };
}
