import { getCtx, errorResponse, jsonResponse } from "../../../../../lib/db";
import { getNoxDb, type NoxDatabaseEnv } from "../../../../../lib/nox-db";
import { syncAppleAnalyticsSource } from "../../../../../lib/apple-analytics.js";

interface AppleAnalyticsService {
  ingestAppleAnalyticsBatch(input: unknown): Promise<{ ok: boolean; affectedMetrics: number }>;
}

interface Ctx {
  env: NoxDatabaseEnv & { ENCRYPTION_KEY?: string; NOXCUE_RESPONSE?: AppleAnalyticsService };
  data: { orgId: number; orgLogin: string; isAdmin: boolean };
  params: { id: string };
}

export async function onRequestPost(context: Ctx): Promise<Response> {
  const { orgId, orgLogin, isAdmin } = getCtx(context) as Ctx["data"];
  if (!orgId) return errorResponse("Missing org context", 400);
  if (!isAdmin) return errorResponse("Admin required", 403);
  const source = await getNoxDb(context.env).prepare(
    `SELECT id FROM cue_sources WHERE id = ? AND org_id = ? AND owner_id = ?`,
  ).bind(context.params.id, orgId, orgLogin).first();
  if (!source) return errorResponse("Cue source not found", 404);
  if (!context.env.NOXCUE_RESPONSE?.ingestAppleAnalyticsBatch) {
    return errorResponse("NoxCue analytics ingestion is temporarily unavailable", 503);
  }
  try {
    return jsonResponse(await syncAppleAnalyticsSource(context.env, context.params.id));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Apple analytics sync failed";
    return errorResponse(message.slice(0, 300), 502);
  }
}
