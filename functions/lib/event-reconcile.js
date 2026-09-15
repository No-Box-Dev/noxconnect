// Backfill missing rows in the `events` table for one repo. Used by both
// the 30-min reconcile cron and the admin-triggered /api/sync-events
// endpoint, so behavior can't drift between them.
//
// Sources, in order:
//   1. D1 `pull_requests`  → github:pr:opened / closed / merged
//   2. D1 `issues`         → github:issue:opened / closed
//   3. GitHub /events API  → reviews, pushes, releases (things D1 doesn't store)
//
// Idempotent via the events.delivery_id UNIQUE constraint with deterministic
// delivery_id of `reconcile:<org>:<repo>:<scope>-<n>:<kind>` (or
// `gh-event-<id>` for /events-derived rows).

import { resolveActorFromGithub } from "./actors.js";
import { upsertGhUser } from "./gh-mirror.js";
import {
  narrateEvent,
  narrateReleaseNotes,
  narratePrOpened,
  NARRATABLE_TYPES,
  NARRATABLE_TYPES_OPENED,
} from "./narrator.js";
import { sleep, NARRATOR_PACING_MS } from "./pacing.js";

const GH_EVENTS_MAX_PAGES = 3;

function projectIdFor(org, repo) {
  return `proj_${org}_${repo}`.toLowerCase();
}

export async function reconcileRepoEvents(env, db, args) {
  const {
    orgId,
    orgLogin,
    repo,
    token = null,
    lookbackHours,
    includeGithubEvents = true,
  } = args;
  if (!orgLogin || !repo || !lookbackHours) {
    throw new Error("reconcileRepoEvents: orgLogin, repo, lookbackHours required");
  }

  const projectId = projectIdFor(orgLogin, repo);
  await db
    .prepare(
      `INSERT OR IGNORE INTO projects (id, name, org, repo, owner_id, org_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
    )
    .bind(projectId, repo, orgLogin, repo, orgLogin, orgId)
    .run();

  const sinceLiteral = `-${lookbackHours} hours`;
  const counts = {
    prOpened: 0,
    prClosed: 0,
    prMerged: 0,
    issueOpened: 0,
    issueClosed: 0,
    review: 0,
    push: 0,
    release: 0,
  };
  const newEventIds = [];

  counts.prOpened = await reconcilePrKind(db, {
    orgId, orgLogin, repo, projectId, sinceLiteral, kind: "opened",
  }, newEventIds);
  counts.prClosed = await reconcilePrKind(db, {
    orgId, orgLogin, repo, projectId, sinceLiteral, kind: "closed",
  }, newEventIds);
  counts.prMerged = await reconcilePrKind(db, {
    orgId, orgLogin, repo, projectId, sinceLiteral, kind: "merged",
  }, newEventIds);

  counts.issueOpened = await reconcileIssueKind(db, {
    orgId, orgLogin, repo, projectId, sinceLiteral, kind: "opened",
  }, newEventIds);
  counts.issueClosed = await reconcileIssueKind(db, {
    orgId, orgLogin, repo, projectId, sinceLiteral, kind: "closed",
  }, newEventIds);

  if (includeGithubEvents && token) {
    try {
      const gh = await reconcileFromGithubEvents(db, {
        orgLogin, repo, projectId, token, lookbackHours,
      }, newEventIds);
      counts.review = gh.review;
      counts.push = gh.push;
      counts.release = gh.release;
    } catch (err) {
      console.error(
        `[event-reconcile] ${repo} /events fetch failed:`,
        err?.message ?? err,
      );
    }
  }

  // Pace narrations so a 20-PR backfill doesn't fire 20 LLM calls in
  // <1s. The LLM client retries 429/5xx internally, but spacing the
  // calls out reduces the chance of hitting the limit in the first
  // place — cheaper than triggering retries. Each event gets all three
  // narrations in parallel — one trigger, up to three voices, same model.
  // Each narrator self-gates on event type (NARRATABLE_TYPES /
  // NARRATABLE_TYPES_OPENED), so firing all three for every row is safe:
  // wrong-type rows return early after one SELECT, no LLM spend.
  const NARRATOR_LABELS = ["narrateEvent", "narrateReleaseNotes", "narratePrOpened"];
  for (let i = 0; i < newEventIds.length; i++) {
    if (i > 0) await sleep(NARRATOR_PACING_MS);
    const id = newEventIds[i];
    const results = await Promise.allSettled([
      narrateEvent(env, id),
      narrateReleaseNotes(env, id),
      narratePrOpened(env, id),
    ]);
    results.forEach((r, idx) => {
      if (r.status === "rejected") {
        console.error(
          `[event-reconcile] ${NARRATOR_LABELS[idx]} ${id} failed:`,
          r.reason?.message ?? r.reason,
        );
      }
    });
  }

  return counts;
}

// ---------- PRs from D1 ----------

async function reconcilePrKind(db, args, newEventIds) {
  const { orgId, orgLogin, repo, projectId, sinceLiteral, kind } = args;
  const type = `github:pr:${kind}`;

  let where;
  let eventAtCol;
  if (kind === "opened") {
    // Skip draft PRs — the Opened feed only surfaces ready-for-review PRs.
    // A draft that later flips to ready re-arrives via the ready_for_review
    // webhook path (mapped to github:pr:opened in mapEventType).
    where = "pr.created_at IS NOT NULL AND pr.created_at > datetime('now', ?) AND COALESCE(pr.draft, 0) = 0";
    eventAtCol = "pr.created_at";
  } else if (kind === "merged") {
    where = "pr.merged_at IS NOT NULL AND pr.merged_at > datetime('now', ?)";
    eventAtCol = "pr.merged_at";
  } else if (kind === "closed") {
    // pull_requests has no closed_at column; use updated_at as a proxy for
    // closed PRs that never merged. Same approximation the existing UI uses.
    where =
      "pr.state = 'closed' AND pr.merged_at IS NULL AND pr.updated_at > datetime('now', ?)";
    eventAtCol = "pr.updated_at";
  } else {
    return 0;
  }

  const rows = await db
    .prepare(
      `SELECT pr.number, pr.title, pr.author, pr.author_avatar,
              ${eventAtCol} AS event_at,
              u.id AS user_id, u.type AS user_type, u.name AS user_name
         FROM pull_requests pr
         LEFT JOIN gh_users u ON u.login = pr.author
        WHERE pr.org_id = ? AND pr.repo = ?
          AND ${where}
          AND NOT EXISTS (
            SELECT 1 FROM events e
            WHERE e.owner_id = ? AND e.repo = ?
              AND e.type = ?
              AND CAST(json_extract(e.payload_json, '$.pr.number') AS INTEGER) = pr.number
          )`,
    )
    .bind(orgId, repo, sinceLiteral, orgLogin, repo, type)
    .all();

  let inserted = 0;
  for (const row of rows.results ?? []) {
    if (!row.author || row.user_id == null) continue;
    const author = {
      login: row.author,
      id: Number(row.user_id),
      avatar_url: row.author_avatar,
      type: row.user_type === "Bot" ? "Bot" : "User",
      name: row.user_name ?? null,
    };
    try {
      await upsertGhUser(db, author);
    } catch (err) {
      console.error("[event-reconcile] upsertGhUser failed:", err?.message ?? err);
    }
    const actor = await resolveActorFromGithub(db, orgLogin, author);
    if (!actor) continue;

    const action = kind;
    const result = await db
      .prepare(
        `INSERT INTO events (delivery_id, source, type, actor_id, project_id, org, repo, summary, payload_json, owner_id, created_at)
         VALUES (?, 'github-reconcile', ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(delivery_id) DO NOTHING`,
      )
      .bind(
        `reconcile:${orgLogin}:${repo}:pr-${row.number}:${kind}`,
        type,
        actor.id,
        projectId,
        orgLogin,
        repo,
        `PR #${row.number}: ${row.title}`,
        JSON.stringify({
          action,
          pr: {
            number: row.number,
            title: row.title,
            state: kind === "opened" ? "open" : "closed",
            merged: kind === "merged",
            author: row.author,
          },
        }),
        orgLogin,
        row.event_at,
      )
      .run();
    const id = result?.meta?.last_row_id;
    if (id) {
      inserted++;
      newEventIds.push(id);
    }
  }
  return inserted;
}

// ---------- Issues from D1 ----------

async function reconcileIssueKind(db, args, newEventIds) {
  const { orgId, orgLogin, repo, projectId, sinceLiteral, kind } = args;
  const type = `github:issue:${kind}`;

  let where;
  let eventAtCol;
  if (kind === "opened") {
    where = "i.created_at IS NOT NULL AND i.created_at > datetime('now', ?)";
    eventAtCol = "i.created_at";
  } else if (kind === "closed") {
    where =
      "i.state = 'closed' AND i.closed_at IS NOT NULL AND i.closed_at > datetime('now', ?)";
    eventAtCol = "i.closed_at";
  } else {
    return 0;
  }

  // Issue dedup is two-pronged: webhook rows post-slimPayload-fix include
  // $.issue.number; pre-fix rows store only `{action}` so we fall back to a
  // 5-min created_at window match on (repo, type). The window is generous
  // — webhook delivery is normally within seconds.
  const rows = await db
    .prepare(
      `SELECT i.number, i.title, i.author, i.author_avatar, i.state,
              ${eventAtCol} AS event_at,
              u.id AS user_id, u.type AS user_type, u.name AS user_name
         FROM issues i
         LEFT JOIN gh_users u ON u.login = i.author
        WHERE i.org_id = ? AND i.repo = ?
          AND ${where}
          AND NOT EXISTS (
            SELECT 1 FROM events e
            WHERE e.owner_id = ? AND e.repo = ?
              AND e.type = ?
              AND (
                CAST(json_extract(e.payload_json, '$.issue.number') AS INTEGER) = i.number
                OR (
                  json_extract(e.payload_json, '$.issue.number') IS NULL
                  AND ABS(strftime('%s', e.created_at) - strftime('%s', ${eventAtCol})) < 300
                )
              )
          )`,
    )
    .bind(orgId, repo, sinceLiteral, orgLogin, repo, type)
    .all();

  let inserted = 0;
  for (const row of rows.results ?? []) {
    if (!row.author || row.user_id == null) continue;
    const author = {
      login: row.author,
      id: Number(row.user_id),
      avatar_url: row.author_avatar,
      type: row.user_type === "Bot" ? "Bot" : "User",
      name: row.user_name ?? null,
    };
    try {
      await upsertGhUser(db, author);
    } catch (err) {
      console.error("[event-reconcile] upsertGhUser failed:", err?.message ?? err);
    }
    const actor = await resolveActorFromGithub(db, orgLogin, author);
    if (!actor) continue;

    const result = await db
      .prepare(
        `INSERT INTO events (delivery_id, source, type, actor_id, project_id, org, repo, summary, payload_json, owner_id, created_at)
         VALUES (?, 'github-reconcile', ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(delivery_id) DO NOTHING`,
      )
      .bind(
        `reconcile:${orgLogin}:${repo}:issue-${row.number}:${kind}`,
        type,
        actor.id,
        projectId,
        orgLogin,
        repo,
        `Issue #${row.number}: ${row.title}`,
        JSON.stringify({
          action: kind,
          issue: {
            number: row.number,
            title: row.title,
            state: row.state,
            author: row.author,
          },
        }),
        orgLogin,
        row.event_at,
      )
      .run();
    const id = result?.meta?.last_row_id;
    if (id) {
      inserted++;
      newEventIds.push(id);
    }
  }
  return inserted;
}

// ---------- GitHub /repos/{owner}/{repo}/events ----------

async function reconcileFromGithubEvents(db, args, newEventIds) {
  const { orgLogin, repo, projectId, token, lookbackHours } = args;
  const cutoffMs = Date.now() - lookbackHours * 3_600_000;
  const events = await fetchRepoEvents(token, orgLogin, repo, cutoffMs);

  const counts = { review: 0, push: 0, release: 0 };

  for (const ev of events) {
    const mapped = translateGithubEvent(ev);
    if (!mapped) continue;

    // PR opens/closes/merges and issue opens/closes are reconciled from D1
    // above — skip the /events versions to avoid double-inserting.
    if (
      mapped.type === "github:pr:opened" ||
      mapped.type === "github:pr:closed" ||
      mapped.type === "github:pr:merged" ||
      mapped.type === "github:pr:reopened" ||
      mapped.type === "github:issue:opened" ||
      mapped.type === "github:issue:closed"
    ) {
      continue;
    }

    const author = mapped.author;
    if (!author?.login || author.id == null) continue;

    // Avoid clobbering Bot/User type in gh_users on rows we already know:
    // /events doesn't return user.type, so look up the canonical row first
    // and skip upsert if it already exists. New users discovered via /events
    // get inserted as type=User; the next webhook with a real type will
    // overwrite via upsertGhUser's ON CONFLICT path.
    const existing = await db
      .prepare("SELECT id, type FROM gh_users WHERE id = ?")
      .bind(author.id)
      .first();
    if (!existing) {
      try {
        await upsertGhUser(db, author);
      } catch (err) {
        console.error(
          "[event-reconcile] upsertGhUser failed:",
          err?.message ?? err,
        );
      }
    } else {
      author.type = existing.type ?? "User";
    }

    const actor = await resolveActorFromGithub(db, orgLogin, author);
    if (!actor) continue;

    const result = await db
      .prepare(
        `INSERT INTO events (delivery_id, source, type, actor_id, project_id, org, repo, summary, payload_json, owner_id, created_at)
         VALUES (?, 'github-reconcile', ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(delivery_id) DO NOTHING`,
      )
      .bind(
        `reconcile:${orgLogin}:${repo}:gh-event-${ev.id}`,
        mapped.type,
        actor.id,
        projectId,
        orgLogin,
        repo,
        mapped.summary,
        JSON.stringify(mapped.payload),
        orgLogin,
        ev.created_at,
      )
      .run();
    const id = result?.meta?.last_row_id;
    if (!id) continue;
    newEventIds.push(id);
    if (mapped.type.startsWith("github:pr:review:")) counts.review++;
    else if (mapped.type === "github:push") counts.push++;
    else if (mapped.type === "github:release:published") counts.release++;
  }
  return counts;
}

async function fetchRepoEvents(token, orgLogin, repo, cutoffMs) {
  const all = [];
  for (let page = 1; page <= GH_EVENTS_MAX_PAGES; page++) {
    const res = await fetch(
      `https://api.github.com/repos/${orgLogin}/${repo}/events?per_page=100&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "User-Agent": "NoxConnect",
          Accept: "application/vnd.github+json",
        },
      },
    );
    if (!res.ok) {
      // 403/404 = App lacks access on this repo. Treat as empty rather than
      // throwing — other repos in the loop should still reconcile.
      if (res.status === 404 || res.status === 403) return all;
      if (res.status === 401) throw new Error("GitHub token expired or revoked");
      throw new Error(
        `GitHub /events ${res.status} ${res.statusText} (${orgLogin}/${repo})`,
      );
    }
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) break;
    let crossedCutoff = false;
    for (const ev of data) {
      const ts = ev.created_at ? Date.parse(ev.created_at) : NaN;
      if (Number.isFinite(ts) && ts < cutoffMs) {
        crossedCutoff = true;
        break;
      }
      all.push(ev);
    }
    if (crossedCutoff || data.length < 100) break;
  }
  return all;
}

// Translate a GitHub /events API entry to (type, summary, payload, author).
// Returns null for entries we don't surface (CreateEvent, WatchEvent, …).
function translateGithubEvent(ev) {
  const actor = ev.actor?.login
    ? {
        login: ev.actor.login,
        id: ev.actor.id ?? null,
        avatar_url: ev.actor.avatar_url ?? null,
        type: "User",
        name: null,
      }
    : null;

  switch (ev.type) {
    case "PullRequestReviewEvent": {
      if (ev.payload?.action !== "submitted") return null;
      const state = ev.payload.review?.state;
      let type;
      if (state === "approved") type = "github:pr:review:approved";
      else if (state === "changes_requested") type = "github:pr:review:changes_requested";
      else if (state === "commented") type = "github:pr:review:commented";
      else return null;
      const pr = ev.payload.pull_request;
      return {
        type,
        author: actor,
        summary: pr
          ? `Review (${state}) on PR #${pr.number}: ${pr.title}`
          : `Review (${state})`,
        payload: {
          action: "submitted",
          review: {
            state,
            body: ev.payload.review?.body?.slice(0, 16000) ?? null,
            author: actor?.login ?? null,
            submitted_at: ev.payload.review?.submitted_at ?? null,
          },
          pr: pr
            ? {
                number: pr.number,
                title: pr.title,
                author: pr.user?.login ?? null,
              }
            : null,
        },
      };
    }
    case "PushEvent": {
      const ref = ev.payload?.ref?.replace("refs/heads/", "") || "?";
      const commits = ev.payload?.commits ?? [];
      return {
        type: "github:push",
        author: actor,
        summary: `Push to ${ref} (${commits.length} commit${commits.length === 1 ? "" : "s"})`,
        payload: {
          ref: ev.payload?.ref ?? null,
          before: ev.payload?.before ?? null,
          after: ev.payload?.head ?? null,
          pusher: actor?.login ?? null,
          commits: commits.slice(0, 10).map((c) => ({
            id: c.sha,
            message: c.message?.slice(0, 200) ?? null,
            author: c.author?.name ?? null,
          })),
        },
      };
    }
    case "ReleaseEvent": {
      if (ev.payload?.action !== "published") return null;
      return {
        type: "github:release:published",
        author: actor,
        summary: `Release ${ev.payload.release?.tag_name ?? "?"}`,
        payload: {
          action: "published",
          release: {
            tag_name: ev.payload.release?.tag_name ?? null,
            name: ev.payload.release?.name ?? null,
          },
        },
      };
    }
    default:
      return null;
  }
}

// Exposed for tests.
export { translateGithubEvent, fetchRepoEvents };
