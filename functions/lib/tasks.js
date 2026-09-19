// Shared contract for the durable background-work queue (`TASK_QUEUE`).
//
// Producer: functions/api/webhook.js enqueues instead of running work in
// `context.waitUntil` (which has no retry and is lost on failure/eviction).
// Consumer: the cron Worker's `queue()` handler (cron/src/index.js) drains it
// with retries + a dead-letter queue.
//
// Kept as plain JS because it's imported by both the JS webhook (Pages) and the
// JS cron Worker — avoids mixing a .ts module into the cron esbuild bundle.

export const TASK = {
  NARRATE: "narrate",                 // { eventId }            -> narrateEvent(env, eventId)
  RELEASE_NOTES: "release_notes",     // { eventId }            -> narrateReleaseNotes(env, eventId)
  NARRATE_PR_OPENED: "narrate_pr_opened", // { eventId }        -> narratePrOpened(env, eventId)
  BOOTSTRAP: "bootstrap",             // { orgId, accountLogin, installationId }
  SYNC_REPO: "sync_repo",             // { orgId, accountLogin, installationId, repo }
  SPOT_CREATE_GITHUB_ISSUE: "spot_create_github_issue", // transient capture → GitHub issue
  SPOT_SEND_RESOLUTION_EMAIL: "spot_send_resolution_email", // durable NoxSpot reporter notification
  NOXCUE_GITHUB_ISSUE: "noxcue_github_issue", // durable NoxCue incident → create/update GitHub issue
  DELIVER_SLACK: "deliver_slack",       // { outboxId } → durable delivery_outbox row
};

// Enqueue a task. Never throws into the caller: a missing binding or transient
// send error is recorded to op_failures (admin-visible) so the webhook still
// returns 200 and the upserts it already did are preserved. The 30-min cron
// reconcile is the safety net that re-derives anything lost here.
export async function enqueueTask(env, ownerId, deliveryId, message) {
  try {
    // Stamp ownerId/deliveryId so the consumer can attribute terminal failures.
    await env.TASK_QUEUE.send({ ...message, ownerId, deliveryId });
  } catch (err) {
    console.error(`[noxconnect queue] enqueue ${message.type} failed:`, err?.message ?? err);
    // Best-effort failure logging — wrapped so the "never throws into the
    // caller" contract holds even if the import or recordFailure itself fails.
    try {
      const { recordFailure } = await import("./op-failures.js");
      await recordFailure(env.DB, {
        ownerId,
        op: `enqueue:${message.type}`,
        deliveryId,
        error: err,
      });
    } catch (logErr) {
      console.error("[noxconnect queue] recordFailure failed:", logErr?.message ?? logErr);
    }
  }
}
