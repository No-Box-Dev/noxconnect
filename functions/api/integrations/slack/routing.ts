import { getCtx, errorResponse, jsonResponse } from "../../../lib/db";
import { onRequestPut as putConfig } from "../../config/[key].js";
import { z } from "zod";
import { validate } from "../../../lib/validate";
import { readSlackSettings } from "../../../lib/slack-settings";

interface Ctx {
  env: { DB: D1Database };
  data: { orgId: number; projectId?: string | null; isAdmin: boolean };
  request: Request;
  params?: Record<string, string>;
}

const ROUTES: Record<string, string> = {
  fallback: "fallbackChannelId",
  noxcue: "noxCueChannelId",
  noxticket: "noxTicketChannelId",
  noxfeed_posts: "postsChannelId",
  noxfeed_release_notes: "releaseNotesChannelId",
  noxfeed_daily_summary: "dailySummaryChannelId",
};

const RoutingPatch = z.object({
  routes: z.record(z.string(), z.string().trim().max(80).nullable()),
});

function routingResponse(settings: Record<string, unknown>) {
  const slack: Record<string, unknown> = settings.slack && typeof settings.slack === "object" && !Array.isArray(settings.slack)
    ? settings.slack as Record<string, unknown>
    : {};
  const routes = Object.fromEntries(Object.entries(ROUTES).map(([name, field]) => [name, slack[field] || null]));
  return {
    routes,
    resolution: {
      noxcue: ["noxcue", "fallback"],
      noxticket: ["noxticket", "fallback"],
      noxfeed_posts: ["noxfeed_posts", "fallback"],
      noxfeed_release_notes: ["noxfeed_release_notes", "fallback"],
      noxfeed_daily_summary: ["noxfeed_daily_summary"],
      noxspot: ["site channel", "fallback"],
    },
  };
}

// GET /api/integrations/slack/routing
export async function onRequestGet(context: Ctx): Promise<Response> {
  const { orgId, projectId, isAdmin } = getCtx(context);
  if (!orgId) return errorResponse("Missing org context", 400);
  if (!isAdmin) return errorResponse("Admin required", 403);
  try { return jsonResponse(routingResponse((await readSlackSettings(context.env.DB, orgId, projectId)).settings)); }
  catch (error) { return errorResponse(error instanceof Error ? error.message : String(error), 500); }
}

// PATCH /api/integrations/slack/routing
// Body: { routes: { fallback?: string|null, noxcue?: string|null, ... } }
// Partial updates are merged so an agent cannot accidentally erase unrelated
// organization settings by writing the generic config document.
export async function onRequestPatch(context: Ctx): Promise<Response> {
  const { orgId, projectId, isAdmin } = getCtx(context);
  if (!orgId) return errorResponse("Missing org context", 400);
  if (!isAdmin) return errorResponse("Admin required", 403);

  let raw: unknown;
  try { raw = await context.request.json(); }
  catch { return errorResponse("Invalid JSON body", 400); }
  const parsed = validate(RoutingPatch, raw);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  const unknown = Object.keys(body.routes).filter((key) => !ROUTES[key]);
  if (unknown.length) return errorResponse(`Unknown Slack route: ${unknown.join(", ")}`, 400);

  let stored;
  try { stored = await readSlackSettings(context.env.DB, orgId, projectId); }
  catch (error) { return errorResponse(error instanceof Error ? error.message : String(error), 500); }
  const settings = stored.settings;
  const slack: Record<string, unknown> = { ...stored.slack };
  for (const [route, value] of Object.entries(body.routes)) {
    slack[ROUTES[route]] = typeof value === "string" ? value.trim() : "";
  }
  // Once either split NoxFeed route is managed through the canonical API,
  // retire the old combined value so it cannot silently override a cleared
  // posts or release-notes route during the compatibility window.
  if (Object.prototype.hasOwnProperty.call(body.routes, "noxfeed_posts")
    || Object.prototype.hasOwnProperty.call(body.routes, "noxfeed_release_notes")) {
    delete slack.noxFeedChannelId;
  }
  const nextSettings = { ...settings, slack };
  const request = new Request(context.request.url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(nextSettings),
  });
  const response = await putConfig({
    ...context,
    request,
    params: { ...context.params, key: "settings" },
    data: {
      ...context.data,
      configCompareAndSwap: { expectedRaw: stored.raw },
    },
  } as never);
  if (!response.ok) return response;
  return jsonResponse({ ok: true, ...routingResponse(nextSettings) });
}
