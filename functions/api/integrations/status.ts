import { getCtx, jsonResponse, errorResponse } from "../../lib/db";
import { resolveSlackChannels, resolveSlackInstall, slackInstallNeedsReconnect } from "../../lib/slack";
import { getNoxDb, type NoxDatabaseEnv } from "../../lib/nox-db";
import { GITHUB_INSTALL_URL, GITHUB_MANAGE_URL } from "../../lib/integration-connections.js";

interface Ctx {
  env: NoxDatabaseEnv & {
    GITHUB_APP_ID?: string;
    GITHUB_APP_PRIVATE_KEY?: string;
    SLACK_CLIENT_ID?: string;
    SLACK_CLIENT_SECRET?: string;
    SLACK_SIGNING_SECRET?: string;
    SLACK_APP_ID?: string;
    SLACK_ACCEPT_LEGACY_INSTALLS?: string;
  };
  data: { orgId: number; orgLogin: string; projectId?: string | null; isAdmin: boolean };
}

// Organization-level integration overview. This is the only status contract
// the UI needs for external systems; it deliberately returns no credentials.
export async function onRequestGet(context: Ctx): Promise<Response> {
  const { orgId, orgLogin, projectId, isAdmin } = getCtx(context) as Ctx["data"];
  if (!orgId || !orgLogin) return errorResponse("Missing org context", 400);
  const db = getNoxDb(context.env);

  const slackDeliveriesStatement = projectId
    ? db.prepare(
      `SELECT
         SUM(CASE WHEN status IN ('pending','queued','processing','retrying') THEN 1 ELSE 0 END) AS pending_count,
         SUM(CASE WHEN status IN ('blocked_configuration','failed') THEN 1 ELSE 0 END) AS blocked_count,
         MAX(delivered_at) AS last_delivered_at
       FROM delivery_outbox WHERE org_id = ? AND project_id = ? AND destination = 'slack'`,
    ).bind(orgId, projectId)
    : db.prepare(
      `SELECT
         SUM(CASE WHEN status IN ('pending','queued','processing','retrying') THEN 1 ELSE 0 END) AS pending_count,
         SUM(CASE WHEN status IN ('blocked_configuration','failed') THEN 1 ELSE 0 END) AS blocked_count,
         MAX(delivered_at) AS last_delivered_at
       FROM delivery_outbox WHERE org_id = ? AND destination = 'slack'`,
    ).bind(orgId);

  const [org, installation, slackInstall, slackChannels, slackMetadata, slackDeliveries] = await Promise.all([
    db.prepare(
      "SELECT installation_id, bootstrapped_at, last_event_at FROM orgs WHERE id = ?",
    ).bind(orgId).first<Record<string, unknown>>(),
    db.prepare(
      `SELECT installation_id, account_login, account_type, health_status
         FROM installations WHERE owner_id = ? AND account_login = ? LIMIT 1`,
    ).bind(orgLogin, orgLogin).first<Record<string, unknown>>(),
    resolveSlackInstall(context.env, orgId),
    resolveSlackChannels(db, orgId, projectId),
    db.prepare(
      `SELECT health_status, last_checked_at, last_error FROM slack_connections
        WHERE org_id = ? ORDER BY is_default DESC, installed_at LIMIT 1`,
    ).bind(orgId).first<Record<string, unknown>>(),
    slackDeliveriesStatement.first<Record<string, unknown>>(),
  ]);

  const installationId = installation?.installation_id ?? org?.installation_id ?? null;
  const githubConfigured = Boolean(context.env.GITHUB_APP_ID && context.env.GITHUB_APP_PRIVATE_KEY);
  const githubConnected = Boolean(installationId);
  const githubBootstrapping = Boolean(installationId && !org?.bootstrapped_at);
  const githubNeedsAttention = installation?.health_status === "silent";
  const githubReady = githubConfigured && githubConnected && !githubBootstrapping && !githubNeedsAttention;
  const slackConfigured = Boolean(
    context.env.SLACK_CLIENT_ID
    && context.env.SLACK_CLIENT_SECRET
    && context.env.SLACK_SIGNING_SECRET,
  );
  const slackConnected = Boolean(slackInstall);
  const slackNeedsReconnect = slackInstallNeedsReconnect(context.env, slackInstall);
  const slackDegraded = slackMetadata?.health_status === "degraded";
  const slackReady = slackConfigured && slackConnected && !slackNeedsReconnect && !slackDegraded;

  const response = jsonResponse({
    canConfigure: Boolean(isAdmin),
    setup: {
      ready: githubReady,
      needsOnboarding: !githubReady,
      requiredConnection: "github",
    },
    features: {
      feed: {
        state: githubReady ? "ready" : "blocked",
        requirements: ["github"],
        optionalConnections: ["slack"],
      },
      noxSpot: {
        state: githubReady ? "ready" : "blocked",
        requirements: ["github"],
        optionalConnections: ["slack"],
      },
      noxCue: {
        state: slackReady ? "ready" : "blocked",
        requirements: ["slack"],
        prerequisitesReady: slackReady,
      },
    },
    github: {
      connected: githubConnected,
      configured: githubConfigured,
      installationId,
      accountLogin: installation?.account_login ?? orgLogin,
      accountType: installation?.account_type ?? null,
      bootstrapping: githubBootstrapping,
      health: installation?.health_status ?? "ok",
      lastEventAt: org?.last_event_at ?? null,
      manageUrl: GITHUB_MANAGE_URL,
      installUrl: GITHUB_INSTALL_URL,
    },
    slack: {
      connected: slackConnected,
      configured: slackConfigured,
      needsReconnect: slackNeedsReconnect,
      teamId: slackInstall?.teamId ?? null,
      teamName: slackInstall?.teamName ?? null,
      connectionId: slackInstall?.id ?? null,
      defaultChannelId: slackChannels.fallbackChannelId || null,
      channels: {
        fallback: slackChannels.fallbackChannelId || null,
        noxCue: slackChannels.noxCueChannelId || null,
        noxticket: slackChannels.noxTicketChannelId || null,
        noxFeed: slackChannels.noxFeedChannelId || null,
        noxFeedPosts: slackChannels.postsChannelId || null,
        noxFeedReleaseNotes: slackChannels.releaseNotesChannelId || null,
        noxFeedDailySummary: slackChannels.dailySummaryChannelId || null,
      },
      health: !slackMetadata ? "disconnected" : !slackInstall ? "degraded" : slackMetadata.health_status ?? "unknown",
      lastCheckedAt: slackMetadata?.last_checked_at ?? null,
      lastError: slackMetadata?.last_error ?? null,
      pendingDeliveries: Number(slackDeliveries?.pending_count ?? 0),
      blockedDeliveries: Number(slackDeliveries?.blocked_count ?? 0),
      lastDeliveredAt: slackDeliveries?.last_delivered_at ?? null,
    },
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
