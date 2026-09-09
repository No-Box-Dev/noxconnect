// NoxConnect reconciliation cron.
//
// Fires every 30 min. Walks every org with an active GitHub App
// installation and reconciles D1 against GitHub. Webhooks handle the
// fast path; this catches deletes, missed deliveries, and any drift
// that accumulates between events.
//
// See migrations/0013_reconcile_observability.sql for the
// `reconcile_runs` table this writes to.

import { reconcileOrg } from "./reconcile.js";
import { archiveOldEvents } from "./archive-events.js";
import { TASK } from "../../functions/lib/tasks.js";
import { narrateEvent, narrateReleaseNotes, narratePrOpened } from "../../functions/lib/narrator.js";
import { bootstrapInstallation, syncRepo } from "../../functions/lib/github-sync.js";
import { getInstallationToken } from "../../functions/lib/github-app.js";
import { recordFailure } from "../../functions/lib/op-failures.js";
import { runNextStatsAudit } from "./stats-audit.js";
import { runDatabaseRecoveryStep } from "./database-recovery.js";
import { createNoxSpotGitHubIssue } from "../../functions/lib/noxspot.js";
import { deliverSlackOutbox, markOutboxFailed, recoverOutboxDeliveries, requeueBlockedForOrg } from "../../functions/lib/delivery-outbox.js";
import { checkSlackOrgHealth } from "../../functions/lib/slack.js";
import { runNoxCueDigests } from "./noxcue-digests.js";
import { runNoxSpotDailyDigests } from "./noxspot-digests.js";
import { runNoxFeedDailySummaries } from "./noxfeed-daily-summaries.js";
import { createOrUpdateNoxCueGitHubIssue, recoverNoxCueGithubIncidents } from "../../functions/lib/noxcue-github.js";
import { runOperationalAlerts } from "./operational-alerts.js";

// Cap concurrent orgs per tick to keep GitHub API consumption bounded.
// Tune up once we measure real numbers.
const MAX_ORGS_PER_TICK = 10;

// Cloudflare delivers a message up to (1 + max_retries) times (msg.attempts is
// 1-based). We record the terminal failure on the FINAL delivery, so this must
// equal max_retries + 1 (max_retries is set in cron/wrangler.toml).
const MAX_DELIVERIES = 5;

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runTick(env, event.scheduledTime));
    // Daily event-table archival/retention — gated to the 03:00 UTC ticks so it
    // runs roughly once a day rather than every 30 min. Idempotent, so the two
    // 03:xx ticks just drain any backlog left by the per-run cap.
    if (new Date(event.scheduledTime).getUTCHours() === 3) {
      ctx.waitUntil(
        archiveOldEvents(env, event.scheduledTime).catch((err) =>
          console.error("[noxconnect-cron] event archival failed:", err?.message ?? err),
        ),
      );
    }
  },

  // Durable background work, produced by functions/api/webhook.js. Replaces the
  // webhook's old context.waitUntil calls — these now get retries + a DLQ.
  async queue(batch, env) {
    for (const msg of batch.messages) {
      try {
        await handleTask(env, msg.body);
        msg.ack();
      } catch (err) {
        console.error(`[noxconnect-cron] task ${msg.body?.type} failed (attempt ${msg.attempts}):`, err?.message ?? err);
        if (msg.attempts >= MAX_DELIVERIES) {
          // Out of retries — record to the admin-visible op_failures table and
          // ack so it doesn't loop forever (the DLQ is the backstop in config).
          await recordFailure(env.DB, {
            ownerId: msg.body?.ownerId ?? null,
            op: `task:${msg.body?.type ?? "unknown"}`,
            deliveryId: msg.body?.deliveryId ?? null,
            error: err,
          });
          if (msg.body?.type === TASK.DELIVER_SLACK && msg.body?.outboxId) {
            await markOutboxFailed(env.DB, msg.body.outboxId, err);
          }
          msg.ack();
        } else {
          msg.retry();
        }
      }
    }
  },

  // Manual trigger for `wrangler dev --test-scheduled` and curl /__scheduled.
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/__scheduled") {
      ctx.waitUntil(runTick(env));
      return new Response("ok\n");
    }
    if (url.pathname === "/__archive-events") {
      const result = await archiveOldEvents(env, Date.now());
      return new Response(`${JSON.stringify(result)}\n`);
    }
    if (url.pathname === "/__recover") {
      const result = await runDatabaseRecoveryStep(env);
      return Response.json(result);
    }
    return new Response("not found", { status: 404 });
  },
};

// Dispatch a queued task to the same helpers the webhook used to call inline.
async function handleTask(env, body) {
  switch (body?.type) {
    case TASK.NARRATE:
      return narrateEvent(env, body.eventId);
    case TASK.RELEASE_NOTES:
      return narrateReleaseNotes(env, body.eventId);
    case TASK.NARRATE_PR_OPENED:
      return narratePrOpened(env, body.eventId);
    case TASK.BOOTSTRAP:
      return bootstrapInstallation(env, body.orgId, body.accountLogin, body.installationId);
    case TASK.SYNC_REPO: {
      const token = await getInstallationToken(env, body.installationId);
      return syncRepo(env.DB, token, body.orgId, body.accountLogin, body.repo, true);
    }
    case TASK.SPOT_CREATE_GITHUB_ISSUE:
      return createNoxSpotGitHubIssue(env, body);
    case TASK.NOXCUE_GITHUB_ISSUE:
      return createOrUpdateNoxCueGitHubIssue(env, body);
    case TASK.DELIVER_SLACK:
      return deliverSlackOutbox(env, body.outboxId);
    default:
      throw new Error(`unknown task type: ${body?.type}`);
  }
}

async function runTick(env, nowMs = Date.now()) {
  const db = env.DB;

  await recoverOutboxDeliveries(env);
  try {
    await recoverNoxCueGithubIncidents(env);
  } catch (err) {
    console.error("[noxconnect-cron] NoxCue GitHub issue recovery failed:", err?.message ?? err);
  }
  await runSlackHealthSweep(env);
  try {
    await runOperationalAlerts(env);
  } catch (err) {
    console.error(JSON.stringify({
      event: "operational_alert_sweep_failed",
      error: err instanceof Error ? err.message : String(err),
    }));
  }
  await healOrgInstallationLinks(db);

  try {
    await runNoxCueDigests(env, nowMs);
  } catch (err) {
    console.error("[noxconnect-cron] NoxCue digest sweep failed:", err?.message ?? err);
  }

  try {
    await runNoxSpotDailyDigests(env, nowMs);
  } catch (err) {
    console.error("[noxconnect-cron] NoxSpot daily digest sweep failed:", err?.message ?? err);
  }

  try {
    await runNoxFeedDailySummaries(env, nowMs);
  } catch (err) {
    console.error("[noxconnect-cron] NoxFeed daily summary sweep failed:", err?.message ?? err);
  }

  // Process at most one explicitly-requested source-of-truth audit per tick.
  // Each request is bounded to 120 monthly GitHub Search calls and is durable
  // in D1, so a failed audit is visible instead of silently skewing metrics.
  try {
    await runNextStatsAudit(env);
  } catch (err) {
    console.error("[noxconnect-cron] stats audit failed:", err?.message ?? err);
  }

  try {
    await runDatabaseRecoveryStep(env);
  } catch (err) {
    console.error("[noxconnect-cron] database recovery step failed:", err?.message ?? err);
  }

  const orgs = await db
    .prepare(
      `SELECT id, github_login, installation_id
       FROM orgs
       WHERE installation_id IS NOT NULL AND bootstrapped_at IS NOT NULL
       ORDER BY id
       LIMIT ?`
    )
    .bind(MAX_ORGS_PER_TICK)
    .all();

  for (const org of orgs.results ?? []) {
    try {
      await reconcileOrg(env, db, org.id, org.github_login, org.installation_id);
    } catch (err) {
      console.error(
        `[noxconnect-cron] org=${org.github_login} reconcile failed:`,
        err?.message ?? err,
      );
    }
  }
}

async function runSlackHealthSweep(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, org_id FROM slack_connections
      WHERE last_checked_at IS NULL
         OR last_checked_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-30 minutes')
      ORDER BY COALESCE(last_checked_at, '')
      LIMIT 10`,
  ).all();
  for (const row of results ?? []) {
    try {
      const health = await checkSlackOrgHealth(env, row.org_id, row.id);
      if (health.recovered) await requeueBlockedForOrg(env, row.org_id);
    } catch (error) {
      console.error(JSON.stringify({
        event: "slack_health_check_failed",
        orgId: row.org_id,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }
}

// Self-heal: link `orgs` rows to their matching `installations` row and
// stamp `bootstrapped_at` whenever either is missing. Covers orgs that
// predate the bootstrap-on-install path (Slice 1) and any future row
// that lands in D1 without those columns set. Idempotent — once both
// columns are populated the row drops out of the WHERE clause.
async function healOrgInstallationLinks(db) {
  const res = await db
    .prepare(
      `UPDATE orgs SET
         installation_id = (SELECT installation_id FROM installations WHERE account_login = orgs.github_login),
         bootstrapped_at = COALESCE(bootstrapped_at, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
       WHERE (installation_id IS NULL OR bootstrapped_at IS NULL)
         AND EXISTS (SELECT 1 FROM installations WHERE account_login = orgs.github_login)`,
    )
    .run();
  const changed = res?.meta?.changes ?? 0;
  if (changed > 0) {
    console.log(`[noxconnect-cron] healed ${changed} org→installation link(s)`);
  }
}
