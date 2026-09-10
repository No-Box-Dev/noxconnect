import { getSyncState, setSyncState } from "./db";
import { filterInactive, getNoxTicketRepoName } from "./inactive-repos";
import { getInstallationToken } from "./github-app";
import { upsertGhUser } from "./gh-mirror";
import { hasNoxTicketLabel, NOXTICKET_LABEL, upsertFeatureRow } from "./feature-issues";
import { LEGACY_NOXTICKET_LABEL } from "./naming-compat.js";
import { startRepoTracking, stopRepoTracking } from "./repo-tracking";

// Paginated GitHub API fetcher.
// MAX_PAGES caps any single resource sync at 5000 items (50 pages × 100/page).
// The number is a Cloudflare Worker CPU-budget guard: at 50ms/page (cold cache,
// GH p99) a 50-page sync stays well under the 30s Pages Functions limit. Bump
// only if you also split the call across multiple invocations.
const MAX_PAGES = 50;

async function fetchAllPages(token, url, params = {}, emptyStatuses = []) {
  const all = [];
  let page = 1;

  while (page <= MAX_PAGES) {
    const searchParams = new URLSearchParams({
      ...params,
      per_page: "100",
      page: String(page),
    });

    const res = await fetch(`${url}?${searchParams}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "NoxConnect",
        Accept: "application/vnd.github+json",
      },
    });

    if (!res.ok) {
      if (emptyStatuses.includes(res.status)) return all;
      if (res.status === 401) {
        throw new Error("GitHub token expired or revoked");
      }
      if (res.status === 429 || (res.status === 403 && res.headers.get("X-RateLimit-Remaining") === "0")) {
        const resetEpoch = res.headers.get("X-RateLimit-Reset");
        const resetInfo = resetEpoch
          ? ` Resets at ${new Date(Number(resetEpoch) * 1000).toISOString()}`
          : "";
        throw new Error(`GitHub API rate limit exceeded.${resetInfo}`);
      }
      // Everything else — permissions 403, 404, transient 5xx — throw rather
      // than break-with-empty-result. Returning [] here was the cause of
      // cascade-deletes when a single 403/404 made the reconciler think
      // "GitHub has zero repos / members / features" and wipe D1. Callers
      // that legitimately tolerate "missing resource" (e.g. syncTeams on a
      // user-as-org) wrap the call in try/catch and choose to swallow.
      throw new Error(`GitHub API error: ${res.status} ${res.statusText} (${url})`);
    }

    const data = await res.json();
    all.push(...data);

    if (data.length < 100) break;
    page++;
  }

  return all;
}

async function installationAccountType(db, accountLogin) {
  const installation = await db
    .prepare(
      `SELECT account_type FROM installations
       WHERE lower(account_login) = lower(?)
       ORDER BY updated_at DESC LIMIT 1`,
    )
    .bind(accountLogin)
    .first();
  return String(installation?.account_type ?? "").toLowerCase();
}

async function fetchInstallationRepositories(token) {
  const all = [];
  let page = 1;
  while (page <= MAX_PAGES) {
    const params = new URLSearchParams({ per_page: "100", page: String(page) });
    const res = await fetch(`https://api.github.com/installation/repositories?${params}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "NoxConnect",
        Accept: "application/vnd.github+json",
      },
    });
    if (!res.ok) {
      if (res.status === 401) throw new Error("GitHub token expired or revoked");
      if (res.status === 429 || (res.status === 403 && res.headers.get("X-RateLimit-Remaining") === "0")) {
        throw new Error("GitHub API rate limit exceeded");
      }
      throw new Error(`GitHub API error: ${res.status} ${res.statusText} (/installation/repositories)`);
    }
    const data = await res.json();
    const repositories = Array.isArray(data?.repositories) ? data.repositories : [];
    all.push(...repositories);
    if (repositories.length < 100) break;
    page++;
  }
  return all;
}

// ---------- Sync repos ----------

export async function syncRepos(db, token, orgId, orgLogin) {
  const accountType = await installationAccountType(db, orgLogin);
  const repos = accountType === "user"
    ? await fetchInstallationRepositories(token)
    : await fetchAllPages(
        token,
        `https://api.github.com/orgs/${orgLogin}/repos`,
        { sort: "pushed" },
      );

  // Capture which (org_id, name) pairs are NEW so we can apply the
  // newRepoDefault='exclude' policy below — D1 doesn't expose RETURNING and
  // we need this anyway for the cheap "did we just discover anything?" check.
  // Reading existing names up front is one extra query but keeps the upsert
  // loop simple and idempotent.
  const existingRows = await db
    .prepare("SELECT name FROM repos WHERE org_id = ?")
    .bind(orgId)
    .all();
  const existingNames = new Set(
    (existingRows.results ?? []).map((r) => r.name),
  );
  const newlyDiscovered = repos
    .map((r) => r.name)
    .filter((n) => !existingNames.has(n));

  const stmt = db.prepare(
    `INSERT INTO repos (org_id, name, language, pushed_at, discovered_at)
     VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
     ON CONFLICT(org_id, name) DO UPDATE SET
       language = excluded.language,
       pushed_at = excluded.pushed_at,
       discovered_at = COALESCE(repos.discovered_at, excluded.discovered_at),
       retired_at = NULL,
       retirement_reason = NULL,
       transferred_to = NULL`
  );

  for (let i = 0; i < repos.length; i += 50) {
    const batch = repos.slice(i, i + 50);
    await db.batch(
      batch.map((r) => stmt.bind(orgId, r.name, r.language, r.pushed_at))
    );
  }

  if (newlyDiscovered.length > 0) {
    await applyNewRepoPolicy(db, orgLogin, newlyDiscovered);
  }

  // Open a durable history period for every currently-active repository.
  // Auto-excluded discoveries are filtered out by the same central policy
  // used by read endpoints, so they never acquire a false tracking period.
  const visibleNames = repos.map((r) => r.name);
  const activeNames = await filterInactive(db, orgId, orgLogin, visibleNames);
  for (const name of activeNames) {
    await startRepoTracking(db, orgId, name);
  }

  await setSyncState(db, orgId, "repos");

  return repos.map((r) => r.name);
}

// When settings.newRepoDefault === 'exclude', stamp each freshly-discovered
// repo as platform-archived so it doesn't appear in any active scope until an
// admin opts in via the "Newly detected" Settings section. Mirrors the row
// shape that POST /api/projects/:id/archive would write, so the existing
// unarchive endpoint can flip it back cleanly. INSERT OR IGNORE protects
// against races with the events.js / projects.js auto-registration paths.
async function applyNewRepoPolicy(db, orgLogin, newRepoNames) {
  const settingsRow = await db
    .prepare("SELECT data FROM config WHERE org_id = (SELECT id FROM orgs WHERE github_login = ?) AND key = 'settings'")
    .bind(orgLogin)
    .first();
  if (!settingsRow?.data) return;
  let policy;
  try {
    policy = JSON.parse(settingsRow.data)?.newRepoDefault;
  } catch (err) {
    // Corrupt settings is surfaced loudly elsewhere (getInactiveRepoSet
    // throws on the same row). Log here so this sync-time path doesn't
    // silently treat a broken row as "include" by default — matches the
    // CLAUDE.md "Handle errors explicitly / No silent fallbacks" rule.
    console.warn(`[noxconnect sync] Corrupt settings JSON for org ${orgLogin} — skipping new-repo policy:`, err?.message ?? err);
    return;
  }
  if (policy !== "exclude") return;

  const stmt = db.prepare(
    `INSERT INTO projects (id, name, org, repo, owner_id, archived, archived_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
     ON CONFLICT(id) DO UPDATE SET
       archived = 1,
       archived_at = COALESCE(projects.archived_at, excluded.archived_at),
       updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`
  );
  await db.batch(
    newRepoNames.map((name) => {
      const projectId = `proj_${orgLogin}_${name}`.toLowerCase();
      return stmt.bind(projectId, name, orgLogin, name, orgLogin);
    }),
  );
}

// ---------- Sync PRs ----------

export async function syncPRs(db, token, orgId, orgLogin, repo, since, env = null) {
  const params = {
    state: "all",
    sort: "updated",
    direction: "desc",
  };
  if (since) params.since = since;

  const prs = await fetchAllPages(
    token,
    `https://api.github.com/repos/${orgLogin}/${repo}/pulls`,
    params
  );

  const stmt = db.prepare(
    `INSERT INTO pull_requests (org_id, repo, number, title, state, author, author_avatar, draft, head_ref, head_sha, base_ref, merged_at, created_at, updated_at, html_url, requested_reviewers_json, labels_json, merged_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(org_id, repo, number) DO UPDATE SET
       title = excluded.title,
       state = excluded.state,
       author = excluded.author,
       author_avatar = excluded.author_avatar,
       draft = excluded.draft,
       head_ref = excluded.head_ref,
       head_sha = excluded.head_sha,
       base_ref = excluded.base_ref,
       merged_at = excluded.merged_at,
       updated_at = excluded.updated_at,
       html_url = excluded.html_url,
       requested_reviewers_json = excluded.requested_reviewers_json,
       labels_json = excluded.labels_json,
       merged_by = COALESCE(excluded.merged_by, pull_requests.merged_by)`
  );

  for (let i = 0; i < prs.length; i += 50) {
    const batch = prs.slice(i, i + 50);
    await db.batch(
      batch.map((pr) =>
        stmt.bind(
          orgId,
          repo,
          pr.number,
          pr.title,
          pr.merged_at ? "merged" : pr.state,
          pr.user?.login ?? null,
          pr.user?.avatar_url ?? null,
          pr.draft ? 1 : 0,
          pr.head?.ref ?? null,
          pr.head?.sha ?? null,
          pr.base?.ref ?? null,
          pr.merged_at,
          pr.created_at,
          pr.updated_at,
          pr.html_url,
          JSON.stringify(pr.requested_reviewers?.map((r) => ({ login: r.login })) ?? []),
          JSON.stringify(pr.labels?.map((l) => ({ name: l.name, color: l.color })) ?? []),
          pr.merged_by?.login ?? null
        )
      )
    );
  }

  // Mirror PR authors into gh_users so the cron's missed-merge narration
  // path can resolve login → user_id (resolveActorFromGithub requires id).
  // Webhook handlers already upsert; this fills the gap for PRs that only
  // ever arrive via the sync API (e.g. a missed webhook delivery).
  const seenUserIds = new Set();
  for (const pr of prs) {
    if (!pr.user?.id || seenUserIds.has(pr.user.id)) continue;
    seenUserIds.add(pr.user.id);
    try {
      await upsertGhUser(db, {
        id: pr.user.id,
        login: pr.user.login,
        avatar_url: pr.user.avatar_url ?? null,
        type: pr.user.type === "Bot" ? "Bot" : "User",
        name: null,
      });
    } catch (err) {
      console.error("[noxconnect sync] upsertGhUser failed:", err?.message ?? err);
    }
  }

  // Register PR authors as members so they appear in the People page.
  // Bots (Dependabot, Renovate, etc.) are never GitHub org members,
  // so this is the only path that adds them.
  const seenAuthorLogins = new Set();
  for (const pr of prs) {
    if (!pr.user?.login || seenAuthorLogins.has(pr.user.login)) continue;
    seenAuthorLogins.add(pr.user.login);
    try {
      await upsertMember(db, orgId, pr.user, pr.user.type === "Bot" ? "bot" : "human");
    } catch (err) {
      console.error("[noxconnect sync] upsertMember from PR author failed:", err?.message ?? err);
    }
  }

  // Only advance sync timestamp if we got data or this is a fresh sync
  if (prs.length > 0 || !since) {
    await setSyncState(db, orgId, `prs:${repo}`);
  }
}

// ---------- Sync default-branch commits ----------

export async function syncCommits(db, token, orgId, orgLogin, repo, since) {
  const params = {};
  if (since) params.since = since;

  const commits = await fetchAllPages(
    token,
    `https://api.github.com/repos/${orgLogin}/${repo}/commits`,
    params,
    [409],
  );

  // Fresh backfill (no `since` cursor → force sync OR first-ever sync
  // of this repo): wipe existing rows before re-inserting. This scrubs
  // historical non-default-branch commits that landed via the pre-fix
  // webhook path. Delete AFTER the fetch succeeds so a network failure
  // doesn't leave the table empty. On a first-ever sync there are no
  // rows to delete, so the DELETE is a cheap no-op.
  if (!since) {
    await db
      .prepare("DELETE FROM github_commits WHERE org_id = ? AND repo = ?")
      .bind(orgId, repo)
      .run();
  }

  const stmt = db.prepare(
    `INSERT INTO github_commits
       (org_id, repo, sha, author, author_avatar, authored_at, committed_at, html_url, message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(org_id, repo, sha) DO UPDATE SET
       author = excluded.author,
       author_avatar = excluded.author_avatar,
       authored_at = excluded.authored_at,
       committed_at = excluded.committed_at,
       html_url = excluded.html_url,
       message = excluded.message`,
  );

  for (let i = 0; i < commits.length; i += 50) {
    await db.batch(
      commits.slice(i, i + 50).map((commit) =>
        stmt.bind(
          orgId,
          repo,
          commit.sha,
          commit.author?.login ?? null,
          commit.author?.avatar_url ?? null,
          commit.commit?.author?.date ?? null,
          commit.commit?.committer?.date ?? null,
          commit.html_url ?? null,
          commit.commit?.message?.slice(0, 500) ?? null,
        )),
    );
  }

  await setSyncState(db, orgId, `commits:${repo}`);
  return commits.length;
}

// ---------- Sync Issues ----------

export async function syncIssues(db, token, orgId, orgLogin, repo, since) {
  const params = {
    state: "all",
    sort: "updated",
    direction: "desc",
  };
  if (since) params.since = since;

  const allItems = await fetchAllPages(
    token,
    `https://api.github.com/repos/${orgLogin}/${repo}/issues`,
    params
  );

  const issues = allItems.filter((i) => !i.pull_request);

  // Fetch closed_by for closed issues that don't already have it in D1.
  // For incremental syncs, skip this — webhooks already capture closed_by.
  // Only fetch events for issues missing closed_by during full syncs.
  const closedByMap = new Map();
  if (!since) {
    // Full sync: check which closed issues are missing closed_by in D1
    const closedIssues = issues.filter((i) => i.state === "closed");
    if (closedIssues.length > 0) {
      const existingClosedBy = await db
        .prepare(
          `SELECT number, closed_by FROM issues WHERE org_id = ? AND repo = ? AND closed_by IS NOT NULL`
        )
        .bind(orgId, repo)
        .all();
      const knownClosedBy = new Set(existingClosedBy.results.map((r) => r.number));

      const missingClosedBy = closedIssues.filter((i) => !knownClosedBy.has(i.number));
      const BATCH_SIZE = 20;
      for (let i = 0; i < missingClosedBy.length; i += BATCH_SIZE) {
        const batch = missingClosedBy.slice(i, i + BATCH_SIZE);
        const results = await Promise.allSettled(
          batch.map(async (issue) => {
            const eventsRes = await fetch(
              `https://api.github.com/repos/${orgLogin}/${repo}/issues/${issue.number}/events?per_page=100`,
              {
                headers: {
                  Authorization: `Bearer ${token}`,
                  "User-Agent": "NoxConnect",
                  Accept: "application/vnd.github+json",
                },
              }
            );
            if (!eventsRes.ok) return { number: issue.number, login: null };
            let events;
            try {
              events = await eventsRes.json();
            } catch {
              console.error(`[noxconnect] Failed to parse events JSON for issue #${issue.number}`);
              return { number: issue.number, login: null };
            }
            const closedEvent = events.filter((e) => e.event === "closed").pop();
            return { number: issue.number, login: closedEvent?.actor?.login ?? null };
          })
        );
        for (const result of results) {
          if (result.status === "fulfilled" && result.value.login) {
            closedByMap.set(result.value.number, result.value.login);
          }
        }
      }
    }
  }

  const stmt = db.prepare(
    `INSERT INTO issues (org_id, repo, number, title, state, author, author_avatar, created_at, updated_at, closed_at, html_url, assignees_json, labels_json, milestone_title, closed_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(org_id, repo, number) DO UPDATE SET
       title = excluded.title,
       state = excluded.state,
       author = excluded.author,
       author_avatar = excluded.author_avatar,
       updated_at = excluded.updated_at,
       closed_at = excluded.closed_at,
       html_url = excluded.html_url,
       assignees_json = excluded.assignees_json,
       labels_json = excluded.labels_json,
       milestone_title = excluded.milestone_title,
       closed_by = COALESCE(excluded.closed_by, issues.closed_by)`
  );

  for (let i = 0; i < issues.length; i += 50) {
    const batch = issues.slice(i, i + 50);
    await db.batch(
      batch.map((issue) =>
        stmt.bind(
          orgId,
          repo,
          issue.number,
          issue.title,
          issue.state,
          issue.user?.login ?? null,
          issue.user?.avatar_url ?? null,
          issue.created_at,
          issue.updated_at,
          issue.closed_at,
          issue.html_url,
          JSON.stringify(issue.assignees.map((a) => ({ login: a.login, avatar_url: a.avatar_url }))),
          JSON.stringify(issue.labels.map((l) => ({ name: l.name, color: l.color }))),
          issue.milestone?.title ?? null,
          closedByMap.get(issue.number) ?? null
        )
      )
    );
  }

  // Reconcile: on a full sync the GitHub response is the authoritative list.
  // Delete D1 rows for issues GitHub no longer returns — those were
  // transferred to another repo or deleted, and were leaving phantom
  // "open" rows that skewed the by-repo chart.
  if (!since) {
    const fetchedNumbers = new Set(issues.map((i) => i.number));
    const existing = await db
      .prepare("SELECT number FROM issues WHERE org_id = ? AND repo = ?")
      .bind(orgId, repo)
      .all();
    const stale = existing.results
      .map((r) => r.number)
      .filter((n) => !fetchedNumbers.has(n));
    if (stale.length > 0) {
      const CHUNK = 90;
      for (let i = 0; i < stale.length; i += CHUNK) {
        const chunk = stale.slice(i, i + CHUNK);
        const placeholders = chunk.map(() => "?").join(", ");
        await db
          .prepare(`DELETE FROM issues WHERE org_id = ? AND repo = ? AND number IN (${placeholders})`)
          .bind(orgId, repo, ...chunk)
          .run();
      }
      console.log(`[noxconnect] syncIssues: deleted ${stale.length} stale issues from D1 for ${repo}`);
    }
  }

  // Only advance sync timestamp if we got data or this is a fresh sync
  if (issues.length > 0 || !since) {
    await setSyncState(db, orgId, `issues:${repo}`);
  }
}

// ---------- Sync Members ----------

export async function syncMembers(db, token, orgId, orgLogin) {
  const accountType = await installationAccountType(db, orgLogin);
  if (accountType === "user") {
    await db.prepare(
      `INSERT INTO members (org_id, login, avatar_url, kind)
       VALUES (?, ?, NULL, 'human')
       ON CONFLICT(org_id, login) DO NOTHING`,
    ).bind(orgId, orgLogin).run();
    await setSyncState(db, orgId, "members");
    return [orgLogin];
  }
  const members = await fetchAllPages(
    token,
    `https://api.github.com/orgs/${orgLogin}/members`
  );

  const stmt = db.prepare(
    `INSERT INTO members (org_id, login, avatar_url, kind)
     VALUES (?, ?, ?, 'human')
     ON CONFLICT(org_id, login) DO UPDATE SET
       avatar_url = excluded.avatar_url`
  );

  for (let i = 0; i < members.length; i += 50) {
    const batch = members.slice(i, i + 50);
    await db.batch(
      batch.map((m) => stmt.bind(orgId, m.login, m.avatar_url))
    );
  }

  await setSyncState(db, orgId, "members");

  return members.map((m) => m.login);
}

// ---------- Sync Teams ----------
//
// Full reconcile each tick: GitHub orgs rarely have >100 teams, and per-team
// member lists are short. Deletions are handled by clearing rows for teams
// no longer in the API response. Errors are swallowed (403/404 = the
// installation lacks the `members:read` permission, or the org is a user).

export async function syncTeams(db, token, orgId, orgLogin) {
  let teams;
  try {
    teams = await fetchAllPages(token, `https://api.github.com/orgs/${orgLogin}/teams`);
  } catch (err) {
    console.error(`[noxconnect sync] syncTeams ${orgLogin} failed:`, err?.message ?? err);
    return [];
  }

  const teamRows = teams.map((t) => ({ id: t.id, slug: t.slug, name: t.name }));

  const teamStmt = db.prepare(
    `INSERT INTO teams (org_id, github_id, slug, name, updated_at)
     VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
     ON CONFLICT(org_id, github_id) DO UPDATE SET
       slug = excluded.slug,
       name = excluded.name,
       updated_at = excluded.updated_at`
  );

  if (teamRows.length > 0) {
    await db.batch(teamRows.map((t) => teamStmt.bind(orgId, t.id, t.slug, t.name)));
  }

  const keepIds = new Set(teamRows.map((t) => t.id));
  const existing = await db
    .prepare("SELECT github_id FROM teams WHERE org_id = ?")
    .bind(orgId)
    .all();
  const toDelete = (existing.results ?? [])
    .map((r) => r.github_id)
    .filter((id) => !keepIds.has(id));
  if (toDelete.length > 0) {
    const placeholders = toDelete.map(() => "?").join(",");
    await db.batch([
      db.prepare(`DELETE FROM teams WHERE org_id = ? AND github_id IN (${placeholders})`).bind(orgId, ...toDelete),
      db.prepare(`DELETE FROM team_memberships WHERE org_id = ? AND team_github_id IN (${placeholders})`).bind(orgId, ...toDelete),
    ]);
  }

  const membershipStmt = db.prepare(
    `INSERT INTO team_memberships (org_id, team_github_id, login)
     VALUES (?, ?, ?)
     ON CONFLICT(org_id, team_github_id, login) DO NOTHING`
  );

  for (const team of teamRows) {
    let members;
    try {
      members = await fetchAllPages(
        token,
        `https://api.github.com/orgs/${orgLogin}/teams/${team.slug}/members`,
      );
    } catch (err) {
      console.error(`[noxconnect sync] syncTeams members ${team.slug} failed:`, err?.message ?? err);
      continue;
    }

    const seenLogins = new Set(members.map((m) => m.login).filter(Boolean));

    if (members.length > 0) {
      const ops = members
        .filter((m) => m.login)
        .map((m) => membershipStmt.bind(orgId, team.id, m.login));
      for (let i = 0; i < ops.length; i += 50) {
        await db.batch(ops.slice(i, i + 50));
      }
    }

    const existingMembers = await db
      .prepare("SELECT login FROM team_memberships WHERE org_id = ? AND team_github_id = ?")
      .bind(orgId, team.id)
      .all();
    const staleLogins = (existingMembers.results ?? [])
      .map((r) => r.login)
      .filter((login) => !seenLogins.has(login));
    if (staleLogins.length > 0) {
      const ph = staleLogins.map(() => "?").join(",");
      await db
        .prepare(`DELETE FROM team_memberships WHERE org_id = ? AND team_github_id = ? AND login IN (${ph})`)
        .bind(orgId, team.id, ...staleLogins)
        .run();
    }
  }

  await setSyncState(db, orgId, "teams");

  return teamRows.map((t) => t.slug);
}

// Webhook helpers — call from the team / membership webhook handlers.

export async function upsertTeam(db, orgId, team) {
  if (!team?.id) return;
  await db
    .prepare(
      `INSERT INTO teams (org_id, github_id, slug, name, updated_at)
       VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
       ON CONFLICT(org_id, github_id) DO UPDATE SET
         slug = excluded.slug,
         name = excluded.name,
         updated_at = excluded.updated_at`
    )
    .bind(orgId, team.id, team.slug, team.name)
    .run();
}

export async function removeTeam(db, orgId, githubId) {
  if (!githubId) return;
  await db.batch([
    db.prepare("DELETE FROM teams WHERE org_id = ? AND github_id = ?").bind(orgId, githubId),
    db.prepare("DELETE FROM team_memberships WHERE org_id = ? AND team_github_id = ?").bind(orgId, githubId),
  ]);
}

export async function addTeamMember(db, orgId, teamGithubId, login) {
  if (!teamGithubId || !login) return;
  await db
    .prepare(
      `INSERT INTO team_memberships (org_id, team_github_id, login)
       VALUES (?, ?, ?)
       ON CONFLICT(org_id, team_github_id, login) DO NOTHING`
    )
    .bind(orgId, teamGithubId, login)
    .run();
}

export async function removeTeamMember(db, orgId, teamGithubId, login) {
  if (!teamGithubId || !login) return;
  await db
    .prepare(
      "DELETE FROM team_memberships WHERE org_id = ? AND team_github_id = ? AND login = ?"
    )
    .bind(orgId, teamGithubId, login)
    .run();
}

// ---------- Sync Features (noxconnect repo issues) ----------
//
// Bidirectional last-write-wins reconcile against {org}/noxconnect.
//
// Each feature row carries two timestamps:
//   - updated_at    — when the row was last written (by anyone)
//   - gh_synced_at  — the GitHub `updated_at` we mirrored in last
//
// Compare the GH issue's updated_at against those:
//   - row missing                          → PULL (insert from GH)
//   - gh_synced_at IS NULL                 → PULL (legacy / first-touch)
//   - gh.updated_at  >  gh_synced_at       → PULL (GH advanced upstream)
//   - d1.updated_at  >  gh_synced_at AND
//     gh.updated_at  == gh_synced_at       → PUSH (local change, GH still stale)
//   - both advanced                        → LWW: pick the larger of
//                                             gh.updated_at and d1.updated_at
//   - else                                 → no-op (in sync)
//
// This is the safety net for the optimistic PATCH in
// functions/api/features/[number].js — when its inline waitUntil GitHub call
// fails (auth, missing label, rate limit, isolate eviction), the next cron
// tick will push the pending D1 change instead of clobbering it with GitHub's
// stale state.

export async function syncFeatures(db, token, orgId, orgLogin) {
  const noxTicketRepo = await getNoxTicketRepoName(db, orgId);
  const issues = await fetchAllPages(
    token,
    `https://api.github.com/repos/${encodeURIComponent(orgLogin)}/${encodeURIComponent(noxTicketRepo)}/issues`,
    { state: "all", sort: "updated", direction: "desc" }
  );

  const legacyFeatures = issues.filter((issue) => {
    if (issue.pull_request) return false;
    const names = (issue.labels ?? []).map((label) =>
      String(typeof label === "string" ? label : label?.name ?? "").toLowerCase());
    return names.includes(LEGACY_NOXTICKET_LABEL)
      && !names.includes(NOXTICKET_LABEL)
      && names.includes("feature");
  });
  if (legacyFeatures.length > 0) {
    await ensureCanonicalNoxTicketLabel(token, orgLogin, noxTicketRepo);
    for (const issue of legacyFeatures) {
      const labels = (issue.labels ?? [])
        .map((label) => typeof label === "string" ? label : label?.name)
        .filter(Boolean)
        .filter((name) => String(name).toLowerCase() !== LEGACY_NOXTICKET_LABEL);
      labels.unshift(NOXTICKET_LABEL);
      try {
        await ghFetch(
          `https://api.github.com/repos/${encodeURIComponent(orgLogin)}/${encodeURIComponent(noxTicketRepo)}/issues/${issue.number}`,
          { method: "PATCH", body: JSON.stringify({ labels: [...new Set(labels)] }) },
          token,
        );
        issue.labels = [...new Set(labels)].map((name) => ({ name, color: "" }));
      } catch (error) {
        console.warn(`[noxticket] label migration failed for #${issue.number}:`, error?.message ?? error);
      }
    }
  }

  // Only sync issues that carry a current/legacy NoxTicket label and "feature"
  // (filter out PRs, todos, roles, tasks, and legacy single-label items).
  const features = issues.filter((i) => {
    if (i.pull_request) return false;
    const names = (i.labels ?? []).map((l) => (typeof l === "string" ? l : l.name));
    return hasNoxTicketLabel(names) && names.includes("feature");
  });

  console.log(`[noxconnect] syncFeatures: ${issues.length} total issues, ${features.length} features (org=${orgLogin})`);

  if (features.length === 0 && issues.length > 0) {
    console.warn(`[noxconnect] syncFeatures: ${issues.length} issues but 0 features — all PRs? (org=${orgLogin})`);
  }

  // Load existing D1 rows once so the per-feature reconcile doesn't hit D1
  // n+1 times. Feature counts are small (<100) — this is cheaper than
  // selecting per-issue, and we need the full set anyway for the prune pass.
  const existingRes = await db
    .prepare(
      "SELECT number, title, state, body, assignees_json, labels_json, milestone_title, html_url, created_at, updated_at, gh_synced_at FROM features WHERE org_id = ?",
    )
    .bind(orgId)
    .all();
  const existing = new Map((existingRes.results ?? []).map((r) => [r.number, r]));

  let pulled = 0;
  let pushed = 0;
  let pushFailed = 0;
  let inSync = 0;

  for (const ghIssue of features) {
    const d1 = existing.get(ghIssue.number);
    const decision = decideReconcileAction(d1, ghIssue);

    if (decision === "pull") {
      await upsertFeatureRow(db, orgId, ghIssue, { from: "github" });
      pulled += 1;
    } else if (decision === "push") {
      try {
        const updatedGhIssue = await pushFeatureToGitHub(token, orgLogin, noxTicketRepo, d1);
        await upsertFeatureRow(db, orgId, updatedGhIssue, { from: "github" });
        pushed += 1;
      } catch (err) {
        // The push failed — leave the local change in place so the next
        // tick can retry. Don't pull GitHub's stale state in either, that
        // would defeat the whole point of the LWW guard.
        console.error(
          `[noxconnect] syncFeatures push failed for #${ghIssue.number}:`,
          err?.status,
          err?.message,
          err?.ghBody,
        );
        pushFailed += 1;
      }
    } else {
      inSync += 1;
    }
  }

  await setSyncState(db, orgId, "features");

  // Reconcile deletes: drop any open rows whose issue number isn't in the
  // current GitHub feature set. Includes legacy rows synced from earlier
  // repo sources.
  const featureNumbers = new Set(features.map((f) => f.number));
  const toDelete = [];
  for (const [num, row] of existing.entries()) {
    if (!featureNumbers.has(num) && row.state === "open") toDelete.push(num);
  }
  if (toDelete.length > 0) {
    console.log(`[noxconnect] syncFeatures: cleaning up ${toDelete.length} stale features from D1 (org=${orgLogin})`);
    for (let i = 0; i < toDelete.length; i += 50) {
      const batch = toDelete.slice(i, i + 50);
      await db.batch(
        batch.map((num) =>
          db.prepare("DELETE FROM features WHERE org_id = ? AND number = ?").bind(orgId, num)
        )
      );
    }
  }

  console.log(
    `[noxconnect] syncFeatures done: pulled=${pulled} pushed=${pushed} pushFailed=${pushFailed} inSync=${inSync} pruned=${toDelete.length}`,
  );

  return { synced: features.length, total: issues.length, pulled, pushed, pushFailed, inSync };
}

async function ensureCanonicalNoxTicketLabel(token, orgLogin, repo) {
  try {
    await ghFetch(
      `https://api.github.com/repos/${encodeURIComponent(orgLogin)}/${encodeURIComponent(repo)}/labels`,
      {
        method: "POST",
        body: JSON.stringify({ name: NOXTICKET_LABEL, color: "1B6971", description: "Tracked by NoxTicket" }),
      },
      token,
    );
  } catch (error) {
    if (error?.status !== 422) throw error;
  }
}

// Decide which side of the LWW reconcile to apply for one feature. Pure
// function, exported for unit-testability.
//
// Returns "pull" | "push" | "noop".
//
// Timestamps are parsed to ms before comparison: GitHub serializes
// `updated_at` to second precision (`...:00Z`), while local writes via
// `new Date().toISOString()` always include ms (`...:00.123Z`). A naive
// string compare puts `.123Z` < `Z` lexicographically and would drop a
// same-second local edit.
export function decideReconcileAction(d1Row, ghIssue) {
  if (!d1Row) return "pull";

  const ghUpdated = parseTs(ghIssue.updated_at);
  const ghSyncedAt = parseTs(d1Row.gh_synced_at);
  const d1Updated = parseTs(d1Row.updated_at);

  // Legacy rows from before migration 0025 won't have gh_synced_at — treat
  // as GH-wins (the safe direction since we have no proof of local edits).
  if (ghSyncedAt === null) return "pull";

  const ghAdvanced = ghUpdated !== null && ghUpdated > ghSyncedAt;
  const d1Advanced = d1Updated !== null && d1Updated > ghSyncedAt;

  if (ghAdvanced && d1Advanced) {
    // Both sides moved since last mirror. Pick the side with the larger
    // updated_at. Ties go to GitHub (source-of-truth tiebreaker).
    return ghUpdated >= d1Updated ? "pull" : "push";
  }
  if (ghAdvanced) return "pull";
  if (d1Advanced) return "push";
  return "noop";
}

function parseTs(ts) {
  if (!ts) return null;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : null;
}

// Push the local D1 state of one feature to GitHub. Returns the updated
// GitHub issue payload so the caller can re-mirror it with gh_synced_at set.
//
// Uses GitHub's issue PATCH directly (no dependency on feature-issues.js so
// we don't create an import cycle from sync → api → sync). The body shape
// matches what the API PATCH route sends.
async function pushFeatureToGitHub(token, orgLogin, noxTicketRepo, d1Row) {
  const labels = JSON.parse(d1Row.labels_json || "[]")
    .map((l) => (typeof l === "string" ? l : l?.name))
    .filter(Boolean);
  const assignees = JSON.parse(d1Row.assignees_json || "[]")
    .map((a) => a.login)
    .filter(Boolean);
  const payload = {
    title: d1Row.title,
    body: d1Row.body ?? "",
    labels,
    assignees,
    state: d1Row.state || "open",
  };
  const res = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(orgLogin)}/${encodeURIComponent(noxTicketRepo)}/issues/${d1Row.number}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "NoxConnect",
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body?.message || `GitHub ${res.status} ${res.statusText}`);
    err.status = res.status;
    err.ghBody = body;
    throw err;
  }
  return res.json();
}

// ---------- Migrate noxconnect config ----------

export async function migrateNoxTicketConfig(db, token, orgId, orgLogin) {
  const existing = await db
    .prepare("SELECT COUNT(*) as count FROM config WHERE org_id = ?")
    .bind(orgId)
    .first();

  if (existing && existing.count > 0) return;

  const repoRes = await fetch(
    `https://api.github.com/repos/${orgLogin}/noxconnect`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "NoxConnect",
      },
    }
  );

  if (!repoRes.ok) return;

  const files = ["features", "people", "settings"];

  for (const key of files) {
    const fileRes = await fetch(
      `https://api.github.com/repos/${orgLogin}/noxconnect/contents/${key}.json`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "User-Agent": "NoxConnect",
          Accept: "application/vnd.github+json",
        },
      }
    );

    if (!fileRes.ok) continue;

    const fileData = await fileRes.json();
    if (!fileData.content) continue;

    const decoded = atob(fileData.content.replace(/\n/g, ""));

    await db
      .prepare(
        `INSERT INTO config (org_id, key, data, updated_at)
         VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
         ON CONFLICT(org_id, key) DO UPDATE SET
           data = excluded.data,
           updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`
      )
      .bind(orgId, key, decoded)
      .run();
  }
}

// ---------- syncInit: lightweight init (repos + members + config migration) ----------

export async function syncInit(db, token, orgId, orgLogin) {
  await migrateNoxTicketConfig(db, token, orgId, orgLogin);
  await syncRepos(db, token, orgId, orgLogin);
  await syncMembers(db, token, orgId, orgLogin);
  await syncTeams(db, token, orgId, orgLogin);
  await syncFeatures(db, token, orgId, orgLogin);

  const repoRows = await db
    .prepare("SELECT name FROM repos WHERE org_id = ? ORDER BY name")
    .bind(orgId)
    .all();

  return repoRows.results.map((r) => r.name);
}

// ---------- bootstrapInstallation: full backfill on install webhook ----------
//
// Fired from the `installation` webhook when a new install (or unsuspend)
// arrives. Pulls everything we need for an empty dashboard so the user
// never has to click Sync. Marks `orgs.bootstrapped_at` on success; the
// dashboard polls this to switch from "setting up" to "ready".
//
// Pulls in dependency order: repos → members → features → per-repo issues+PRs.
// Per-repo work uses the existing incremental syncRepo (force=true to ensure
// a clean slate on first install). Reconciliation cron (Slice 3) catches any
// repos added later via installation_repositories.
export async function bootstrapInstallation(env, orgId, orgLogin, installationId) {
  const db = env.DB;
  const token = await getInstallationToken(env, installationId);

  await syncRepos(db, token, orgId, orgLogin);
  await syncMembers(db, token, orgId, orgLogin);
  await syncTeams(db, token, orgId, orgLogin);
  await syncFeatures(db, token, orgId, orgLogin);

  const repoRows = await db
    .prepare("SELECT name FROM repos WHERE org_id = ? ORDER BY name")
    .bind(orgId)
    .all();
  const repoNames = await filterInactive(
    db,
    orgId,
    orgLogin,
    repoRows.results.map((r) => r.name),
  );

  for (const repo of repoNames) {
    try {
      await syncRepo(db, token, orgId, orgLogin, repo, true, env);
    } catch (err) {
      // Don't abort the whole bootstrap on one bad repo — cron will retry.
      console.error(`[noxconnect] bootstrap repo ${repo} failed:`, err?.message ?? err);
    }
  }

  await db
    .prepare("UPDATE orgs SET bootstrapped_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?")
    .bind(orgId)
    .run();
}

// ---------- syncRepo: sync PRs + issues for a single repo ----------

export async function syncRepo(db, token, orgId, orgLogin, repo, force = false, env = null) {
  try {
    const prSince = force ? null : (await getSyncState(db, orgId, `prs:${repo}`))?.lastSynced;
    await syncPRs(db, token, orgId, orgLogin, repo, prSince, env);
  } catch (err) {
    console.error(`[noxconnect] syncRepo PRs failed for ${repo}:`, err?.message ?? err);
    throw err;
  }

  try {
    const issueSince = force ? null : (await getSyncState(db, orgId, `issues:${repo}`))?.lastSynced;
    await syncIssues(db, token, orgId, orgLogin, repo, issueSince);
  } catch (err) {
    console.error(`[noxconnect] syncRepo issues failed for ${repo}:`, err?.message ?? err);
    throw err;
  }

  try {
    const commitSince = force ? null : (await getSyncState(db, orgId, `commits:${repo}`))?.lastSynced;
    await syncCommits(db, token, orgId, orgLogin, repo, commitSince);
  } catch (err) {
    console.error(`[noxconnect] syncRepo commits failed for ${repo}:`, err?.message ?? err);
    throw err;
  }
}

// ---------- Upsert helpers for webhook events ----------

export async function upsertIssue(db, orgId, repo, issue, closedBy = null) {
  await db
    .prepare(
      `INSERT INTO issues (org_id, repo, number, title, state, author, author_avatar, created_at, updated_at, closed_at, html_url, assignees_json, labels_json, milestone_title, closed_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(org_id, repo, number) DO UPDATE SET
         title = excluded.title,
         state = excluded.state,
         author = excluded.author,
         author_avatar = excluded.author_avatar,
         updated_at = excluded.updated_at,
         closed_at = excluded.closed_at,
         html_url = excluded.html_url,
         assignees_json = excluded.assignees_json,
         labels_json = excluded.labels_json,
         milestone_title = excluded.milestone_title,
         closed_by = COALESCE(excluded.closed_by, issues.closed_by)`
    )
    .bind(
      orgId,
      repo,
      issue.number,
      issue.title,
      issue.state,
      issue.user?.login ?? null,
      issue.user?.avatar_url ?? null,
      issue.created_at,
      issue.updated_at,
      issue.closed_at ?? null,
      issue.html_url,
      JSON.stringify((issue.assignees ?? []).map((a) => ({ login: a.login, avatar_url: a.avatar_url }))),
      JSON.stringify((issue.labels ?? []).map((l) => ({ name: l.name, color: l.color }))),
      issue.milestone?.title ?? null,
      closedBy
    )
    .run();
}

export async function upsertFeature(db, orgId, issue) {
  // Only upsert if the issue carries a current/legacy NoxTicket label and "feature".
  const labels = (issue.labels ?? []).map((l) => (typeof l === "string" ? l : l.name));
  if (!hasNoxTicketLabel(labels) || !labels.includes("feature")) {
    // Not a feature — remove from features table if it was previously tracked
    await db.prepare("DELETE FROM features WHERE org_id = ? AND number = ?").bind(orgId, issue.number).run();
    return;
  }

  // Webhook deliveries are GitHub's own report of issue state, so they count
  // as "in sync with GitHub" — set gh_synced_at to the payload's updated_at
  // so the cron's LWW compare knows there's no pending local change.
  await upsertFeatureRow(db, orgId, issue, { from: "github" });
}

export async function upsertPR(db, orgId, repo, pr) {
  await db
    .prepare(
      `INSERT INTO pull_requests (org_id, repo, number, title, state, author, author_avatar, draft, head_ref, head_sha, base_ref, merged_at, created_at, updated_at, html_url, requested_reviewers_json, labels_json, merged_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(org_id, repo, number) DO UPDATE SET
         title = excluded.title,
         state = excluded.state,
         author = excluded.author,
         author_avatar = excluded.author_avatar,
         draft = excluded.draft,
         head_ref = excluded.head_ref,
         head_sha = excluded.head_sha,
         base_ref = excluded.base_ref,
         merged_at = excluded.merged_at,
         updated_at = excluded.updated_at,
         html_url = excluded.html_url,
         requested_reviewers_json = excluded.requested_reviewers_json,
         labels_json = excluded.labels_json,
         merged_by = COALESCE(excluded.merged_by, pull_requests.merged_by)`
    )
    .bind(
      orgId,
      repo,
      pr.number,
      pr.title,
      pr.merged ? "merged" : pr.state,
      pr.user?.login ?? null,
      pr.user?.avatar_url ?? null,
      pr.draft ? 1 : 0,
      pr.head?.ref ?? null,
      pr.head?.sha ?? null,
      pr.base?.ref ?? null,
      pr.merged_at ?? null,
      pr.created_at,
      pr.updated_at,
      pr.html_url,
      JSON.stringify((pr.requested_reviewers ?? []).map((r) => ({ login: r.login }))),
      JSON.stringify((pr.labels ?? []).map((l) => ({ name: l.name, color: l.color }))),
      pr.merged_by?.login ?? null
    )
    .run();
}

export async function upsertMember(db, orgId, member, kind = "human") {
  await db
    .prepare(
      `INSERT INTO members (org_id, login, avatar_url, kind)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(org_id, login) DO UPDATE SET
         avatar_url = excluded.avatar_url,
         kind = excluded.kind`
    )
    .bind(orgId, member.login, member.avatar_url ?? null, kind)
    .run();
}

export async function removeMember(db, orgId, login) {
  await db
    .prepare("DELETE FROM members WHERE org_id = ? AND login = ?")
    .bind(orgId, login)
    .run();
}

// Mark a repo as archived on GitHub. Keeps the row so historical issues/PRs
// remain joinable; UI is expected to filter on archived_at IS NULL.
export async function markRepoArchived(db, orgId, repo) {
  const stamp = new Date().toISOString();
  await db
    .prepare("UPDATE repos SET archived_at = ? WHERE org_id = ? AND name = ?")
    .bind(stamp, orgId, repo)
    .run();
  await stopRepoTracking(db, orgId, repo, "github_archived", stamp);
}

// Insert a single repo row stamped as just-discovered. Used by the
// `installation_repositories.added` webhook so a repo the admin grants the
// App access to surfaces in the "Newly detected" UI in seconds instead of
// waiting for the next 30-min cron syncRepos pass.
//
// Returns true when the row was newly inserted (the discovery is real),
// false when it already existed. Caller uses that signal to decide whether
// to run the auto-exclude policy.
//
// language and pushed_at are NULL on the webhook payload — the next
// syncRepos pass fills them in. discovered_at is preserved on conflict so a
// repo that was discovered by cron stays stamped with the cron timestamp
// when the webhook later replays the same row.
export async function upsertDiscoveredRepo(db, orgId, repoName) {
  const existing = await db
    .prepare("SELECT 1 AS present FROM repos WHERE org_id = ? AND name = ?")
    .bind(orgId, repoName)
    .first();
  const result = await db
    .prepare(
      `INSERT INTO repos (org_id, name, discovered_at)
       VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
       ON CONFLICT(org_id, name) DO UPDATE SET
         retired_at = NULL,
         retirement_reason = NULL,
         transferred_to = NULL`,
    )
    .bind(orgId, repoName)
    .run();
  return !existing && (result.meta?.changes ?? 0) > 0;
}

// Public re-export so the webhook can apply the same policy `syncRepos`
// applies when it discovers a repo. Mirrors the bulk-insert path.
export async function applyNewRepoExcludePolicy(db, orgLogin, newRepoNames) {
  if (!Array.isArray(newRepoNames) || newRepoNames.length === 0) return;
  await applyNewRepoPolicy(db, orgLogin, newRepoNames);
}

// Retire a repo without deleting its issues/PRs. GitHub deletes, transfers,
// and installation-access removals must remove it from current views while
// preserving the source rows that historical analytics depend on.
export async function removeRepo(db, orgId, repo, reason = "removed", transferredTo = null) {
  const stamp = new Date().toISOString();
  await db
    .prepare(
      `UPDATE repos
       SET retired_at = ?, retirement_reason = ?, transferred_to = ?
       WHERE org_id = ? AND name = ?`,
    )
    .bind(stamp, reason, transferredTo, orgId, repo)
    .run();
  await db
    .prepare(
      `UPDATE projects
       SET archived = 1,
           archived_at = COALESCE(archived_at, ?),
           updated_at = ?
       WHERE owner_id = (SELECT github_login FROM orgs WHERE id = ?)
         AND repo = ?`,
    )
    .bind(stamp, stamp, orgId, repo)
    .run();
  await stopRepoTracking(db, orgId, repo, reason, stamp);
}

// Rename a repo across every table that stores `repo` as plain text.
// GitHub's `repository.renamed` event carries `changes.repository.name.from`
// and the new name on `repository.name`. Doing the rename in place keeps
// history (issues, PRs) intact rather than dropping it and waiting for the
// next reconcile to refetch.
export async function renameRepo(db, orgId, fromName, toName) {
  if (!fromName || !toName || fromName === toName) return;
  await db.batch([
    db.prepare("UPDATE repos SET name = ? WHERE org_id = ? AND name = ?").bind(toName, orgId, fromName),
    db.prepare("UPDATE issues SET repo = ? WHERE org_id = ? AND repo = ?").bind(toName, orgId, fromName),
    db.prepare("UPDATE pull_requests SET repo = ? WHERE org_id = ? AND repo = ?").bind(toName, orgId, fromName),
    db.prepare("UPDATE repo_tracking_periods SET repo = ? WHERE org_id = ? AND repo = ?").bind(toName, orgId, fromName),
    db.prepare("UPDATE projects SET repo = ?, name = ? WHERE owner_id = (SELECT github_login FROM orgs WHERE id = ?) AND repo = ?")
      .bind(toName, toName, orgId, fromName),
  ]);
}

// Update repos.pushed_at from a `push` webhook so the repo list ordering
// (sort: pushed_at desc) stays accurate without waiting for a reconcile.
// ISO 8601 to match the format `syncRepos` copies from GitHub responses —
// mixing space and ISO formats in the same column breaks ORDER BY DESC.
export async function touchRepoPushed(db, orgId, repo) {
  await db
    .prepare(
      "UPDATE repos SET pushed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE org_id = ? AND name = ?"
    )
    .bind(orgId, repo)
    .run();
}
