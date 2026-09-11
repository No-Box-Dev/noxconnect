import { z } from "zod";
import { getCtx, jsonResponse, errorResponse } from "../lib/db";
import { AI_MODE_DISABLED, AI_MODE_MANAGED, MANAGED_LLM } from "../lib/llm-config";
import { getNoxFeedGenerationInfo } from "../lib/noxfeed-response.js";
import { validate } from "../lib/validate";

interface Ctx {
  env: { DB: D1Database; ANTHROPIC_API_KEY?: string; NOXFEED_RESPONSE?: unknown };
  data: { orgId: number; orgLogin: string; userLogin?: string; isAdmin: boolean };
  request: Request;
}

const Body = z.object({ mode: z.enum([AI_MODE_MANAGED, AI_MODE_DISABLED]) }).strict();

function access(context: Ctx) {
  const { orgId, isAdmin } = getCtx(context) as { orgId: number; isAdmin: boolean };
  if (!orgId) return { response: errorResponse("Missing org context", 400) };
  if (!isAdmin) return { response: errorResponse("Admin required", 403) };
  return { orgId };
}

type ManagedServiceStatus = {
  provider: string;
  model: string;
  available: boolean;
};

async function managedStatus(context: Ctx) {
  let noxfeed: ManagedServiceStatus = {
    provider: MANAGED_LLM.provider,
    model: MANAGED_LLM.model,
    available: false,
  };
  try {
    noxfeed = await getNoxFeedGenerationInfo(context.env);
  } catch (error) {
    console.error("[noxconnect llm-settings] NoxFeed generation info unavailable:", error);
  }

  const noxconnect: ManagedServiceStatus = {
    provider: MANAGED_LLM.provider,
    model: MANAGED_LLM.model,
    available: Boolean(context.env.ANTHROPIC_API_KEY),
  };

  return {
    provider: noxfeed.provider,
    model: noxfeed.model,
    available: noxfeed.available && noxconnect.available,
    services: { noxfeed, noxconnect },
  };
}

function payload(mode: string | null | undefined, managed: Awaited<ReturnType<typeof managedStatus>>) {
  return {
    mode: mode ?? AI_MODE_MANAGED,
    managed,
  };
}

export async function onRequestGet(context: Ctx): Promise<Response> {
  const auth = access(context);
  if (auth.response) return auth.response;

  const row = await context.env.DB.prepare("SELECT mode FROM ai_settings WHERE org_id = ?")
    .bind(auth.orgId)
    .first<{ mode: string }>();
  return jsonResponse(payload(row?.mode, await managedStatus(context)));
}

export async function onRequestPut(context: Ctx): Promise<Response> {
  const auth = access(context);
  if (auth.response) return auth.response;

  let body: unknown;
  try {
    body = await context.request.json();
  } catch {
    return errorResponse("Body must be JSON", 400);
  }

  const parsed = validate(Body, body);
  if (!parsed.ok) return parsed.response;
  const { mode } = parsed.data;
  const managed = await managedStatus(context);

  if (mode === AI_MODE_MANAGED && !managed.available) {
    return errorResponse("Managed AI is unavailable", 503, "dependency_unavailable");
  }

  await context.env.DB.batch([
    context.env.DB.prepare(
      `INSERT INTO ai_settings (org_id, mode, updated_at)
       VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
       ON CONFLICT(org_id) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at`,
    ).bind(auth.orgId, mode),
    context.env.DB.prepare(
      `INSERT INTO ai_settings_audit (org_id, actor_login, action, mode)
       VALUES (?, ?, 'mode_changed', ?)`,
    ).bind(auth.orgId, context.data.userLogin || context.data.orgLogin || "unknown", mode),
  ]);

  return jsonResponse(payload(mode, managed));
}
