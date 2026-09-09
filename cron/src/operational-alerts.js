import { queueOutboxDelivery, stageSlackDelivery } from "../../functions/lib/delivery-outbox.js";
import { resolveSlackChannels, resolveSlackConnectionId, resolveSlackRoute } from "../../functions/lib/slack.js";

const ALERT_LIMIT = 20;
const LOOKBACK = "-24 hours";

export async function runOperationalAlerts(env) {
  const candidates = await loadCandidates(env.DB);
  const routes = new Map();
  let queued = 0;
  let skipped = 0;

  for (const candidate of candidates) {
    let route = routes.get(candidate.org_id);
    if (!route) {
      const channels = await resolveSlackChannels(env.DB, candidate.org_id);
      route = {
        channelId: resolveSlackRoute(channels, "operations"),
        connectionId: resolveSlackConnectionId(channels, "operations"),
      };
      routes.set(candidate.org_id, route);
    }

    if (!route.channelId) {
      skipped += 1;
      console.warn(JSON.stringify({
        event: "operational_alert_unroutable",
        orgId: candidate.org_id,
        alertKind: candidate.kind,
        sourceId: candidate.source_id,
      }));
      continue;
    }

    const delivery = await stageSlackDelivery(env.DB, {
      orgId: candidate.org_id,
      source: "operations",
      sourceId: candidate.source_id,
      siteId: null,
      connectionId: route.connectionId,
      channelId: route.channelId,
      payload: { message: operationalMessage(candidate) },
    });
    if (delivery?.status === "delivered") continue;
    if (delivery?.id && await queueOutboxDelivery(env, delivery.id, candidate.org_login)) queued += 1;
  }

  if (candidates.length) {
    console.log(JSON.stringify({
      event: "operational_alert_sweep",
      candidates: candidates.length,
      queued,
      skipped,
    }));
  }
  return { candidates: candidates.length, queued, skipped };
}

async function loadCandidates(db) {
  const [failures, deliveries] = await Promise.all([
    db.prepare(
      `SELECT org.id AS org_id, org.github_login AS org_login,
              'operation_failure' AS kind,
              'op_failure:' || CAST(failure.id AS TEXT) AS source_id,
              failure.op AS subject, failure.error AS detail,
              failure.occurred_at AS occurred_at
         FROM op_failures failure
         JOIN orgs org ON lower(org.github_login) = lower(failure.owner_id)
        WHERE failure.occurred_at >= datetime('now', ?)
          AND NOT EXISTS (
            SELECT 1 FROM delivery_outbox alert
             WHERE alert.source = 'operations'
               AND alert.source_id = 'op_failure:' || CAST(failure.id AS TEXT)
          )
        ORDER BY failure.occurred_at
        LIMIT ?`,
    ).bind(LOOKBACK, ALERT_LIMIT).all(),
    db.prepare(
      `SELECT org.id AS org_id, org.github_login AS org_login,
              'delivery_failure' AS kind,
              'delivery_failure:' || delivery.id AS source_id,
              delivery.source AS subject,
              COALESCE(delivery.last_error, delivery.last_error_code, 'Delivery failed') AS detail,
              delivery.updated_at AS occurred_at
         FROM delivery_outbox delivery
         JOIN orgs org ON org.id = delivery.org_id
        WHERE delivery.source != 'operations'
          AND delivery.status IN ('failed', 'blocked_configuration')
          AND delivery.updated_at >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?)
          AND NOT EXISTS (
            SELECT 1 FROM delivery_outbox alert
             WHERE alert.source = 'operations'
               AND alert.source_id = 'delivery_failure:' || delivery.id
          )
        ORDER BY delivery.updated_at
        LIMIT ?`,
    ).bind(LOOKBACK, ALERT_LIMIT).all(),
  ]);
  return [...(failures.results ?? []), ...(deliveries.results ?? [])]
    .sort((left, right) => String(left.occurred_at).localeCompare(String(right.occurred_at)))
    .slice(0, ALERT_LIMIT);
}

function operationalMessage(candidate) {
  const isDelivery = candidate.kind === "delivery_failure";
  const title = isDelivery ? "Nox delivery needs attention" : "Nox background operation failed";
  const detail = safeDetail(candidate.detail);
  return {
    text: `${title}: ${candidate.subject}`,
    blocks: [
      { type: "header", text: { type: "plain_text", text: title } },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Service*\n${slackText(candidate.subject, 120)}` },
          { type: "mrkdwn", text: `*Detected*\n${slackText(candidate.occurred_at, 80)}` },
        ],
      },
      { type: "section", text: { type: "mrkdwn", text: `*What happened*\n${slackText(detail, 700)}` } },
      {
        type: "context",
        elements: [{
          type: "mrkdwn",
          text: isDelivery
            ? "Open NoxConnect → Admin → Slack and repair the affected route, then send a test."
            : "Open NoxConnect → Operator to inspect the recorded failure.",
        }],
      },
    ],
  };
}

function safeDetail(value) {
  return String(value ?? "Unknown failure")
    .split("\n", 1)[0]
    .replace(/https?:\/\/\S+/gi, "[url removed]")
    .replace(/(?:gh[opsu]_|github_pat_|xox[baprs]-|nox_(?:sk|at|rt)_)[A-Za-z0-9._-]+/g, "[credential removed]")
    .slice(0, 700);
}

function slackText(value, limit) {
  return String(value ?? "unknown")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .slice(0, limit);
}

