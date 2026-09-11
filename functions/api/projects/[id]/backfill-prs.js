import { getCtx, jsonResponse, errorResponse } from "../../../lib/db";
import { getInstallationToken } from "../../../lib/github-app";
import { resolveActorFromGithub } from "../../../lib/actors";
import { narrateEvent, narrateReleaseNotes } from "../../../lib/narrator";
import { recordFailure } from "../../../lib/op-failures";
import { sleep, NARRATOR_PACING_MS } from "../../../lib/pacing";
import { getNoxFeedGenerationInfo } from "../../../lib/noxfeed-response.js";

// POST /api/projects/:id/backfill-prs
// Body: {
//   days?: number (1..30, default 3),
//   rewriteOtherModels?: boolean (default false) — when true, also re-narrate
//     posts whose payload.model isn't the currently-configured model. Useful
//     after swapping providers so the feed converges on the new voice.
// }
// Generates first-person posts for the last N days of PRs in the project's repo,
// one per PR, attributed to its author. Dedupes via delivery_id like
// `backfill:<projectId>:pr-<n>` so re-running is idempotent.
const BACKFILL_MAX_PRS = 25;
// Mirror the new-trigger cap on fallback re-narration. Unbounded loops blow
// past waitUntil's wall-clock budget — earlier fallbacks ran, later ones
// silently dropped (the "they're being skipped" report). Re-running backfill
// picks up the remainder.
const BACKFILL_MAX_FALLBACKS = 25;

export async function onRequestPost(context) {
  try {
    const { orgLogin, isAdmin } = getCtx(context);
    if (!orgLogin) return errorResponse("Missing org context", 400);
    if (!isAdmin) return errorResponse("Admin required", 403);
    const { id } = context.params;
    if (!id) return errorResponse("Missing project id", 400);

    let body;
    try {
      body = await context.request.json();
    } catch {
      body = {};
    }
    const days = Math.max(1, Math.min(30, Number(body?.days) || 3));
    const rewriteOtherModels = body?.rewriteOtherModels === true;

    const db = context.env.DB;

    const project = await db.prepare(
      "SELECT id, name, org, repo, owner_id FROM projects WHERE id = ? AND owner_id = ?"
    ).bind(id, orgLogin).first();
    if (!project) return errorResponse(`Unknown project ${id}`, 404);
    if (!project.org || !project.repo) return errorResponse("Project has no org/repo", 400);

    const inst = await db.prepare(
      "SELECT installation_id FROM installations WHERE owner_id = ? AND account_login = ?"
    ).bind(orgLogin, project.org).first();
    if (!inst) return errorResponse(`No installation for org ${project.org}`, 404);

    let prs;
    try {
      prs = await fetchRecentPrs(context.env, inst.installation_id, project.org, project.repo, days);
    } catch (err) {
      return errorResponse(`Failed to fetch PRs: ${err instanceof Error ? err.message : String(err)}`, 502);
    }

    if (prs.length === 0) {
      return jsonResponse({
        ok: true,
        found: 0,
        queued: 0,
        skipped: 0,
        days,
        message: `No PRs in the last ${days} day(s).`,
      });
    }

    // Build exact delivery_id candidates and dedupe via IN(...). Avoids a LIKE
    // pattern over project.id, whose literal `_` characters (e.g.
    // `proj_n1healthcare_authentication-service`) blow past D1's
    // "LIKE or GLOB pattern too complex" threshold.
    const candidateIds = prs.map((pr) => `backfill:${project.id}:pr-${pr.number}`);
    const placeholders = candidateIds.map(() => "?").join(",");
    const existing = await db.prepare(
      `SELECT delivery_id FROM events
        WHERE owner_id = ? AND project_id = ? AND source = 'github-backfill'
          AND delivery_id IN (${placeholders})`
    ).bind(orgLogin, project.id, ...candidateIds).all();
    const seen = new Set((existing.results ?? []).map((r) => r.delivery_id));

    const todo = prs
      .filter((pr) => !seen.has(`backfill:${project.id}:pr-${pr.number}`))
      .slice(0, BACKFILL_MAX_PRS);

    // Sweep up narratives that need re-narration:
    //   - Always: `model='fallback'` (LLM was down when they ran).
    //   - When the user opts in: any narrative whose model isn't the
    //     currently-configured one (e.g. they swapped providers and want the
    //     feed to converge on the new voice).
    // Capped so one call doesn't outrun the waitUntil budget; re-run picks up
    // whatever's left. Newest-first so visible posts go first.
    let currentModel = null;
    if (rewriteOtherModels) {
      try {
        const info = await getNoxFeedGenerationInfo(context.env);
        currentModel = info.model;
      } catch (error) {
        console.error("[noxconnect backfill] NoxFeed generation info unavailable:", error);
        return errorResponse(
          "NoxFeed generation service is unavailable",
          503,
          "dependency_unavailable",
        );
      }
    }
    const fallbackIds = (
      await findRenarrateTargets(db, orgLogin, project.id, currentModel)
    ).slice(0, BACKFILL_MAX_FALLBACKS);

    if (todo.length === 0 && fallbackIds.length === 0) {
      return jsonResponse({
        ok: true,
        found: prs.length,
        queued: 0,
        skipped: prs.length,
        renarrated: 0,
        days,
        message: "All PRs already backfilled.",
      });
    }

    const work = (async () => {
      if (todo.length > 0) {
        await processBackfill(context.env, {
          projectId: project.id,
          org: project.org,
          repo: project.repo,
          ownerId: orgLogin,
          prs: todo,
        });
      }
      if (fallbackIds.length > 0) {
        await renarrateFallbacks(context.env, fallbackIds);
      }
    })();
    context.waitUntil(
      work.catch(async (err) => {
        console.error("[noxconnect backfill] failed:", err);
        await recordFailure(db, {
          ownerId: orgLogin,
          op: "backfillPrs",
          deliveryId: project.id,
          error: err,
        });
      })
    );

    return jsonResponse({
      ok: true,
      found: prs.length,
      queued: todo.length,
      skipped: prs.length - todo.length,
      renarrated: fallbackIds.length,
      days,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    console.error("[noxconnect backfill] unhandled error:", message, stack);
    return errorResponse(`Backfill failed: ${message}`, 500);
  }
}

// When `currentModel` is set, sweep up any narrative OR release-note whose
// stamped model isn't the one currently configured (including `fallback`).
// When it's null, only fallback rows are returned — the default behavior.
// Newest-first so the visible feed converges first. Results are deduped by
// trigger_event_id (one renarrate handles both feeds in lockstep).
async function findRenarrateTargets(db, ownerId, projectId, currentModel) {
  const sql = currentModel
    ? `SELECT id, type, json_extract(payload_json, '$.trigger_event_id') AS trigger_event_id
         FROM events
        WHERE owner_id = ? AND project_id = ?
          AND type IN ('narrative', 'release_notes')
          AND (
            COALESCE(technical_summary, '') = ''
            OR COALESCE(json_extract(payload_json, '$.model'), '') != ?
          )
        ORDER BY id DESC`
    : `SELECT id, type, json_extract(payload_json, '$.trigger_event_id') AS trigger_event_id
         FROM events
        WHERE owner_id = ? AND project_id = ?
          AND type IN ('narrative', 'release_notes')
          AND (
            COALESCE(technical_summary, '') = ''
            OR json_extract(payload_json, '$.model') = 'fallback'
          )
        ORDER BY id DESC`;
  const stmt = currentModel
    ? db.prepare(sql).bind(ownerId, projectId, currentModel)
    : db.prepare(sql).bind(ownerId, projectId);
  const rows = await stmt.all();
  // Dedupe by trigger_event_id — both rows for the same trigger collapse
  // into one entry. The id we keep is the narrative one when present so
  // the existing DELETE-by-id covers it; the release-note row is purged
  // by the trigger_event_id sweep in renarrateFallbacks.
  const byTrigger = new Map();
  for (const r of rows.results ?? []) {
    if (r.trigger_event_id == null) continue;
    const existing = byTrigger.get(r.trigger_event_id);
    if (!existing || (existing.type !== "narrative" && r.type === "narrative")) {
      byTrigger.set(r.trigger_event_id, { id: r.id, type: r.type, triggerEventId: r.trigger_event_id });
    }
  }
  return [...byTrigger.values()];
}

async function resolveOrgId(db, ownerId) {
  if (!db || !ownerId) return null;
  const row = await db
    .prepare("SELECT id FROM orgs WHERE github_login = ?")
    .bind(ownerId)
    .first()
    .catch(() => null);
  return row?.id ?? null;
}

async function renarrateFallbacks(env, fallbacks) {
  for (let i = 0; i < fallbacks.length; i++) {
    if (i > 0) await sleep(NARRATOR_PACING_MS);
    const { triggerEventId } = fallbacks[i];
    try {
      // Clear ANY existing narrative/release_notes rows for this trigger
      // before re-running both narrators. The id we have from
      // findRenarrateTargets can be either type (depending on which one
      // had the stale model), so we sweep both by trigger_event_id rather
      // than the specific row id — otherwise a stale narrative could
      // survive when only the release_notes row was selected as the
      // target (narrateEvent has no idempotency guard and would insert a
      // duplicate narrative on top of the surviving one).
      await env.DB.prepare(
        `DELETE FROM events
           WHERE type IN ('narrative', 'release_notes')
             AND CAST(json_extract(payload_json, '$.trigger_event_id') AS INTEGER) = ?`,
      ).bind(triggerEventId).run();
      await Promise.allSettled([
        narrateEvent(env, triggerEventId),
        narrateReleaseNotes(env, triggerEventId),
      ]);
    } catch (err) {
      console.error(`[noxconnect backfill] re-narrate trigger ${triggerEventId} failed:`, err);
    }
  }
}

async function fetchRecentPrs(env, installationId, org, repo, days) {
  const token = await getInstallationToken(env, installationId);
  const cutoff = Date.now() - days * 86_400_000;

  const url = `https://api.github.com/repos/${org}/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=100`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "NoxConnect",
    },
  });
  if (!res.ok) {
    throw new Error(`fetchRecentPrs ${org}/${repo}: ${res.status}`);
  }
  const all = await res.json();
  return all.filter((pr) => {
    const anchor = pr.merged_at || pr.closed_at || pr.created_at;
    return anchor && new Date(anchor).getTime() >= cutoff;
  });
}

async function processBackfill(env, args) {
  // Oldest-first so the feed reads chronologically.
  const sorted = [...args.prs].sort((a, b) => prAnchor(a).localeCompare(prAnchor(b)));
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0) await sleep(NARRATOR_PACING_MS);
    const pr = sorted[i];
    try {
      await backfillOnePr(env, args, pr);
    } catch (err) {
      console.error(`[noxconnect backfill] PR #${pr.number} failed:`, err);
    }
  }
}

function prAnchor(pr) {
  return pr.merged_at || pr.closed_at || pr.created_at;
}

async function backfillOnePr(env, args, pr) {
  if (!pr.user?.login) return;

  const actor = await resolveActorFromGithub(env.DB, args.ownerId, {
    login: pr.user.login,
    id: pr.user.id ?? null,
    avatar_url: pr.user.avatar_url ?? null,
    type: pr.user.type === "Bot" ? "Bot" : "User",
    name: null,
  });
  if (!actor) return;

  const eventType = pr.merged_at
    ? "github:pr:merged"
    : pr.state === "closed"
      ? "github:pr:closed"
      : "github:pr:opened";

  const createdAt = prAnchor(pr);

  const result = await env.DB.prepare(
    `INSERT INTO events (delivery_id, source, type, actor_id, project_id, org, repo, summary, payload_json, owner_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(delivery_id) DO NOTHING`
  ).bind(
    `backfill:${args.projectId}:pr-${pr.number}`,
    "github-backfill",
    eventType,
    actor.id,
    args.projectId,
    args.org,
    args.repo,
    `PR #${pr.number}: ${pr.title}`,
    JSON.stringify({
      action: pr.merged_at ? "merged" : "opened",
      pr: {
        number: pr.number,
        title: pr.title,
        body: pr.body?.slice(0, 16000) ?? null,
        state: pr.state,
        merged: !!pr.merged_at,
        author: pr.user.login,
        additions: pr.additions,
        deletions: pr.deletions,
        changed_files: pr.changed_files,
      },
    }),
    args.ownerId,
    createdAt,
  ).run();

  const eventId = result.meta?.last_row_id;
  if (!eventId) return;
  // Run both voices in parallel — one event, two stored rows. Same LLM
  // config, different prompt. Promise.allSettled so one LLM failure
  // doesn't drop the other.
  await Promise.allSettled([
    narrateEvent(env, eventId),
    narrateReleaseNotes(env, eventId),
  ]);
}
