// reconcileOrg — pull GitHub state into D1 for one org per cron tick.
//
// Webhooks already write to D1 in real time, so this is the safety net
// for everything webhooks structurally can't deliver: deletes (GitHub
// doesn't fire `repository.deleted` reliably for transferred repos,
// and member removal events can drop), missed deliveries during
// deploys, and label changes on issues created before the App was
// installed (those issues never get an `issues.labeled` event for
// pre-existing labels).
//
// This module imports the same sync helpers the Pages app uses.
// Wrangler bundles them via the relative path; no code is duplicated.

import {
  syncRepos,
  syncMembers,
  syncTeams,
  syncFeatures,
  syncPRs,
  syncIssues,
  removeRepo,
  removeMember,
} from "../../functions/lib/github-sync.js";
import { getInstallationToken } from "../../functions/lib/github-app.js";
import { getInactiveRepoSet } from "../../functions/lib/inactive-repos.js";
import { reconcileRepoEvents } from "../../functions/lib/event-reconcile.js";

// Look back this far when hunting for missed event rows (PR opens/closes/
// merges, issue opens/closes, reviews/pushes/releases). Long enough to
// cover a deploy gap or a 24h provider outage; short enough that we don't
// re-scan ancient history every tick.
const EVENT_RECONCILE_LOOKBACK_HOURS = 48;

// If an unfinished run started within this window, the cron skips the org
// to avoid two ticks racing. Picked just under the 30 min cron interval.
const LOCK_WINDOW_MIN = 25;

// An installation is flagged 'silent' if no webhook event arrived within
// this window AND reconcile saw nothing new on this tick.
const SILENT_THRESHOLD_HOURS = 24;

export async function reconcileOrg(env, db, orgId, orgLogin, installationId) {
  const lock = await acquireLock(db, orgId);
  if (!lock) {
    console.log(`[noxconnect-cron] org=${orgLogin} skipped: prior run still in flight`);
    return;
  }

  const startedAtMs = Date.now();

  try {
    const token = await getInstallationToken(env, installationId);

    // Members + features + repos: full reconcile (small N) detects deletes.
    const [apiMembers, apiRepos] = await Promise.all([
      syncMembers(db, token, orgId, orgLogin),
      syncRepos(db, token, orgId, orgLogin),
    ]);
    await reconcileDeletedMembers(db, orgId, apiMembers);
    await reconcileDeletedRepos(db, orgId, apiRepos);
    await syncTeams(db, token, orgId, orgLogin);

    // NoxTicket is optional. A missing/misconfigured ticket repository must
    // never stop the shared safety net before it reaches NoxFeed's PR sync.
    // Keep the failure visible in logs while allowing the rest of the org to
    // reconcile normally.
    try {
      await syncFeatures(db, token, orgId, orgLogin);
    } catch (err) {
      console.error(
        `[noxconnect-cron] org=${orgLogin} NoxTicket feature sync failed; continuing service reconcile:`,
        err?.message ?? err,
      );
    }

    // Issues + PRs per active repo with incremental `since` cursor.
    const inactive = await getInactiveRepoSet(db, orgId, orgLogin);
    const activeRepos = apiRepos.filter((name) => !inactive.has(name));
    for (const repo of activeRepos) {
      try {
        await syncPRs(db, token, orgId, orgLogin, repo, await sinceCursor(db, orgId, `prs:${repo}`), env);
      } catch (err) {
        console.error(`[noxconnect-cron] org=${orgLogin} repo=${repo} PRs failed:`, err?.message ?? err);
      }
      try {
        await syncIssues(db, token, orgId, orgLogin, repo, await sinceCursor(db, orgId, `issues:${repo}`));
      } catch (err) {
        console.error(`[noxconnect-cron] org=${orgLogin} repo=${repo} issues failed:`, err?.message ?? err);
      }
      try {
        await reconcileRepoEvents(env, db, {
          orgId,
          orgLogin,
          repo,
          token,
          lookbackHours: EVENT_RECONCILE_LOOKBACK_HOURS,
        });
      } catch (err) {
        console.error(`[noxconnect-cron] org=${orgLogin} repo=${repo} event reconcile failed:`, err?.message ?? err);
      }
    }

    await updateHealthStatus(db, orgId, installationId);

    await db
      .prepare(
        `UPDATE reconcile_runs
           SET finished_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), duration_ms = ?
         WHERE id = ?`,
      )
      .bind(Date.now() - startedAtMs, lock)
      .run();
  } catch (err) {
    await db
      .prepare(
        `UPDATE reconcile_runs
           SET finished_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), duration_ms = ?, error = ?
         WHERE id = ?`,
      )
      .bind(Date.now() - startedAtMs, String(err?.message ?? err).slice(0, 500), lock)
      .run();
    throw err;
  }
}

// Insert a reconcile_runs row with finished_at = NULL. Returns the row id
// (the lock token). Returns null if a prior unfinished run started within
// the last LOCK_WINDOW_MIN minutes — caller should skip the tick.
async function acquireLock(db, orgId) {
  const recent = await db
    .prepare(
      `SELECT id FROM reconcile_runs
        WHERE org_id = ?
          AND finished_at IS NULL
          AND started_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?)
        LIMIT 1`,
    )
    .bind(orgId, `-${LOCK_WINDOW_MIN} minutes`)
    .first();
  if (recent) return null;

  const inserted = await db
    .prepare(
      `INSERT INTO reconcile_runs (org_id, started_at)
       VALUES (?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
       RETURNING id`,
    )
    .bind(orgId)
    .first();
  return inserted?.id ?? null;
}

async function sinceCursor(db, orgId, resource) {
  const row = await db
    .prepare("SELECT last_synced FROM sync_state WHERE org_id = ? AND resource = ?")
    .bind(orgId, resource)
    .first();
  return row?.last_synced ?? null;
}

async function reconcileDeletedMembers(db, orgId, apiMemberLogins) {
  // Defensive: refuse to interpret an empty API list as "all members deleted".
  // syncMembers now throws on transient GitHub errors (it doesn't quietly
  // return []), but a legitimate empty org is rare enough that bailing here
  // is cheaper than risking another cascade-delete bug down the line.
  if (!Array.isArray(apiMemberLogins) || apiMemberLogins.length === 0) {
    console.log(`[noxconnect-cron] org=${orgId} skipping member-delete reconcile: empty API result`);
    return;
  }
  const apiSet = new Set(apiMemberLogins);
  const existing = await db
    .prepare("SELECT login FROM members WHERE org_id = ?")
    .bind(orgId)
    .all();
  for (const row of existing.results ?? []) {
    if (!apiSet.has(row.login)) {
      await removeMember(db, orgId, row.login);
    }
  }
}

async function reconcileDeletedRepos(db, orgId, apiRepoNames) {
  // Defensive: same reasoning as reconcileDeletedMembers. An org with zero
  // repos is so unusual that the cost of leaking a few orphan rows is much
  // less than the cost of mass-deleting issues + PRs + feature links from a
  // bad upstream response.
  if (!Array.isArray(apiRepoNames) || apiRepoNames.length === 0) {
    console.log(`[noxconnect-cron] org=${orgId} skipping repo-delete reconcile: empty API result`);
    return;
  }
  const apiSet = new Set(apiRepoNames);
  const existing = await db
    .prepare("SELECT name FROM repos WHERE org_id = ? AND retired_at IS NULL")
    .bind(orgId)
    .all();
  for (const row of existing.results ?? []) {
    if (!apiSet.has(row.name)) {
      await removeRepo(db, orgId, row.name, "missing_from_github");
    }
  }
}

async function updateHealthStatus(db, orgId, installationId) {
  if (!installationId) return;
  const row = await db
    .prepare("SELECT last_event_at FROM orgs WHERE id = ?")
    .bind(orgId)
    .first();
  const lastEventAt = row?.last_event_at;

  let status = null;
  if (!lastEventAt) {
    status = "silent";
  } else {
    const ageMs = Date.now() - new Date(lastEventAt).getTime();
    if (ageMs > SILENT_THRESHOLD_HOURS * 60 * 60 * 1000) status = "silent";
  }

  await db
    .prepare("UPDATE installations SET health_status = ? WHERE installation_id = ?")
    .bind(status, installationId)
    .run();
}
