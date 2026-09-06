import { queueOutboxDelivery, stageSlackDelivery } from "./delivery-outbox.js";
import { getNoxTicketRepoName } from "./inactive-repos.js";
import { resolveSlackChannels, resolveSlackConnectionId, resolveSlackRoute } from "./slack.js";
import { isAppEnabled } from "./apps.js";
import { buildNoxTicketActivityResponse } from "../products/noxticket/response.js";

const TICKET_ACTIONS = new Set(["opened", "closed", "reopened"]);

export async function stageNoxTicketActivity(env, { orgId, ownerId, repo, action, issue, actor }) {
  if (!(await isAppEnabled(env.DB, orgId, "noxticket"))) return { skipped: "service_disabled" };
  if (!TICKET_ACTIONS.has(action) || !issue?.number) return { skipped: "unsupported_event" };
  const noxTicketRepo = await getNoxTicketRepoName(env.DB, orgId);
  if (repo !== noxTicketRepo || hasLabel(issue, "noxspot")) return { skipped: "not_noxticket" };
  const channels = await resolveSlackChannels(env.DB, orgId);
  const channelId = resolveSlackRoute(channels, "noxticket");
  const connectionId = resolveSlackConnectionId(channels, "noxticket");
  if (!channelId) return { skipped: "channel_not_configured" };

  const message = env.NOXTICKET_SERVICE?.buildActivityMessage
    ? await env.NOXTICKET_SERVICE.buildActivityMessage({ orgId, repo, action, issue, actor })
    : buildNoxTicketActivityResponse({ orgId, repo, action, issue, actor }).message;
  const response = { message };
  const delivery = await stageSlackDelivery(env.DB, {
    orgId,
    source: "noxticket",
    sourceId: `${repo}:${issue.number}:${action}`,
    siteId: null,
    connectionId,
    channelId,
    payload: response,
  });
  if (delivery?.id && delivery.status !== "delivered") {
    await queueOutboxDelivery(env, delivery.id, ownerId);
  }
  return { queued: Boolean(delivery?.id), channelId };
}

function hasLabel(issue, expected) {
  return (issue?.labels ?? []).some((label) =>
    String(typeof label === "string" ? label : label?.name ?? "").toLowerCase() === expected);
}
