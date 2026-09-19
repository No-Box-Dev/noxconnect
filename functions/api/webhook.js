import { jsonResponse, errorResponse } from "../lib/db";
import {
  upsertIssue,
  upsertFeature,
  upsertPR,
  upsertMember,
  removeMember,
  upsertTeam,
  removeTeam,
  addTeamMember,
  removeTeamMember,
  markRepoArchived,
  removeRepo,
  renameRepo,
  touchRepoPushed,
  upsertDiscoveredRepo,
  applyNewRepoExcludePolicy,
} from "../lib/github-sync";
import { storeEvent } from "../lib/events";
import { upsertInstallation, setInstallationRepos, getInstallationRepos } from "../lib/gh-mirror";
import { TASK, enqueueTask } from "../lib/tasks";
import { recordFailure } from "../lib/op-failures";
import { startRepoTracking } from "../lib/repo-tracking";
import { stageNoxTicketActivity } from "../lib/noxticket-slack.js";
import { enqueueReviewJob, cancelReviewJobs } from "../lib/review-jobs.js";
import { isAppEnabled } from "../lib/apps.js";
import { reopenNoxSpotReportFromIssue, resolveNoxSpotReportFromIssue } from "../lib/noxspot-resolution.js";

// Every `waitUntil` handler that logs a failure runs after the webhook
// response has already been returned — a plain console.error is invisible
// from the app. This helper mirrors the pattern used elsewhere: log a
// human-readable line to the runtime logs AND persist to op_failures so
// admins see it in Settings → Background failures.
function reportWebhookFailure(db, orgLogin, op, deliveryId, err, extra) {
  console.error(`[noxconnect webhook] ${op} failed`, {
    delivery: deliveryId,
    msg: err?.message ?? String(err),
    ...(extra ?? {}),
  });
  // op_failures rows are keyed on ownerId (orgLogin). Some webhook paths
  // fire before we know which org (e.g. installation.created for a brand
  // new install) — swallow those since there's no bucket to file them in.
  if (!db || !orgLogin) return;
  return recordFailure(db, {
    ownerId: orgLogin,
    op: `webhook.${op}`,
    deliveryId,
    error: err,
  });
}

// Verify GitHub webhook signature (HMAC-SHA256)
async function verifySignature(secret, body, signature) {
  if (!signature) return false;
  // Belt-and-braces preflight: signature must look like `sha256=<64 hex>`.
  // The constant-time compare below also handles it, but rejecting a
  // malformed header early keeps the HMAC path away from any weird
  // header shape that could sneak past.
  if (!/^sha256=[0-9a-f]{64}$/i.test(signature)) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  const hex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const expected = `sha256=${hex}`;

  // Constant-time comparison — compare byte buffers, not JS string lengths
  // (avoids UTF-16 surrogate-pair quirks if a malformed signature header is sent)
  const a = encoder.encode(expected);
  const b = encoder.encode(signature);
  if (a.byteLength !== b.byteLength) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a[i] ^ b[i];
  }
  return result === 0;
}

// POST /api/webhook — GitHub webhook receiver
export async function onRequestPost(context) {
  const secret = context.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    return errorResponse("Webhook secret not configured", 500);
  }

  const body = await context.request.text();
  const signature = context.request.headers.get("X-Hub-Signature-256");

  const valid = await verifySignature(secret, body, signature);
  if (!valid) {
    return errorResponse("Invalid signature", 401);
  }

  const event = context.request.headers.get("X-GitHub-Event");
  const deliveryId = context.request.headers.get("X-GitHub-Delivery");
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return errorResponse("Invalid JSON payload", 400);
  }

  // Ping event (sent when webhook is first created)
  if (event === "ping") {
    return jsonResponse({ ok: true, message: "pong" });
  }

  // App lifecycle events arrive without an organization payload — handle them up front.
  if (event === "installation") {
    return await handleInstallationEvent(context, payload, deliveryId);
  }
  if (event === "installation_repositories") {
    return await handleInstallationReposEvent(context, payload, deliveryId);
  }

  // Look up org
  const orgLogin = payload.organization?.login;
  if (!orgLogin) {
    return jsonResponse({ ok: true, skipped: "no organization in payload" });
  }

  const orgRow = await context.env.DB
    .prepare("SELECT id FROM orgs WHERE github_login = ?")
    .bind(orgLogin)
    .first();

  if (!orgRow) {
    return jsonResponse({ ok: true, skipped: "org not tracked" });
  }

  const orgId = orgRow.id;
  const db = context.env.DB;
  const action = payload.action;
  const noxFeedEnabled = await isAppEnabled(db, orgId, "noxfeed");

  // Bump orgs.last_event_at on every webhook write — the reconcile cron
  // uses this to flag installations that have gone silent (no events for
  // 24h+). Cheap single UPDATE; failures are logged but never abort.
  try {
    await db
      .prepare("UPDATE orgs SET last_event_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?")
      .bind(orgId)
      .run();
  } catch (err) {
    await reportWebhookFailure(db, orgLogin, "last_event_at_bump", deliveryId, err);
  }

  try {
    // Record into the events log first (additive — failure here must not
    // break the feature/PR/issue upserts below). owner_id matches
    // NoxLink's text convention (org github_login).
    try {
      const stored = await storeEvent(db, event, deliveryId, payload, orgLogin);
      if (stored?.id && noxFeedEnabled) {
        // Narrate via the durable queue so the webhook returns immediately and
        // the work survives a failed attempt (retried, then dead-lettered).
        // Three narrators, one PR lifecycle:
        //   - github:pr:opened  → NARRATE_PR_OPENED  (writes pr_narrative for the PRs feed)
        //   - github:pr:merged  → NARRATE + RELEASE_NOTES  (reuse pr_narrative text if any,
        //     else fresh LLM call; writes narrative + release_notes rows)
        // Enqueueing both merged tasks even when the trigger is `pr:opened` would
        // be wasteful — narrateEvent short-circuits on non-merged types — but we
        // could also just gate here. Gating here is cheaper (fewer queue msgs).
        if (stored.type === "github:pr:opened") {
          await enqueueTask(context.env, orgLogin, deliveryId, {
            type: TASK.NARRATE_PR_OPENED,
            eventId: stored.id,
          });
        } else {
          await enqueueTask(context.env, orgLogin, deliveryId, {
            type: TASK.NARRATE,
            eventId: stored.id,
          });
          await enqueueTask(context.env, orgLogin, deliveryId, {
            type: TASK.RELEASE_NOTES,
            eventId: stored.id,
          });
        }
      }
    } catch (err) {
      await reportWebhookFailure(db, orgLogin, "storeEvent", deliveryId, err, { event, action });
    }

    if (event === "issues") {
      const repo = payload.repository?.name;
      if (!repo) return jsonResponse({ ok: true, skipped: "no repo" });

      // Issues deleted or transferred away no longer exist in this repo —
      // remove them from D1 instead of upserting (which would re-insert with
      // their pre-delete state, leaving stale rows on the dashboard).
      if (action === "deleted" || action === "transferred") {
        await db
          .prepare("DELETE FROM issues WHERE org_id = ? AND repo = ? AND number = ?")
          .bind(orgId, repo, payload.issue.number)
          .run();
        if (repo === "noxconnect") {
          await db
            .prepare("DELETE FROM features WHERE org_id = ? AND number = ?")
            .bind(orgId, payload.issue.number)
            .run();
        }
        return jsonResponse({ ok: true, event, action, repo, number: payload.issue.number, deleted: true });
      }

      const closedBy = (action === "closed" && payload.sender?.login) ? payload.sender.login : null;
      await upsertIssue(db, orgId, repo, payload.issue, closedBy);

      if (action === "closed") {
        try {
          await resolveNoxSpotReportFromIssue(context.env, {
            orgId,
            ownerId: orgLogin,
            repo,
            issueNumber: payload.issue.number,
            actor: payload.sender?.login ?? "github",
            summary: "The linked GitHub issue was closed.",
          });
        } catch (err) {
          await reportWebhookFailure(db, orgLogin, "noxspot_resolution", deliveryId, err, {
            repo,
            number: payload.issue?.number,
          });
        }
      }
      if (action === "reopened") {
        try {
          await reopenNoxSpotReportFromIssue(context.env, {
            orgId,
            ownerId: orgLogin,
            repo,
            issueNumber: payload.issue.number,
            actor: payload.sender?.login ?? "github",
          });
        } catch (err) {
          await reportWebhookFailure(db, orgLogin, "noxspot_reopen", deliveryId, err, {
            repo,
            number: payload.issue?.number,
          });
        }
      }

      try {
        await stageNoxTicketActivity(context.env, {
          orgId,
          ownerId: orgLogin,
          repo,
          action,
          issue: payload.issue,
          actor: payload.sender?.login ?? null,
        });
      } catch (err) {
        await reportWebhookFailure(db, orgLogin, "noxconnect_slack", deliveryId, err, { repo, number: payload.issue?.number });
      }

      // Auto-register issue author as member so they appear in People page.
      if (payload.issue?.user?.login) {
        try {
          await upsertMember(db, orgId, payload.issue.user, payload.issue.user.type === "Bot" ? "bot" : "human");
        } catch (err) {
          await reportWebhookFailure(db, orgLogin, "upsertMember_from_issue", deliveryId, err, { login: payload.issue?.user?.login });
        }
      }

      // Also upsert into features table if this is a noxconnect repo issue
      if (repo === "noxconnect") {
        await upsertFeature(db, orgId, payload.issue);
      }
      return jsonResponse({ ok: true, event, action, repo, number: payload.issue.number });
    }

    if (event === "pull_request") {
      const repo = payload.repository?.name;
      if (!repo) return jsonResponse({ ok: true, skipped: "no repo" });

      // Map merged PRs: GitHub sends action=closed with merged=true
      const pr = payload.pull_request;
      await upsertPR(db, orgId, repo, pr);

      // NoxReview queueing — no-ops unless the repo is enabled in settings.
      try {
        if (["opened", "synchronize", "ready_for_review"].includes(action)) {
          await enqueueReviewJob(db, orgId, orgLogin, repo, pr, action);
        } else if (action === "closed") {
          await cancelReviewJobs(db, orgId, repo, pr.number);
        }
      } catch (err) {
        await reportWebhookFailure(db, orgLogin, "review_job", deliveryId, err, { repo, action });
      }

      // Auto-register PR author as member so they appear in People page.
      if (pr.user?.login) {
        try {
          await upsertMember(db, orgId, pr.user, pr.user.type === "Bot" ? "bot" : "human");
        } catch (err) {
          await reportWebhookFailure(db, orgLogin, "upsertMember_from_pr", deliveryId, err, { login: pr.user?.login });
        }
      }

      return jsonResponse({ ok: true, event, action, repo, number: pr.number });
    }

    if (event === "member") {
      const member = payload.member;
      if (!member?.login) {
        return jsonResponse({ ok: true, skipped: "no member in payload" });
      }
      if (action === "removed") {
        await removeMember(db, orgId, member.login);
      } else {
        await upsertMember(db, orgId, member);
      }
      return jsonResponse({ ok: true, event, action, login: member.login });
    }

    if (event === "repository") {
      const repo = payload.repository?.name;
      if (!repo) return jsonResponse({ ok: true, skipped: "no repo" });

      if (action === "archived") {
        await markRepoArchived(db, orgId, repo);
      } else if (action === "unarchived") {
        await db.prepare("UPDATE repos SET archived_at = NULL WHERE org_id = ? AND name = ?").bind(orgId, repo).run();
        await startRepoTracking(db, orgId, repo);
      } else if (action === "deleted" || action === "transferred") {
        const transferredTo = action === "transferred"
          ? payload.repository?.owner?.login ?? null
          : null;
        await removeRepo(db, orgId, repo, action, transferredTo);
      } else if (action === "renamed") {
        // GitHub fires a repository rename with `changes.repository.name.from`
        // and the new name at `payload.repository.name`. Rename in place so
        // issues, PRs, and feature links keep pointing at the live repo
        // without waiting for a reconcile to repopulate.
        const oldName = payload.changes?.repository?.name?.from;
        if (oldName && oldName !== repo) {
          await renameRepo(db, orgId, oldName, repo);
        }
      }
      return jsonResponse({ ok: true, event, action, repo });
    }

    if (event === "push") {
      const repo = payload.repository?.name;
      if (!repo) return jsonResponse({ ok: true, skipped: "no repo" });
      // Only the pushed_at update is interesting for the dashboard — the
      // events row + narrator already handle the feed side.
      try {
        await touchRepoPushed(db, orgId, repo);
      } catch (err) {
        await reportWebhookFailure(db, orgLogin, "touchRepoPushed", deliveryId, err, { repo });
      }
      return jsonResponse({ ok: true, event, repo });
    }

    if (event === "team") {
      const team = payload.team;
      if (!team?.id) return jsonResponse({ ok: true, skipped: "no team" });
      if (action === "deleted") {
        await removeTeam(db, orgId, team.id);
      } else {
        await upsertTeam(db, orgId, team);
      }
      return jsonResponse({ ok: true, event, action, team: team.slug });
    }

    if (event === "membership") {
      const team = payload.team;
      const member = payload.member;
      if (!team?.id || !member?.login) {
        return jsonResponse({ ok: true, skipped: "no team/member in payload" });
      }
      // Make sure the team row exists before we touch the membership table —
      // a `membership` event can land before the corresponding `team.created`.
      await upsertTeam(db, orgId, team);
      if (action === "removed") {
        await removeTeamMember(db, orgId, team.id, member.login);
      } else {
        await addTeamMember(db, orgId, team.id, member.login);
      }
      return jsonResponse({ ok: true, event, action, team: team.slug, login: member.login });
    }

    if (event === "organization") {
      const member = payload.membership?.user ?? payload.user;
      if (action === "member_added" && member?.login) {
        await upsertMember(db, orgId, member);
        return jsonResponse({ ok: true, event, action, login: member.login });
      }
      if (action === "member_removed" && member?.login) {
        await removeMember(db, orgId, member.login);
        return jsonResponse({ ok: true, event, action, login: member.login });
      }
      return jsonResponse({ ok: true, event, action, skipped: "no membership change" });
    }

    // pull_request_review and other events without dedicated handlers fall
    // through to here. They've already been recorded via storeEvent +
    // narrateEvent above, so the Posts feed gets them automatically.
    return jsonResponse({ ok: true, skipped: `unhandled event: ${event}` });
  } catch (e) {
    // Don't leak internal error details to webhook senders. Log server-side only.
    console.error("[noxconnect webhook]", event, action, e instanceof Error ? e.stack : e);
    return errorResponse("Webhook processing failed", 500);
  }
}

async function handleInstallationEvent(context, payload, deliveryId) {
  const db = context.env.DB;
  const action = payload.action;
  const installationId = payload.installation?.id;
  const accountLogin = payload.installation?.account?.login;
  if (!installationId || !accountLogin) {
    return jsonResponse({ ok: true, event: "installation", skipped: "missing installation/account" });
  }

  if (action === "created" || action === "new_permissions_accepted" || action === "unsuspend") {
    await db.batch([
      db.prepare(
        `INSERT INTO orgs (github_login, installation_id) VALUES (?, ?)
         ON CONFLICT(github_login) DO UPDATE SET installation_id = excluded.installation_id`
      ).bind(accountLogin, installationId),
      db.prepare(
        `UPDATE orgs SET installation_id = NULL
         WHERE installation_id = ? AND github_login != ?`
      ).bind(installationId, accountLogin),
    ]);
    try {
      // installation.created carries the initial repo list in payload.repositories.
      // Other actions don't, so we pass null and let COALESCE preserve it.
      const repos = action === "created" && Array.isArray(payload.repositories)
        ? JSON.stringify(payload.repositories.map((r) => r.full_name).filter(Boolean))
        : null;
      await upsertInstallation(db, payload.installation, repos);
      await storeEvent(db, "installation", deliveryId, payload, accountLogin);
    } catch (err) {
      await reportWebhookFailure(db, accountLogin, "installation_sync", deliveryId, err, { action });
    }

    // Auto-bootstrap: backfill repos+members+features+per-repo issues/PRs.
    // Run via waitUntil so the webhook returns within GitHub's 10s timeout
    // even if the bootstrap takes longer for orgs with many repos.
    // Re-bootstrap on `unsuspend` too — state may have drifted while suspended.
    const orgRow = await db
      .prepare("SELECT id FROM orgs WHERE github_login = ?")
      .bind(accountLogin)
      .first();
    if (orgRow?.id) {
      await enqueueTask(context.env, accountLogin, deliveryId, {
        type: TASK.BOOTSTRAP,
        orgId: orgRow.id,
        accountLogin,
        installationId,
      });
    }
    return jsonResponse({ ok: true, event: "installation", action, org: accountLogin, bootstrapping: true });
  }

  if (action === "deleted" || action === "suspend") {
    await db
      .prepare("UPDATE orgs SET installation_id = NULL WHERE installation_id = ?")
      .bind(installationId)
      .run();
    try {
      await storeEvent(db, "installation", deliveryId, payload, accountLogin);
    } catch (err) {
      await reportWebhookFailure(db, accountLogin, "installation_event_log", deliveryId, err, { action });
    }
    return jsonResponse({ ok: true, event: "installation", action, org: accountLogin });
  }

  return jsonResponse({ ok: true, event: "installation", skipped: `unhandled action: ${action}` });
}

// `installation_repositories` fires when an admin grants the App access to
// new repos (or removes some) post-install. Three responsibilities:
//   1. Keep installations.repos_json in sync with what GitHub thinks we can
//      see — that table is the source of truth for `/api/projects`.
//   2. For added repos, kick off a backfill via syncRepo so issues + PRs
//      land in D1 within seconds instead of waiting for the next reconcile.
//   3. Log the event for the feed.
async function handleInstallationReposEvent(context, payload, deliveryId) {
  const db = context.env.DB;
  const installationId = payload.installation?.id;
  const accountLogin = payload.installation?.account?.login;
  const action = payload.action;

  if (installationId) {
    try {
      const current = new Set(await getInstallationRepos(db, installationId));
      for (const r of payload.repositories_added ?? []) {
        if (r?.full_name) current.add(r.full_name);
      }
      for (const r of payload.repositories_removed ?? []) {
        if (r?.full_name) current.delete(r.full_name);
      }
      await setInstallationRepos(db, installationId, [...current]);
    } catch (err) {
      await reportWebhookFailure(db, accountLogin, "setInstallationRepos", deliveryId, err);
    }
  }

  if (accountLogin) {
    try {
      await storeEvent(db, "installation_repositories", deliveryId, payload, accountLogin);
    } catch (err) {
      await reportWebhookFailure(db, accountLogin, "storeEvent_installation_repositories", deliveryId, err);
    }
  }

  // Repositories removed from the installation become inactive, but their
  // cached PR/issue history remains available to time-aware analytics.
  const orgRow = accountLogin
    ? await db.prepare("SELECT id FROM orgs WHERE github_login = ?").bind(accountLogin).first()
    : null;

  if (orgRow?.id && Array.isArray(payload.repositories_removed)) {
    for (const r of payload.repositories_removed) {
      const name = r?.name ?? (r?.full_name?.split("/")[1] ?? null);
      if (!name) continue;
      try {
        await removeRepo(db, orgRow.id, name, "installation_removed");
      } catch (err) {
        await reportWebhookFailure(db, accountLogin, "removeRepo", deliveryId, err, { repo: name });
      }
    }
  }

  // Backfill added repos via the queue — one durable, independently-retried
  // job per repo. Keeps the webhook fast and avoids GitHub's 10s timeout for
  // orgs that grant access to many repos at once.
  //
  // Inline (before enqueueing) we also upsert the bare `repos` row stamped
  // with discovered_at so the Newly-detected UI surfaces the repo within
  // seconds — TASK.SYNC_REPO only syncs PRs/issues and assumes a row exists.
  // Track which repos were truly new (not re-added) so the auto-exclude
  // policy only applies to genuinely-fresh discoveries.
  if (orgRow?.id && installationId && Array.isArray(payload.repositories_added) && payload.repositories_added.length > 0) {
    const repoNames = payload.repositories_added
      .map((r) => r?.name ?? (r?.full_name?.split("/")[1] ?? null))
      .filter(Boolean);
    const newlyDiscovered = [];
    for (const repo of repoNames) {
      try {
        const wasNew = await upsertDiscoveredRepo(db, orgRow.id, repo);
        if (wasNew) newlyDiscovered.push(repo);
      } catch (err) {
        await reportWebhookFailure(db, accountLogin, "upsertDiscoveredRepo", deliveryId, err, { repo });
      }
      await enqueueTask(context.env, accountLogin, repo, {
        type: TASK.SYNC_REPO,
        orgId: orgRow.id,
        accountLogin,
        installationId,
        repo,
      });
    }
    if (newlyDiscovered.length > 0) {
      try {
        await applyNewRepoExcludePolicy(db, accountLogin, newlyDiscovered);
      } catch (err) {
        await reportWebhookFailure(db, accountLogin, "applyNewRepoExcludePolicy", deliveryId, err);
      }
    }
  }

  return jsonResponse({ ok: true, event: "installation_repositories", action });
}
