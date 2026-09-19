// GET /api/search — one authenticated, organization-wide search surface for NoxFeed.
//
// The client makes one request while this endpoint fans out with D1 batch. Results
// are deliberately returned in a stable, typed shape so the native app can group
// them like Spotlight without downloading each resource collection first.

import { z } from "zod";
import { getCtx, jsonResponse } from "../lib/db";
import { getActiveRepoNames } from "../lib/inactive-repos";
import { validate } from "../lib/validate";

interface Env { DB: D1Database }
interface Ctx {
  env: Env;
  request: Request;
  data: { orgId: number; orgLogin: string };
}

type SearchKind = "person" | "pull_request" | "issue" | "feature" | "post" | "release_note";
type Row = Record<string, string | number | null>;

interface SearchResult {
  id: string;
  kind: SearchKind;
  title: string;
  subtitle: string;
  repo: string | null;
  number: number | null;
  state: string | null;
  url: string | null;
  avatarUrl: string | null;
  login: string | null;
  createdAt: string | null;
  score: number;
}

const QuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(60).default(40),
});

const TYPE_WEIGHT: Record<SearchKind, number> = {
  person: 30,
  pull_request: 24,
  issue: 20,
  feature: 18,
  post: 12,
  release_note: 12,
};

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableText(value: unknown): string | null {
  const valueText = text(value);
  return valueText || null;
}

function numeric(value: unknown): number | null {
  return typeof value === "number" ? value : Number.isFinite(Number(value)) ? Number(value) : null;
}

function relevance(result: Omit<SearchResult, "score">, needle: string, issueNumber: number | null): number {
  const title = result.title.toLocaleLowerCase();
  const subtitle = result.subtitle.toLocaleLowerCase();
  const repo = (result.repo ?? "").toLocaleLowerCase();
  const login = (result.login ?? "").toLocaleLowerCase();
  let score = TYPE_WEIGHT[result.kind];

  if (issueNumber !== null && result.number === issueNumber) score += 1_000;
  if (login === needle) score += 500;
  else if (login.startsWith(needle)) score += 260;
  if (title === needle || title === `@${needle}`) score += 500;
  else if (title.startsWith(needle) || title.startsWith(`@${needle}`)) score += 260;
  else if (title.includes(needle)) score += 130;
  if (repo === needle) score += 220;
  else if (repo.startsWith(needle)) score += 100;
  if (subtitle.includes(needle)) score += 45;
  if (result.state === "open") score += 8;

  if (result.createdAt) {
    const ageDays = Math.max(0, (Date.now() - Date.parse(result.createdAt)) / 86_400_000);
    score += Math.max(0, 20 - Math.log2(ageDays + 1) * 3);
  }
  return score;
}

export async function onRequestGet(context: Ctx): Promise<Response> {
  const parsed = validate(QuerySchema, Object.fromEntries(new URL(context.request.url).searchParams.entries()));
  if (!parsed.ok) return parsed.response;

  const { orgId, orgLogin, projectId } = getCtx(context) as { orgId: number; orgLogin: string; projectId?: string | null };
  const { q, limit } = parsed.data;
  const needle = q.toLocaleLowerCase().replace(/^@/, "");
  if (!needle) {
    const response = jsonResponse({ error: "Query must include search text" }, 400);
    response.headers.set("Cache-Control", "no-store");
    return response;
  }
  const like = `%${escapeLike(needle)}%`;
  const numberMatch = needle.match(/^#?(\d+)$/);
  const issueNumber = numberMatch ? Number(numberMatch[1]) : null;
  const activeRepos = await getActiveRepoNames(context.env.DB, orgId, orgLogin, projectId);
  const repoSql = activeRepos.length ? `repo IN (${activeRepos.map(() => "?").join(",")})` : "0";
  const perKind = Math.min(20, Math.max(6, Math.ceil(limit / 3)));
  const db = context.env.DB;
  const featureProjectFilter = projectId ? " AND project_id = ?" : "";
  const featureProjectBinds = projectId ? [projectId] : [];

  const [people, prs, issues, features, events] = await db.batch([
    db.prepare(
      `SELECT CAST(m.id AS TEXT) AS id, m.login, COALESCE(a.name, m.login) AS name,
              COALESCE(a.avatar_url, m.avatar_url) AS avatar_url
       FROM members m
       LEFT JOIN actors a ON a.owner_id = ? AND a.github_user_id = CAST(m.gh_user_id AS TEXT)
       WHERE m.org_id = ? AND m.kind != 'bot'
         AND (LOWER(m.login) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(a.name, '')) LIKE ? ESCAPE '\\')
       ORDER BY CASE WHEN LOWER(m.login) = ? THEN 0 WHEN LOWER(m.login) LIKE ? ESCAPE '\\' THEN 1 ELSE 2 END, m.login
       LIMIT ?`,
    ).bind(orgLogin, orgId, like, like, needle, `${escapeLike(needle)}%`, perKind),
    db.prepare(
      `SELECT CAST(id AS TEXT) AS id, repo, number, title, state, author, author_avatar, html_url, updated_at
       FROM pull_requests
       WHERE org_id = ? AND ${repoSql}
         AND (LOWER(title) LIKE ? ESCAPE '\\' OR LOWER(author) LIKE ? ESCAPE '\\'
              OR LOWER(repo) LIKE ? ESCAPE '\\' OR (? IS NOT NULL AND number = ?))
       ORDER BY CASE WHEN (? IS NOT NULL AND number = ?) THEN 0 WHEN LOWER(title) LIKE ? ESCAPE '\\' THEN 1 ELSE 2 END,
                updated_at DESC
       LIMIT ?`,
    ).bind(orgId, ...activeRepos, like, like, like, issueNumber, issueNumber, issueNumber, issueNumber, `${escapeLike(needle)}%`, perKind),
    db.prepare(
      `SELECT CAST(id AS TEXT) AS id, repo, number, title, state, author, author_avatar, html_url, updated_at
       FROM issues
       WHERE org_id = ? AND ${repoSql}
         AND (LOWER(title) LIKE ? ESCAPE '\\' OR LOWER(author) LIKE ? ESCAPE '\\'
              OR LOWER(repo) LIKE ? ESCAPE '\\' OR (? IS NOT NULL AND number = ?))
       ORDER BY CASE WHEN (? IS NOT NULL AND number = ?) THEN 0 WHEN LOWER(title) LIKE ? ESCAPE '\\' THEN 1 ELSE 2 END,
                updated_at DESC
       LIMIT ?`,
    ).bind(orgId, ...activeRepos, like, like, like, issueNumber, issueNumber, issueNumber, issueNumber, `${escapeLike(needle)}%`, perKind),
    db.prepare(
      `SELECT CAST(id AS TEXT) AS id, number, title, state, html_url, updated_at
       FROM features
       WHERE org_id = ?${featureProjectFilter}
         AND (LOWER(title) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(body, '')) LIKE ? ESCAPE '\\'
              OR (? IS NOT NULL AND number = ?))
       ORDER BY CASE WHEN (? IS NOT NULL AND number = ?) THEN 0 WHEN LOWER(title) LIKE ? ESCAPE '\\' THEN 1 ELSE 2 END,
                updated_at DESC
       LIMIT ?`,
    ).bind(orgId, ...featureProjectBinds, like, like, issueNumber, issueNumber, issueNumber, issueNumber, `${escapeLike(needle)}%`, perKind),
    db.prepare(
      `SELECT CAST(id AS TEXT) AS id, repo, type, SUBSTR(summary, 1, 280) AS summary, payload_json, created_at
       FROM events
       WHERE org_id = ? AND type IN ('narrative', 'release_notes') AND ${repoSql}
         AND (LOWER(summary) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(technical_summary, '')) LIKE ? ESCAPE '\\'
              OR LOWER(repo) LIKE ? ESCAPE '\\'
              OR LOWER(COALESCE(json_extract(payload_json, '$.pr.author.login'), json_extract(payload_json, '$.pr.author'), '')) LIKE ? ESCAPE '\\')
       ORDER BY created_at DESC
       LIMIT ?`,
    ).bind(orgId, ...activeRepos, like, like, like, like, perKind),
  ]);

  const results: Array<Omit<SearchResult, "score">> = [];
  for (const raw of people.results ?? []) {
    const row = raw as Row;
    const login = text(row.login);
    const name = text(row.name);
    results.push({ id: `person:${row.id}`, kind: "person", title: name || `@${login}`, subtitle: `@${login}`, repo: null, number: null, state: null, url: null, avatarUrl: nullableText(row.avatar_url), login, createdAt: null });
  }
  for (const raw of prs.results ?? []) {
    const row = raw as Row;
    results.push({ id: `pr:${row.id}`, kind: "pull_request", title: text(row.title), subtitle: `${text(row.repo)} #${row.number} · ${text(row.author)}`, repo: nullableText(row.repo), number: numeric(row.number), state: nullableText(row.state), url: nullableText(row.html_url), avatarUrl: nullableText(row.author_avatar), login: nullableText(row.author), createdAt: nullableText(row.updated_at) });
  }
  for (const raw of issues.results ?? []) {
    const row = raw as Row;
    results.push({ id: `issue:${row.id}`, kind: "issue", title: text(row.title), subtitle: `${text(row.repo)} #${row.number} · ${text(row.author)}`, repo: nullableText(row.repo), number: numeric(row.number), state: nullableText(row.state), url: nullableText(row.html_url), avatarUrl: nullableText(row.author_avatar), login: nullableText(row.author), createdAt: nullableText(row.updated_at) });
  }
  for (const raw of features.results ?? []) {
    const row = raw as Row;
    results.push({ id: `feature:${row.id}`, kind: "feature", title: text(row.title), subtitle: `Feature #${row.number}`, repo: null, number: numeric(row.number), state: nullableText(row.state), url: nullableText(row.html_url), avatarUrl: null, login: null, createdAt: nullableText(row.updated_at) });
  }
  for (const raw of events.results ?? []) {
    const row = raw as Row;
    let payload: Record<string, unknown> = {};
    try {
      const parsedPayload: unknown = JSON.parse(text(row.payload_json));
      if (parsedPayload && typeof parsedPayload === "object" && !Array.isArray(parsedPayload)) {
        payload = parsedPayload as Record<string, unknown>;
      }
    } catch { /* malformed legacy event */ }
    const prNumber = numeric((payload.pr as Record<string, unknown> | undefined)?.number ?? payload.pr_number);
    const kind: SearchKind = row.type === "release_notes" ? "release_note" : "post";
    results.push({ id: `${kind}:${row.id}`, kind, title: text(row.summary), subtitle: `${text(row.repo)}${prNumber ? ` #${prNumber}` : ""}`, repo: nullableText(row.repo), number: prNumber, state: null, url: null, avatarUrl: null, login: null, createdAt: nullableText(row.created_at) });
  }

  const ranked = results
    .map((result) => ({ ...result, score: relevance(result, needle, issueNumber) }))
    .sort((a, b) => b.score - a.score || (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))
    .slice(0, limit);

  const response = jsonResponse({ query: q, results: ranked });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
