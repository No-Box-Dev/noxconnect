import { getCtx, errorResponse, jsonResponse } from "../../../lib/db";
import { onRequestGet as getConnections } from "../connections/index";
import { readSlackSettings, resolveSavedSlackChannel } from "../../../lib/slack-settings";
import { INTEGRATION_DISCOVERY_LINK, SLACK_ROUTING_BODY_SCHEMA } from "../../../lib/integration-discovery";

interface ConnectionState {
  id: string;
  connected: boolean;
}

interface ConnectionsResponse {
  connections: ConnectionState[];
}

interface Ctx {
  env: Record<string, unknown> & { DB: D1Database };
  data: { orgId: number; orgLogin: string; projectId?: string | null; isAdmin: boolean };
}

function apiAction(method: string, href: string, bodySchema?: Record<string, unknown>) {
  return { method, href, ...(bodySchema ? { bodySchema } : {}) };
}

// GET /api/v1/integrations/setup
// A resumable, machine-readable setup plan. Agents poll this endpoint after a
// human completes either OAuth handoff and execute every available API action.
export async function onRequestGet(context: Ctx): Promise<Response> {
  const { orgId, orgLogin, projectId, isAdmin } = getCtx(context);
  if (!orgId || !orgLogin) return errorResponse("Missing org context", 400);

  const connectionsResponse = await getConnections(context);
  if (!connectionsResponse.ok) return connectionsResponse;
  const connections = await connectionsResponse.json() as ConnectionsResponse;
  const byId = Object.fromEntries(connections.connections.map((item) => [item.id, item]));
  const githubComplete = byId.github?.connected === true;
  const slackComplete = byId.slack?.connected === true;
  let slack: Record<string, unknown>;
  try { slack = (await readSlackSettings(context.env.DB, orgId, projectId)).slack; }
  catch (error) { return errorResponse(error instanceof Error ? error.message : String(error), 500); }
  const routeFields = ["fallbackChannelId", "noxCueChannelId", "noxTicketChannelId", "postsChannelId", "releaseNotesChannelId", "dailySummaryChannelId"];
  const configuredRouteCount = routeFields.filter((field) => {
    const value = slack[field];
    return typeof value === "string" && Boolean(value.trim());
  }).length;
  const hasRoute = (field: string) => Boolean(resolveSavedSlackChannel(slack, field));
  const [spotCount, cueCount, projectRouteCount] = await Promise.all([
    countRows(context.env.DB, `SELECT COUNT(*) AS count FROM spot_sites WHERE org_id = ?${projectId ? " AND project_id = ?" : ""}`, ...(projectId ? [orgId, projectId] : [orgId])),
    countRows(context.env.DB, `SELECT COUNT(*) AS count FROM cue_sources WHERE org_id = ?${projectId ? " AND project_id = ?" : ""} AND enabled = 1`, ...(projectId ? [orgId, projectId] : [orgId])),
    countRows(context.env.DB, `SELECT COUNT(*) AS count FROM project_routing_settings WHERE org_id = ?${projectId ? " AND project_id = ?" : ""} AND enabled = 1`, ...(projectId ? [orgId, projectId] : [orgId])),
  ]);

  const steps = {
    connect_github: {
      title: "Connect GitHub",
      required: true,
      state: githubComplete ? "complete" : (isAdmin ? "available" : "blocked"),
      automatable: false,
      reason: githubComplete ? null : "GitHub requires a human to approve the App installation.",
      action: githubComplete ? null : apiAction("POST", "/api/v1/integrations/connections/github/start"),
    },
    connect_slack: {
      title: "Connect Slack",
      required: false,
      state: slackComplete ? "complete" : (isAdmin ? "available" : "blocked"),
      automatable: false,
      reason: slackComplete ? null : "Slack requires a human workspace admin to approve OAuth.",
      action: slackComplete ? null : apiAction("POST", "/api/v1/integrations/connections/slack/start"),
    },
    configure_slack_routing: {
      title: "Configure Slack delivery routes",
      required: false,
      dependsOn: ["connect_slack"],
      state: !slackComplete || !isAdmin ? "blocked" : (configuredRouteCount > 0 ? "complete" : "available"),
      automatable: true,
      action: slackComplete && isAdmin
        ? apiAction("PATCH", "/api/v1/integrations/slack/routing", SLACK_ROUTING_BODY_SCHEMA)
        : null,
      discover: slackComplete && isAdmin ? apiAction("GET", "/api/v1/slack/channels") : null,
    },
    configure_project_routing: {
      title: "Group repositories and configure project routes",
      required: false,
      dependsOn: ["connect_github"],
      state: !githubComplete || !isAdmin ? "blocked" : (Number(projectRouteCount?.count || 0) > 0 ? "complete" : "available"),
      automatable: true,
      action: githubComplete && isAdmin ? apiAction("PUT", "/api/v1/projects/{projectId}/routing") : null,
      discover: githubComplete && isAdmin ? apiAction("GET", "/api/v1/projects/routing") : null,
      instructions: "Explicitly enable the NoxConnect projects you use, assign one or more repositories, and optionally set NoxFeed or NoxCue destinations.",
    },
    configure_noxfeed: {
      title: "Configure NoxFeed delivery",
      required: false,
      dependsOn: ["connect_slack"],
      state: !slackComplete || !isAdmin ? "blocked" : (hasRoute("postsChannelId") && hasRoute("releaseNotesChannelId") ? "complete" : "available"),
      automatable: true,
      action: slackComplete && isAdmin ? apiAction("PATCH", "/api/v1/integrations/slack/routing", {
        type: "object",
        properties: { routes: { type: "object", properties: { noxfeed_posts: { type: ["string", "null"] }, noxfeed_release_notes: { type: ["string", "null"] }, noxfeed_daily_summary: { type: ["string", "null"] } } } },
      }) : null,
    },
    configure_noxticket: {
      title: "Configure NoxTicket delivery",
      required: false,
      dependsOn: ["connect_slack"],
      state: !slackComplete || !isAdmin ? "blocked" : (hasRoute("noxTicketChannelId") ? "complete" : "available"),
      automatable: true,
      action: slackComplete && isAdmin ? apiAction("PATCH", "/api/v1/integrations/slack/routing") : null,
    },
    configure_noxcue: {
      title: "Configure NoxCue",
      required: false,
      dependsOn: ["connect_slack"],
      state: !slackComplete || !isAdmin ? "blocked" : (Number(cueCount?.count || 0) > 0 ? "complete" : "available"),
      automatable: true,
      action: slackComplete && isAdmin ? apiAction("POST", "/api/v1/cues/sources") : null,
      discover: isAdmin ? apiAction("GET", "/api/v1/cues/sources") : null,
      instructions: "Create a user-stat source, link it to a project, select report metrics and a Slack destination, then create a one-time server ingest key.",
    },
    configure_noxspot: {
      title: "Configure NoxSpot",
      required: false,
      dependsOn: ["connect_github"],
      state: !githubComplete || !isAdmin ? "blocked" : (Number(spotCount?.count || 0) > 0 ? "complete" : "available"),
      automatable: true,
      action: githubComplete && isAdmin ? apiAction("POST", "/api/v1/spots/sites") : null,
      discover: githubComplete ? apiAction("GET", "/api/v1/spots/sites") : null,
    },
  };

  const response = jsonResponse({
    apiVersion: 1,
    organization: { login: orgLogin },
    complete: githubComplete,
    documentation: { openapi: "/openapi.json", aiGuide: "/docs/ai-setup.md", discovery: "/llms.txt" },
    authentication: { type: "bearer", organizationHeader: "X-Org", projectHeader: "X-Project-ID", projectHeaderOptional: true },
    steps,
  });
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Link", INTEGRATION_DISCOVERY_LINK);
  return response;
}

async function countRows(db: D1Database, sql: string, ...binds: unknown[]): Promise<{ count: number }> {
  try {
    const row = await db.prepare(sql).bind(...binds).first<{ count: number }>();
    return { count: Number(row?.count || 0) };
  } catch (error) {
    console.error("[nox setup] optional readiness count failed", error);
    return { count: 0 };
  }
}
