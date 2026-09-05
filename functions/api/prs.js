import { getCtx, jsonResponse } from "../lib/db";
import { getActiveRepoNames } from "../lib/inactive-repos";

// Explicit projection — never SELECT * so adding a column doesn't silently leak it.
const PR_COLUMNS = [
  "id", "repo", "number", "title", "state", "author", "author_avatar",
  "draft", "head_ref", "head_sha", "base_ref", "merged_at",
  "created_at", "updated_at", "html_url",
  "requested_reviewers_json", "labels_json",
].join(", ");

// Allow-listed sort columns — anything not in this set falls back to
// the default. Prevents user input from being interpolated into SQL.
const SORTABLE_PR_COLUMNS = new Set([
  "updated_at", "created_at", "number", "title", "repo", "author",
]);

const EMPTY_PR_STATS = { open: 0, draft: 0, stale: 0, byRepo: [] };

// GET /api/prs — query cached pull requests
// Query params: state, author, since, repo, page, page_size, meta
export async function onRequestGet(context) {
  const { orgId, orgLogin, projectId } = getCtx(context);
  const url = new URL(context.request.url);

  // Active repos only — see /api/issues for rationale and Settings exception.
  const activeRepos = await getActiveRepoNames(context.env.DB, orgId, orgLogin, projectId);

  const meta = url.searchParams.get("meta");
  if (meta === "stats") {
    if (activeRepos.length === 0) return jsonResponse(EMPTY_PR_STATS);

    const repoFilter = ` AND repo IN (${activeRepos.map(() => "?").join(",")})`;
    const staleDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const [openCount, draftCount, staleCount, byRepo, draftByRepo] = await context.env.DB.batch([
      context.env.DB.prepare(
        `SELECT COUNT(*) as c FROM pull_requests WHERE org_id = ? AND state = 'open'${repoFilter}`,
      ).bind(orgId, ...activeRepos),
      context.env.DB.prepare(
        `SELECT COUNT(*) as c FROM pull_requests WHERE org_id = ? AND state = 'open' AND draft = 1${repoFilter}`,
      ).bind(orgId, ...activeRepos),
      context.env.DB.prepare(
        `SELECT COUNT(*) as c FROM pull_requests WHERE org_id = ? AND state = 'open' AND created_at < ?${repoFilter}`,
      ).bind(orgId, staleDate, ...activeRepos),
      context.env.DB.prepare(
        `SELECT repo, COUNT(*) as count FROM pull_requests WHERE org_id = ? AND state = 'open'${repoFilter} GROUP BY repo ORDER BY count DESC LIMIT 15`,
      ).bind(orgId, ...activeRepos),
      context.env.DB.prepare(
        `SELECT repo, COUNT(*) as count FROM pull_requests WHERE org_id = ? AND state = 'open' AND draft = 1${repoFilter} GROUP BY repo`,
      ).bind(orgId, ...activeRepos),
    ]);

    const draftByRepoMap = Object.fromEntries((draftByRepo.results ?? []).map((r) => [r.repo, r.count]));

    return jsonResponse({
      open: openCount.results[0]?.c ?? 0,
      draft: draftCount.results[0]?.c ?? 0,
      stale: staleCount.results[0]?.c ?? 0,
      byRepo: byRepo.results.map((r) => ({ ...r, draft: draftByRepoMap[r.repo] ?? 0 })),
    });
  }

  const state = url.searchParams.get("state");
  const author = url.searchParams.get("author");
  const since = url.searchParams.get("since");
  const repo = url.searchParams.get("repo");
  const draft = url.searchParams.get("draft") === "1";
  const stale = url.searchParams.get("stale") === "1";
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
  const pageSize = Math.min(500, Math.max(1, parseInt(url.searchParams.get("page_size") || "100", 10) || 100));

  if (activeRepos.length === 0) {
    return jsonResponse({ data: [], totalCount: 0, page, pageSize });
  }

  // Honor an explicit ?repo= filter only when it's in the active set.
  let repoBindings = activeRepos;
  if (repo) {
    if (!activeRepos.includes(repo)) {
      return jsonResponse({ data: [], totalCount: 0, page, pageSize });
    }
    repoBindings = [repo];
  }

  const repoSql = ` AND repo IN (${repoBindings.map(() => "?").join(",")})`;

  let query = `SELECT ${PR_COLUMNS} FROM pull_requests WHERE org_id = ?${repoSql}`;
  const bindings = [orgId, ...repoBindings];

  if (state && state !== "all") {
    query += " AND state = ?";
    bindings.push(state);
  }

  if (author) {
    query += " AND author = ?";
    bindings.push(author);
  }

  if (since) {
    query += " AND updated_at >= ?";
    bindings.push(since);
  }

  if (draft) {
    query += " AND draft = 1";
  }

  let staleDate = null;
  if (stale) {
    staleDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    query += " AND state = 'open' AND created_at < ?";
    bindings.push(staleDate);
  }

  // Build separate count query from the same WHERE conditions
  let countQuery = `SELECT COUNT(*) as count FROM pull_requests WHERE org_id = ?${repoSql}`;
  const countBindings = [orgId, ...repoBindings];

  if (state && state !== "all") {
    countQuery += " AND state = ?";
    countBindings.push(state);
  }
  if (author) {
    countQuery += " AND author = ?";
    countBindings.push(author);
  }
  if (since) {
    countQuery += " AND updated_at >= ?";
    countBindings.push(since);
  }
  if (draft) {
    countQuery += " AND draft = 1";
  }
  if (stale) {
    countQuery += " AND state = 'open' AND created_at < ?";
    countBindings.push(staleDate);
  }

  const countStmt = context.env.DB.prepare(countQuery).bind(...countBindings);

  const sortParam = url.searchParams.get("sort");
  const sortColumn = sortParam && SORTABLE_PR_COLUMNS.has(sortParam) ? sortParam : "updated_at";
  const sortDir = url.searchParams.get("sort_dir") === "asc" ? "ASC" : "DESC";
  query += ` ORDER BY ${sortColumn} ${sortDir} LIMIT ? OFFSET ?`;
  const dataStmt = context.env.DB.prepare(query).bind(...bindings, pageSize, (page - 1) * pageSize);

  const [countResult, rows] = await context.env.DB.batch([countStmt, dataStmt]);
  const totalCount = countResult?.results?.[0]?.count ?? 0;

  // Parse JSON fields
  const results = rows.results.map((row) => ({
    ...row,
    draft: row.draft === 1,
    requested_reviewers: JSON.parse(row.requested_reviewers_json || "[]"),
    labels: JSON.parse(row.labels_json || "[]"),
  }));

  return jsonResponse({ data: results, totalCount, page, pageSize });
}
