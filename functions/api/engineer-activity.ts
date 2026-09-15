// GET /api/engineer-activity?login=X&month=YYYY-MM — daily contribution counts
// for one engineer for a single month, for the People-tab activity table.
// Historical metrics use durable repository tracking periods: activity counts
// while a repo was tracked remains visible after archive/transfer/deletion,
// while activity before opt-in or after removal is excluded.
// Two metrics, both from D1:
//   - prsOpened:   PRs authored, by day (pull_requests — full history)
//   - prsMerged:   authored PRs merged, by their merge day (full history)
//   - prsReviewed: distinct PRs they reviewed, by day (review events — only
//                  since the GitHub App was installed; older months read 0)
//   - commits:      default-branch commits authored by the engineer, by the
//                   commit author's timestamp
// `month` defaults to the current month. Monthly totals and `firstMonth` are
// returned for the trend chart and month selector.

import { z } from "zod";
import { getCtx, jsonResponse } from "../lib/db";
import { validate } from "../lib/validate";

interface Env {
  DB: D1Database;
}

interface Ctx {
  env: Env;
  data: { orgId: number; orgLogin: string; projectId?: string | null };
  request: Request;
}

const Query = z.object({
  login: z.string().regex(/^[a-zA-Z0-9-]+$/, "Invalid login"),
  month: z.string().regex(/^\d{4}-\d{2}$/, "Invalid month").optional(),
});

type KeyedRow = { k: string | null; c: number };

export async function onRequestGet(context: Ctx): Promise<Response> {
  const { orgId, orgLogin, projectId } = getCtx(context) as Ctx["data"];

  const url = new URL(context.request.url);
  const parsed = validate(Query, {
    login: url.searchParams.get("login"),
    month: url.searchParams.get("month") ?? undefined,
  });
  if (!parsed.ok) return parsed.response;
  const { login } = parsed.data;

  const now = new Date();
  const currentMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const month = parsed.data.month ?? currentMonth;

  const db = context.env.DB;
  const projectFilter = projectId ? " AND project_id = ?" : "";
  const aliasedProjectFilter = projectId ? " AND e.project_id = ?" : "";
  const projectBinds = projectId ? [projectId] : [];
  // Reviews are attributed via the actor row (actors.name = GitHub login).
  const actor = await db
    .prepare("SELECT id FROM actors WHERE name = ? AND owner_id = ?")
    .bind(login, orgLogin)
    .first();
  const actorId = (actor?.id as string | undefined) ?? null;

  const statements = [
    // [0] PRs opened, by day, within the month
    db
      .prepare(
        `SELECT strftime('%Y-%m-%d', created_at) AS k, COUNT(*) AS c
         FROM pull_requests p
         WHERE p.org_id = ?${projectFilter} AND p.author = ? AND strftime('%Y-%m', p.created_at) = ?
           AND EXISTS (
             SELECT 1 FROM repo_tracking_periods period
             WHERE period.org_id = p.org_id AND period.repo = p.repo
               AND p.created_at >= period.tracked_from
               AND (period.tracked_until IS NULL OR p.created_at < period.tracked_until)
           )
         GROUP BY k`,
      )
      .bind(orgId, ...projectBinds, login, month),
    // [1] PRs opened by month — powers the longer-range trend chart.
    db
      .prepare(
        `SELECT strftime('%Y-%m', created_at) AS k, COUNT(*) AS c
         FROM pull_requests p
         WHERE p.org_id = ?${projectFilter} AND p.author = ?
           AND EXISTS (
             SELECT 1 FROM repo_tracking_periods period
             WHERE period.org_id = p.org_id AND period.repo = p.repo
               AND p.created_at >= period.tracked_from
               AND (period.tracked_until IS NULL OR p.created_at < period.tracked_until)
           )
         GROUP BY k`,
      )
      .bind(orgId, ...projectBinds, login),
    // [2] Authored PRs merged, by merge day, within the month. This is
    // intentionally keyed by merged_at rather than created_at so the UI does
    // not imply that "opened" and "completed" are the same activity.
    db
      .prepare(
        `SELECT strftime('%Y-%m-%d', merged_at) AS k, COUNT(*) AS c
         FROM pull_requests p
         WHERE p.org_id = ?${projectFilter} AND p.author = ? AND p.merged_at IS NOT NULL
           AND strftime('%Y-%m', p.merged_at) = ?
           AND EXISTS (
             SELECT 1 FROM repo_tracking_periods period
             WHERE period.org_id = p.org_id AND period.repo = p.repo
               AND p.merged_at >= period.tracked_from
               AND (period.tracked_until IS NULL OR p.merged_at < period.tracked_until)
           )
         GROUP BY k`,
      )
      .bind(orgId, ...projectBinds, login, month),
    // [3] Authored PRs merged by month.
    db
      .prepare(
        `SELECT strftime('%Y-%m', merged_at) AS k, COUNT(*) AS c
         FROM pull_requests p
         WHERE p.org_id = ?${projectFilter} AND p.author = ? AND p.merged_at IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM repo_tracking_periods period
             WHERE period.org_id = p.org_id AND period.repo = p.repo
               AND p.merged_at >= period.tracked_from
               AND (period.tracked_until IS NULL OR p.merged_at < period.tracked_until)
           )
         GROUP BY k`,
      )
      .bind(orgId, ...projectBinds, login),
    // [4] Authored default-branch commits, by day, within the month.
    db
      .prepare(
        `SELECT strftime('%Y-%m-%d', authored_at) AS k, COUNT(*) AS c
         FROM github_commits commit_row
         WHERE commit_row.org_id = ?${projectFilter} AND commit_row.author = ?
           AND strftime('%Y-%m', commit_row.authored_at) = ?
           AND EXISTS (
             SELECT 1 FROM repo_tracking_periods period
             WHERE period.org_id = commit_row.org_id AND period.repo = commit_row.repo
               AND commit_row.authored_at >= period.tracked_from
               AND (period.tracked_until IS NULL OR commit_row.authored_at < period.tracked_until)
           )
         GROUP BY k`,
      )
      .bind(orgId, ...projectBinds, login, month),
    // [5] Authored default-branch commits, by month.
    db
      .prepare(
        `SELECT strftime('%Y-%m', authored_at) AS k, COUNT(*) AS c
         FROM github_commits commit_row
         WHERE commit_row.org_id = ?${projectFilter} AND commit_row.author = ?
           AND EXISTS (
             SELECT 1 FROM repo_tracking_periods period
             WHERE period.org_id = commit_row.org_id AND period.repo = commit_row.repo
               AND commit_row.authored_at >= period.tracked_from
               AND (period.tracked_until IS NULL OR commit_row.authored_at < period.tracked_until)
           )
         GROUP BY k`,
      )
      .bind(orgId, ...projectBinds, login),
  ];
  if (actorId) {
    statements.push(
      // [6] PRs reviewed, by day, within the month
      db
        .prepare(
          `SELECT strftime('%Y-%m-%d', COALESCE(json_extract(payload_json, '$.review.submitted_at'), created_at)) AS k,
                  COUNT(DISTINCT repo || '#' || CAST(json_extract(payload_json, '$.pr.number') AS TEXT)) AS c
           FROM events e
           WHERE e.org = ?${aliasedProjectFilter} AND e.actor_id = ? AND e.type LIKE 'github:pr:review:%'
             AND strftime('%Y-%m', COALESCE(json_extract(payload_json, '$.review.submitted_at'), created_at)) = ?
             AND EXISTS (
               SELECT 1 FROM repo_tracking_periods period
               WHERE period.org_id = ? AND period.repo = e.repo
                 AND COALESCE(json_extract(e.payload_json, '$.review.submitted_at'), e.created_at) >= period.tracked_from
                 AND (period.tracked_until IS NULL OR COALESCE(json_extract(e.payload_json, '$.review.submitted_at'), e.created_at) < period.tracked_until)
             )
           GROUP BY k`,
        )
        .bind(orgLogin, ...projectBinds, actorId, month, orgId),
      // [7] Distinct PRs reviewed by month. Qualifying with the repo avoids
      // collapsing e.g. api#42 and web#42 into a single review.
      db
        .prepare(
          `SELECT k, COUNT(*) AS c FROM (
             SELECT
               strftime('%Y-%m', COALESCE(json_extract(payload_json, '$.review.submitted_at'), created_at)) AS k,
               repo,
               json_extract(payload_json, '$.pr.number') AS pr_number
             FROM events e
             WHERE e.org = ?${aliasedProjectFilter} AND e.actor_id = ? AND e.type LIKE 'github:pr:review:%'
               AND EXISTS (
                 SELECT 1 FROM repo_tracking_periods period
                 WHERE period.org_id = ? AND period.repo = e.repo
                   AND COALESCE(json_extract(e.payload_json, '$.review.submitted_at'), e.created_at) >= period.tracked_from
                   AND (period.tracked_until IS NULL OR COALESCE(json_extract(e.payload_json, '$.review.submitted_at'), e.created_at) < period.tracked_until)
               )
               AND json_extract(payload_json, '$.pr.number') IS NOT NULL
             GROUP BY k, repo, pr_number
           )
           GROUP BY k`,
        )
        .bind(orgLogin, ...projectBinds, actorId, orgId),
    );
  }

  const results = await db.batch(statements);
  const prsOpened = toCountMap(results[0].results);
  const monthlyOpened = toCountMap(results[1].results);
  const prsMerged = toCountMap(results[2].results);
  const monthlyMerged = toCountMap(results[3].results);
  const commits = toCountMap(results[4].results);
  const monthlyCommits = toCountMap(results[5].results);
  const prsReviewed = actorId ? toCountMap(results[6].results) : {};
  const monthlyReviewed = actorId ? toCountMap(results[7].results) : {};
  const firstMonthCandidates = [
    ...Object.keys(monthlyOpened),
    ...Object.keys(monthlyMerged),
    ...Object.keys(monthlyCommits),
    ...Object.keys(monthlyReviewed),
  ];
  const firstMonth = firstMonthCandidates.sort()[0] ?? null;

  return jsonResponse({
    login,
    month,
    firstMonth,
    prsOpened,
    prsMerged,
    prsReviewed,
    commits,
    monthlyOpened,
    monthlyMerged,
    monthlyReviewed,
    monthlyCommits,
  });
}

function toCountMap(rows: unknown[]): Record<string, number> {
  const map: Record<string, number> = {};
  for (const raw of rows as KeyedRow[]) {
    if (raw.k) map[raw.k] = Number(raw.c);
  }
  return map;
}
