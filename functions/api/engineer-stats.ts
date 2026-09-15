// GET /api/engineer-stats — per-member counts for the Engineers tab.
//
// Replaces the old client-side approach (download every PR + issue, then run
// O(members x PRs) filters in the browser). All per-member counts are computed
// server-side in a single DB.batch and returned as maps keyed by GitHub login:
//   - openPRs:         open PRs authored by the member                (grid + detail)
//   - openNonDraftPRs: subset of openPRs excluding drafts             (grid — surface signal-vs-noise)
//   - reviewing:       open non-draft PRs awaiting their review        (grid + detail)
//   - approvalsGiven:  approvals submitted on other people's PRs       (grid + detail)
//   - mergesOfOthers:  merges of other people's PRs                    (grid + detail)
//   - assignedIssues:  open issues assigned to the member              (grid + detail)
//   - lifetimePRs:     PRs authored, all states                        (detail stat)
//   - prsLast4Weeks:   PRs authored, created in the last 28 days       (detail stat)
//   - lifetimeCommits: authored default-branch commits                 (detail stat)
//   - commitsLast4Weeks: authored commits in the last 28 days           (detail stat)
//   - issuesClosed:    issues closed by the member                     (detail stat)
//
// Uses the native D1 batch + parameterized SQL (same proven pattern as prs.js /
// issues.js). The reviewer/assignee lists live in JSON-array columns, queried
// with json_each + json_extract. approvalsGiven reads the events table
// (pull_request_review webhooks); mergesOfOthers reads pull_requests.merged_by
// (populated by webhook on merge — historical rows before migration 0034 are
// NULL until an admin backfill fetches per-PR merged_by).

import { getCtx, jsonResponse } from "../lib/db";
import { getActiveRepoNames } from "../lib/inactive-repos";

interface Env {
  DB: D1Database;
}

interface Ctx {
  env: Env;
  data: { orgId: number; orgLogin: string; projectId?: string | null };
}

type CountRow = { login: string | null; c: number };

export async function onRequestGet(context: Ctx): Promise<Response> {
  // getCtx returns context.data, populated by functions/_middleware.js after it
  // authenticates the request and resolves the org. db.js is untyped JS, hence the cast.
  const { orgId, orgLogin, projectId } = getCtx(context) as Ctx["data"];

  const activeRepos: string[] = await getActiveRepoNames(context.env.DB, orgId, orgLogin, projectId);

  const db = context.env.DB;
  const projectFilter = projectId ? " AND project_id = ?" : "";
  const eventProjectFilter = projectId ? " AND e.project_id = ?" : "";
  const projectBinds = projectId ? [projectId] : [];
  const repoIn = activeRepos.length > 0
    ? `repo IN (${activeRepos.map(() => "?").join(",")})`
    : "0";
  const fourWeeksAgo = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString();

  const [openPRs, openNonDraftPRs, reviewing, approvals, merges, assigned, lifetime, recent, lifetimeCommits, recentCommits, closed, coverage, audits] =
    await db.batch([
      db
        .prepare(
          `SELECT author AS login, COUNT(*) AS c FROM pull_requests
           WHERE org_id = ? AND state = 'open' AND author IS NOT NULL AND ${repoIn}
           GROUP BY author`,
        )
        .bind(orgId, ...activeRepos),
      db
        .prepare(
          `SELECT author AS login, COUNT(*) AS c FROM pull_requests
           WHERE org_id = ? AND state = 'open' AND draft = 0 AND author IS NOT NULL AND ${repoIn}
           GROUP BY author`,
        )
        .bind(orgId, ...activeRepos),
      db
        .prepare(
          `SELECT json_extract(value, '$.login') AS login, COUNT(*) AS c
           FROM pull_requests, json_each(requested_reviewers_json)
           WHERE org_id = ? AND state = 'open' AND draft = 0
             AND requested_reviewers_json != '[]' AND ${repoIn}
           GROUP BY login`,
        )
        .bind(orgId, ...activeRepos),
      // events.org is the login string (not org_id). Self-approvals are excluded
      // by comparing the review author to the PR author from the slimmed payload;
      // rows missing either field (some pre-slimPayload reconciled reviews) drop
      // out via the IS NOT NULL guard, which undercounts safely rather than
      // double-counting self-approvals.
      //
      // Dedup: the same approval lands twice — once from the pull_request_review
      // webhook (storeEvent, GitHub-delivery-id), once from the 30-min reconcile
      // over /repos/{owner}/{repo}/events (reconcile:<org>:<repo>:gh-event-<id>).
      // Different delivery_ids, so the UNIQUE constraint can't dedupe them. We
      // group by the true review identity (reviewer + repo + PR# + submitted_at)
      // inside a subquery, then count reviewers. COALESCE to events.id keeps
      // rows with missing metadata from collapsing into a single bucket.
      db
        .prepare(
          `SELECT login, COUNT(*) AS c FROM (
             SELECT
               json_extract(payload_json, '$.review.author') AS login,
               repo AS r,
               COALESCE(CAST(json_extract(payload_json, '$.pr.number') AS INTEGER), id) AS pr_num,
               COALESCE(json_extract(payload_json, '$.review.submitted_at'), id) AS ts
             FROM events e
             WHERE e.org = ?${eventProjectFilter} AND e.type = 'github:pr:review:approved'
               AND EXISTS (
                 SELECT 1 FROM repo_tracking_periods period
                 WHERE period.org_id = ? AND period.repo = e.repo
                   AND COALESCE(json_extract(e.payload_json, '$.review.submitted_at'), e.created_at) >= period.tracked_from
                   AND (period.tracked_until IS NULL OR COALESCE(json_extract(e.payload_json, '$.review.submitted_at'), e.created_at) < period.tracked_until)
               )
               AND json_extract(payload_json, '$.review.author') IS NOT NULL
               AND json_extract(payload_json, '$.review.author')
                   != json_extract(payload_json, '$.pr.author')
             GROUP BY login, r, pr_num, ts
           )
           GROUP BY login`,
        )
        .bind(orgLogin, ...projectBinds, orgId),
      db
        .prepare(
          `SELECT p.merged_by AS login, COUNT(*) AS c FROM pull_requests p
           WHERE p.org_id = ?${projectFilter} AND p.merged_at IS NOT NULL
             AND p.merged_by IS NOT NULL AND p.merged_by != p.author
             AND EXISTS (
               SELECT 1 FROM repo_tracking_periods period
               WHERE period.org_id = p.org_id AND period.repo = p.repo
                 AND p.merged_at >= period.tracked_from
                 AND (period.tracked_until IS NULL OR p.merged_at < period.tracked_until)
             )
           GROUP BY merged_by`,
        )
        .bind(orgId, ...projectBinds),
      db
        .prepare(
          `SELECT json_extract(value, '$.login') AS login, COUNT(*) AS c
           FROM issues, json_each(assignees_json)
           WHERE org_id = ? AND state = 'open' AND assignees_json != '[]' AND ${repoIn}
           GROUP BY login`,
        )
        .bind(orgId, ...activeRepos),
      db
        .prepare(
          `SELECT p.author AS login, COUNT(*) AS c FROM pull_requests p
           WHERE p.org_id = ?${projectFilter} AND p.author IS NOT NULL
             AND EXISTS (
               SELECT 1 FROM repo_tracking_periods period
               WHERE period.org_id = p.org_id AND period.repo = p.repo
                 AND p.created_at >= period.tracked_from
                 AND (period.tracked_until IS NULL OR p.created_at < period.tracked_until)
             )
           GROUP BY author`,
        )
        .bind(orgId, ...projectBinds),
      db
        .prepare(
          `SELECT p.author AS login, COUNT(*) AS c FROM pull_requests p
           WHERE p.org_id = ?${projectFilter} AND p.author IS NOT NULL AND p.created_at >= ?
             AND EXISTS (
               SELECT 1 FROM repo_tracking_periods period
               WHERE period.org_id = p.org_id AND period.repo = p.repo
                 AND p.created_at >= period.tracked_from
                 AND (period.tracked_until IS NULL OR p.created_at < period.tracked_until)
             )
           GROUP BY author`,
        )
        .bind(orgId, ...projectBinds, fourWeeksAgo),
      db
        .prepare(
          `SELECT commit_row.author AS login, COUNT(*) AS c
           FROM github_commits commit_row
           WHERE commit_row.org_id = ?${projectFilter} AND commit_row.author IS NOT NULL
             AND EXISTS (
               SELECT 1 FROM repo_tracking_periods period
               WHERE period.org_id = commit_row.org_id AND period.repo = commit_row.repo
                 AND commit_row.authored_at >= period.tracked_from
                 AND (period.tracked_until IS NULL OR commit_row.authored_at < period.tracked_until)
             )
           GROUP BY commit_row.author`,
        )
        .bind(orgId, ...projectBinds),
      db
        .prepare(
          `SELECT commit_row.author AS login, COUNT(*) AS c
           FROM github_commits commit_row
           WHERE commit_row.org_id = ?${projectFilter} AND commit_row.author IS NOT NULL
             AND commit_row.authored_at >= ?
             AND EXISTS (
               SELECT 1 FROM repo_tracking_periods period
               WHERE period.org_id = commit_row.org_id AND period.repo = commit_row.repo
                 AND commit_row.authored_at >= period.tracked_from
                 AND (period.tracked_until IS NULL OR commit_row.authored_at < period.tracked_until)
             )
           GROUP BY commit_row.author`,
        )
        .bind(orgId, ...projectBinds, fourWeeksAgo),
      db
        .prepare(
          `SELECT i.closed_by AS login, COUNT(*) AS c FROM issues i
           WHERE i.org_id = ?${projectFilter} AND i.state = 'closed' AND i.closed_by IS NOT NULL
             AND EXISTS (
               SELECT 1 FROM repo_tracking_periods period
               WHERE period.org_id = i.org_id AND period.repo = i.repo
                 AND i.closed_at >= period.tracked_from
                 AND (period.tracked_until IS NULL OR i.closed_at < period.tracked_until)
             )
           GROUP BY closed_by`,
        )
        .bind(orgId, ...projectBinds),
      db
        .prepare(
          `WITH active(repo) AS (SELECT value FROM json_each(?))
           SELECT
             (SELECT MIN(created_at) FROM events
              WHERE org = ? AND type LIKE 'github:pr:review:%' AND repo IN (SELECT repo FROM active)) AS approvals_since,
             (SELECT COUNT(*) FROM pull_requests
              WHERE org_id = ? AND merged_at IS NOT NULL AND merged_by IS NOT NULL
                AND repo IN (SELECT repo FROM active)) AS merged_by_known,
             (SELECT COUNT(*) FROM pull_requests
              WHERE org_id = ? AND merged_at IS NOT NULL
                AND repo IN (SELECT repo FROM active)) AS merged_prs,
             (SELECT COUNT(*) FROM issues
              WHERE org_id = ? AND state = 'closed' AND closed_by IS NOT NULL
                AND repo IN (SELECT repo FROM active)) AS issues_closed_by_known,
             (SELECT COUNT(*) FROM issues
              WHERE org_id = ? AND state = 'closed'
                AND repo IN (SELECT repo FROM active)) AS closed_issues`,
        )
        .bind(
          JSON.stringify(activeRepos),
          orgLogin,
          orgId,
          orgId,
          orgId,
          orgId,
        ),
      db
        .prepare(
          `SELECT request.login, request.start_month, request.end_month, request.completed_at,
                  SUM(month.github_prs) AS github_prs,
                  SUM(month.cached_all_prs) AS cached_all_prs,
                  SUM(month.cached_tracked_prs) AS cached_tracked_prs
           FROM github_stats_audit_requests request
           JOIN github_stats_audit_months month ON month.request_id = request.id
           WHERE request.org_id = ? AND request.status = 'completed'
             AND request.id = (
               SELECT MAX(latest.id)
               FROM github_stats_audit_requests latest
               WHERE latest.org_id = request.org_id
                 AND latest.login = request.login
                 AND latest.status = 'completed'
             )
           GROUP BY request.id, request.login`,
        )
        .bind(orgId),
    ]);

  const coverageRow = coverage.results[0] as {
    approvals_since?: string | null;
    merged_by_known?: number;
    merged_prs?: number;
    issues_closed_by_known?: number;
    closed_issues?: number;
  } | undefined;

  return jsonResponse({
    openPRs: toCountMap(openPRs.results),
    openNonDraftPRs: toCountMap(openNonDraftPRs.results),
    reviewing: toCountMap(reviewing.results),
    approvalsGiven: toCountMap(approvals.results),
    mergesOfOthers: toCountMap(merges.results),
    assignedIssues: toCountMap(assigned.results),
    lifetimePRs: toCountMap(lifetime.results),
    prsLast4Weeks: toCountMap(recent.results),
    lifetimeCommits: toCountMap(lifetimeCommits.results),
    commitsLast4Weeks: toCountMap(recentCommits.results),
    issuesClosed: toCountMap(closed.results),
    coverage: {
      approvalsGivenSince: coverageRow?.approvals_since ?? null,
      mergedByKnown: Number(coverageRow?.merged_by_known ?? 0),
      mergedPRs: Number(coverageRow?.merged_prs ?? 0),
      issuesClosedByKnown: Number(coverageRow?.issues_closed_by_known ?? 0),
      closedIssues: Number(coverageRow?.closed_issues ?? 0),
    },
    prAudits: toAuditMap(audits.results),
  });
}

function toCountMap(rows: unknown[]): Record<string, number> {
  const map: Record<string, number> = {};
  for (const raw of rows as CountRow[]) {
    if (raw.login) map[raw.login] = Number(raw.c);
  }
  return map;
}

function toAuditMap(rows: unknown[]): Record<string, {
  startMonth: string;
  endMonth: string;
  completedAt: string;
  githubPRs: number;
  cachedAllPRs: number;
  cachedTrackedPRs: number;
}> {
  const map: ReturnType<typeof toAuditMap> = {};
  for (const raw of rows as Array<Record<string, unknown>>) {
    const login = raw.login;
    if (typeof login !== "string") continue;
    map[login] = {
      startMonth: String(raw.start_month),
      endMonth: String(raw.end_month),
      completedAt: String(raw.completed_at),
      githubPRs: Number(raw.github_prs ?? 0),
      cachedAllPRs: Number(raw.cached_all_prs ?? 0),
      cachedTrackedPRs: Number(raw.cached_tracked_prs ?? 0),
    };
  }
  return map;
}
