import { getCtx, errorResponse } from "../../../lib/db";
import { onRequestPost as postSlackTest } from "../../slack/test.js";
import { z } from "zod";
import { validate } from "../../../lib/validate";
import { readSlackSettings, resolveSavedSlackChannel } from "../../../lib/slack-settings";

interface Ctx {
  env: { DB: D1Database };
  data: { orgId: number; projectId?: string | null; orgLogin?: string; isAdmin: boolean };
  request: Request;
}

const ROUTES = {
  fallback: { field: "fallbackChannelId", kind: "fallback" },
  noxcue: { field: "noxCueChannelId", kind: "noxcue" },
  noxticket: { field: "noxTicketChannelId", kind: "noxticket" },
  noxfeed_posts: { field: "postsChannelId", kind: "noxfeed_posts" },
  noxfeed_release_notes: { field: "releaseNotesChannelId", kind: "noxfeed_release_notes" },
  noxfeed_daily_summary: { field: "dailySummaryChannelId", kind: "noxfeed_daily_summary" },
} as const;

const ROUTE_NAMES = Object.keys(ROUTES) as [keyof typeof ROUTES, ...(keyof typeof ROUTES)[]];

const RouteTest = z.object({
  route: z.enum(ROUTE_NAMES),
  channelId: z.string().trim().max(80).optional(),
});

// POST /api/integrations/slack/test
// Body: { route, channelId? }. If channelId is omitted, test the saved route
// with the organization fallback applied exactly as production delivery does.
export async function onRequestPost(context: Ctx): Promise<Response> {
  const { orgId, projectId, isAdmin } = getCtx(context);
  if (!orgId) return errorResponse("Missing org context", 400);
  if (!isAdmin) return errorResponse("Admin required", 403);
  let raw: unknown;
  try { raw = await context.request.json(); }
  catch { return errorResponse("Invalid JSON body", 400); }
  const parsed = validate(RouteTest, raw);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  const route = ROUTES[body.route];

  let channelId = typeof body.channelId === "string" ? body.channelId.trim() : "";
  if (!channelId) {
    try {
      const slack = (await readSlackSettings(context.env.DB, orgId, projectId)).slack;
      channelId = body.route === "noxfeed_daily_summary"
        ? String(slack[route.field] || "").trim()
        : resolveSavedSlackChannel(slack, route.field);
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : String(error), 500);
    }
  }
  if (!channelId) return errorResponse("No channel is configured for this route", 409);

  const request = new Request(context.request.url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channelId, kind: route.kind }),
  });
  return postSlackTest({ ...context, request } as never);
}
