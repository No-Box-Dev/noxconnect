import { getInstallationIdForOrg, getInstallationToken } from "./github-app.js";
import { upsertIssue } from "./github-sync.js";
import {
  createRepositoryIssue,
  ensureRepositoryLabels,
  findIssueByBodyMarker,
} from "./github-issues.js";
import {
  queueOutboxDelivery,
  stageSlackDelivery,
} from "./delivery-outbox.js";
import { resolveSlackChannels, resolveSlackConnectionId, resolveSlackRoute } from "./slack.js";
import { getNoxSpotIssueResponse, getNoxSpotSlackResponse } from "./noxspot-response.js";
import { isAppEnabled } from "./apps.js";
import { storeNoxSpotReport } from "./noxspot-resolution.js";

export async function createNoxSpotGitHubIssue(env, capture) {
  requireCapture(capture);
  if (!(await isAppEnabled(env.DB, capture.orgId, "noxspot"))) {
    return { skipped: "service_disabled", service: "noxspot" };
  }
  const resolvedCapture = await resolveCaptureFromSetup(env.DB, capture);
  const installationId = await getInstallationIdForOrg(env.DB, resolvedCapture.orgId);
  if (!installationId) throw new Error(`GitHub App not installed for org ${resolvedCapture.orgId}`);
  const token = await getInstallationToken(env, installationId);
  const response = await getNoxSpotIssueResponse(env, resolvedCapture);

  const marker = response.idempotencyMarker;
  let issue = await findIssueByBodyMarker(token, resolvedCapture.ownerId, resolvedCapture.repo, marker);
  if (!issue) {
    await ensureRepositoryLabels(token, resolvedCapture.ownerId, resolvedCapture.repo, response.issue.labels);
    issue = await createRepositoryIssue(token, resolvedCapture.ownerId, resolvedCapture.repo, {
      title: response.issue.title,
      body: response.issue.body,
      labels: response.issue.labels.map((label) => label.name),
    });
  }

  await upsertIssue(env.DB, resolvedCapture.orgId, resolvedCapture.repo, issue);
  await storeNoxSpotReport(env, resolvedCapture, issue);
  await storeEvent(env.DB, resolvedCapture, issue);
  const slackChannels = await resolveSlackChannels(env.DB, resolvedCapture.orgId, resolvedCapture.projectId);
  const slackChannelId = resolveSlackRoute(
    slackChannels,
    "noxspot",
    resolvedCapture.slackChannelId,
  );
  const slackConnectionId = resolveSlackConnectionId(
    slackChannels,
    "noxspot",
    resolvedCapture.slackChannelId ? resolvedCapture.slackConnectionId : "",
  );
  if (slackChannelId) {
    const slackResponse = await getNoxSpotSlackResponse(env, resolvedCapture, issue);
    const delivery = await stageSlackDelivery(env.DB, {
      orgId: resolvedCapture.orgId,
      projectId: resolvedCapture.projectId,
      source: "noxspot",
      sourceId: resolvedCapture.captureId,
      siteId: resolvedCapture.siteId,
      connectionId: slackConnectionId,
      channelId: slackChannelId,
      payload: { message: slackResponse.message },
    });
    if (delivery?.id && delivery.status !== "delivered") {
      await queueOutboxDelivery(env, delivery.id, resolvedCapture.ownerId);
    }
  }
  return { number: issue.number, url: issue.html_url };
}

async function resolveCaptureFromSetup(db, capture) {
  const site = await db.prepare(
    `SELECT site.name AS site_name, site.repo, site.project_id,
            site.slack_channel_id, site.slack_connection_id,
            org.github_login AS owner_id
       FROM spot_sites site
       JOIN orgs org ON org.id = site.org_id
      WHERE site.id = ? AND site.org_id = ?
      LIMIT 1`,
  ).bind(capture.siteId, capture.orgId).first();
  if (!site?.owner_id || !site?.repo) {
    throw new Error(`NoxSpot site ${capture.siteId} is not configured for org ${capture.orgId}`);
  }

  const resolved = {
    ...capture,
    ownerId: site.owner_id,
    repo: site.repo,
    projectId: site.project_id ?? null,
    siteName: site.site_name ?? capture.siteId,
    slackChannelId: site.slack_channel_id ?? null,
    slackConnectionId: site.slack_connection_id ?? null,
  };
  if (!capture.reporter) return resolved;
  const requestedLogin = String(capture.reporter).trim().replace(/^@/, '');
  if (!requestedLogin) return resolved;
  const member = await db.prepare(
    `SELECT login FROM members
      WHERE org_id = ? AND kind = 'human' AND lower(login) = lower(?)
      LIMIT 1`,
  ).bind(capture.orgId, requestedLogin).first();
  return member?.login
    ? { ...resolved, reporterGithubLogin: member.login }
    : resolved;
}

function requireCapture(capture) {
  // Version-less tasks are accepted temporarily so messages produced by the
  // legacy NoxSpot Worker can drain during cutover. Every NoxConnect-owned
  // producer emits version 1; unknown explicit versions fail into Queue retry
  // and the DLQ instead of being interpreted with the wrong contract.
  if (capture?.version !== undefined && capture.version !== 1) {
    throw new Error(`Unsupported NoxSpot capture version: ${capture.version}`);
  }
  // Repository and routing identity are deliberately resolved again from the
  // organization-scoped site row instead of trusting Queue input.
  for (const field of ["captureId", "orgId", "siteId", "title"]) {
    if (!capture?.[field]) throw new Error(`Invalid NoxSpot capture: missing ${field}`);
  }
}

async function storeEvent(db, capture, issue) {
  await db.prepare(
    `INSERT INTO events
       (delivery_id, source, type, actor_id, project_id, org, repo, summary, payload_json, owner_id)
     VALUES (?, 'noxspot', 'spot:issue_created', ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(delivery_id) DO UPDATE SET
       summary = excluded.summary, payload_json = excluded.payload_json`,
  ).bind(
    capture.deliveryId || `noxspot:${capture.captureId}`,
    capture.reporterGithubLogin || capture.reporter || "anonymous",
    capture.projectId || null,
    capture.ownerId,
    capture.repo,
    capture.title,
    JSON.stringify({
      product: "noxspot",
      issueId: String(issue.number),
      githubIssueNumber: issue.number,
      githubIssueUrl: issue.html_url,
      siteId: capture.siteId,
      siteName: capture.siteName,
      issueType: capture.issueType,
      description: capture.description ?? null,
      reporter: capture.reporterGithubLogin || capture.reporter || null,
      captureId: capture.captureId,
      notificationRequested: capture.notifyOnResolution === true && Boolean(capture.reporterEmail),
      screenshotUrl: capture.screenshotUrl ?? null,
      shareUrl: issue.html_url,
    }),
    capture.ownerId,
  ).run();
}
