import { getCtx, jsonResponse, errorResponse } from "../lib/db";
import { syncRepo } from "../lib/github-sync";

const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const GITHUB_REPOSITORY = /^[A-Za-z0-9._-]{1,100}$/;

function githubHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "NoxConnect",
  };
}

async function listOrganizationRepos(token, sourceOrg) {
  const repos = [];
  for (let page = 1; page <= 50; page += 1) {
    const response = await fetch(
      `https://api.github.com/orgs/${encodeURIComponent(sourceOrg)}/repos?type=all&sort=full_name&per_page=100&page=${page}`,
      { headers: githubHeaders(token) },
    );
    if (response.status === 403 || response.status === 404) {
      return { inaccessible: true, repos: [] };
    }
    if (!response.ok) {
      throw new Error(`GitHub repository listing failed (${response.status})`);
    }
    const pageRepos = await response.json();
    if (!Array.isArray(pageRepos)) throw new Error("GitHub returned an invalid repository list");
    repos.push(...pageRepos);
    if (pageRepos.length < 100) break;
  }
  return { inaccessible: false, repos };
}

// Admin-only, cursor-batched recovery for repositories that are no longer
// available to the GitHub App installation token. This route deliberately uses
// the authenticated admin's user token: it may still see archived or
// transferred repositories that the installation can no longer access.
//
// `sourceOrg` allows an admin to attach a dedicated archive organization as a
// historical source. Its rows are stored under the selected NoxConnect org so
// every member's People stats include the old activity, while the recovered
// repositories remain retired from current-work views.
export async function onRequestPost(context) {
  const { orgId, orgLogin, token, isAdmin } = getCtx(context);
  if (!isAdmin) return errorResponse("Admin required", 403);

  const url = new URL(context.request.url);
  const cursor = url.searchParams.get("cursor");
  const sourceOrg = url.searchParams.get("sourceOrg")?.trim() || null;
  if (sourceOrg && !GITHUB_LOGIN.test(sourceOrg)) {
    return errorResponse("Invalid source organization", 400);
  }

  if (!cursor) {
    if (sourceOrg) {
      let listing;
      try {
        listing = await listOrganizationRepos(token, sourceOrg);
      } catch (error) {
        return errorResponse(error?.message ?? "GitHub repository listing failed", 502);
      }
      if (listing.inaccessible) {
        return errorResponse(`Cannot access historical organization ${sourceOrg}`, 403);
      }
      const repoList = listing.repos.map((repo) => repo.name).filter(Boolean).sort();
      return jsonResponse({
        done: repoList.length === 0,
        cursor: repoList[0] ?? null,
        repoList,
        repos: repoList.length,
        sourceOrg,
        archivedRepos: listing.repos.filter((repo) => repo.archived === true).length,
      });
    }

    const rows = await context.env.DB
      .prepare(
        `SELECT DISTINCT project.repo
         FROM projects project
         WHERE project.owner_id = ? AND project.repo IS NOT NULL
           AND (
             project.archived = 1
             OR NOT EXISTS (
               SELECT 1 FROM repos repo
               WHERE repo.org_id = ? AND repo.name = project.repo
             )
           )
         ORDER BY project.repo`,
      )
      .bind(orgLogin, orgId)
      .all();
    const repoList = (rows.results ?? []).map((row) => row.repo).filter(Boolean);
    return jsonResponse({
      done: repoList.length === 0,
      cursor: repoList[0] ?? null,
      repoList,
      repos: repoList.length,
    });
  }

  if (!GITHUB_REPOSITORY.test(cursor)) return errorResponse("Invalid repository", 400);

  let project = null;
  if (!sourceOrg) {
    project = await context.env.DB
      .prepare(
        `SELECT repo, archived, archived_at
         FROM projects
         WHERE owner_id = ? AND repo = ?
         LIMIT 1`,
      )
      .bind(orgLogin, cursor)
      .first();
    if (!project) return errorResponse("Unknown repository", 404);
  } else {
    const existing = await context.env.DB
      .prepare(
        `SELECT retired_at, transferred_to
         FROM repos WHERE org_id = ? AND name = ?`,
      )
      .bind(orgId, cursor)
      .first();
    if (existing && !existing.retired_at && !existing.transferred_to) {
      return errorResponse(
        `Cannot recover ${sourceOrg}/${cursor}: an active ${orgLogin}/${cursor} repository already uses that name`,
        409,
      );
    }
  }

  const githubOwner = sourceOrg ?? orgLogin;

  const repoResponse = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(githubOwner)}/${encodeURIComponent(cursor)}`,
    {
      headers: githubHeaders(token),
    },
  );
  if (repoResponse.status === 404 || repoResponse.status === 403) {
    return jsonResponse({ done: true, repo: cursor, recovered: false, inaccessible: true });
  }
  if (!repoResponse.ok) {
    return errorResponse(`GitHub repository lookup failed (${repoResponse.status})`, 502);
  }

  const githubRepo = await repoResponse.json();
  const currentOwner = githubRepo.owner?.login ?? githubOwner;
  const historicalSource = Boolean(sourceOrg);
  const transferred = historicalSource || currentOwner.toLowerCase() !== orgLogin.toLowerCase();
  const stamp = new Date().toISOString();

  await context.env.DB
    .prepare(
      `INSERT INTO repos
         (org_id, name, language, pushed_at, archived_at, discovered_at, retired_at, retirement_reason, transferred_to)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(org_id, name) DO UPDATE SET
         language = excluded.language,
         pushed_at = excluded.pushed_at,
         archived_at = COALESCE(excluded.archived_at, repos.archived_at),
         retired_at = CASE WHEN excluded.transferred_to IS NOT NULL THEN excluded.retired_at ELSE repos.retired_at END,
         retirement_reason = CASE WHEN excluded.transferred_to IS NOT NULL THEN excluded.retirement_reason ELSE repos.retirement_reason END,
         transferred_to = COALESCE(excluded.transferred_to, repos.transferred_to)`,
    )
    .bind(
      orgId,
      cursor,
      githubRepo.language ?? null,
      githubRepo.pushed_at ?? null,
      githubRepo.archived ? stamp : null,
      stamp,
      transferred ? stamp : null,
      historicalSource ? "historical_source" : transferred ? "transferred" : null,
      transferred ? currentOwner : null,
    )
    .run();

  // Historical-source and transferred repositories must never become active
  // projects. The repo row is the durable lifecycle source of truth, while
  // projects.archived drives the Repos tab. Keep both sides aligned so a
  // previously visible project cannot resurface after history recovery.
  if (transferred) {
    const projectId = `proj_${orgLogin}_${cursor}`.toLowerCase();
    await context.env.DB
      .prepare(
        `INSERT INTO projects
           (id, name, org, repo, owner_id, org_id, archived, archived_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           archived = 1,
           archived_at = COALESCE(projects.archived_at, excluded.archived_at),
           updated_at = excluded.updated_at`,
      )
      .bind(projectId, cursor, orgLogin, cursor, orgLogin, orgId, stamp, stamp)
      .run();
  }

  // GitHub follows old-repository redirects, so the original org/name path
  // can still recover a transferred repository while preserving its historic
  // identity in NoxConnect.
  await syncRepo(context.env.DB, token, orgId, githubOwner, cursor, true, context.env);

  const activityBounds = await context.env.DB
    .prepare(
      `SELECT MIN(at) AS first_seen, MAX(at) AS last_seen FROM (
         SELECT created_at AS at FROM pull_requests WHERE org_id = ? AND repo = ?
         UNION ALL SELECT merged_at FROM pull_requests WHERE org_id = ? AND repo = ? AND merged_at IS NOT NULL
         UNION ALL SELECT created_at FROM issues WHERE org_id = ? AND repo = ?
         UNION ALL SELECT closed_at FROM issues WHERE org_id = ? AND repo = ? AND closed_at IS NOT NULL
       )`,
    )
    .bind(orgId, cursor, orgId, cursor, orgId, cursor, orgId, cursor)
    .first();

  if (activityBounds?.first_seen) {
    const trackedUntil = historicalSource
      ? new Date(new Date(activityBounds.last_seen).getTime() + 1000).toISOString()
      : project?.archived_at ?? (transferred ? stamp : null);
    if (historicalSource) {
      await context.env.DB
        .prepare(
          `DELETE FROM repo_tracking_periods
           WHERE org_id = ? AND repo = ? AND ended_reason = 'historical_source'`,
        )
        .bind(orgId, cursor)
        .run();
    }
    await context.env.DB
      .prepare(
        `INSERT INTO repo_tracking_periods
           (org_id, repo, tracked_from, tracked_until, ended_reason)
         SELECT ?, ?, ?, ?, ?
         WHERE NOT EXISTS (
           SELECT 1 FROM repo_tracking_periods
           WHERE org_id = ? AND repo = ?
         )`,
      )
      .bind(
        orgId,
        cursor,
        activityBounds.first_seen,
        trackedUntil,
        historicalSource
          ? "historical_source"
          : project?.archived
            ? "platform_archived"
            : transferred
              ? "transferred"
              : null,
        orgId,
        cursor,
      )
      .run();
  }

  if (historicalSource) {
    // A previously completed source audit covered only the primary GitHub
    // organization. Mark it stale so the UI never claims the newly-combined
    // total was GitHub-verified against an incomplete source set.
    await context.env.DB
      .prepare(
        `UPDATE github_stats_audit_requests
         SET status = 'stale'
         WHERE org_id = ? AND status = 'completed'`,
      )
      .bind(orgId)
      .run();
  }

  return jsonResponse({
    done: true,
    repo: cursor,
    recovered: true,
    sourceOrg,
    transferredTo: transferred ? currentOwner : null,
  });
}

export const recoveryInternals = { listOrganizationRepos };
