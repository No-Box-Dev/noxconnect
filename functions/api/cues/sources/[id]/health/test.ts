import { getCtx, errorResponse, jsonResponse } from "../../../../../lib/db";
import { getNoxDb, type NoxDatabaseEnv } from "../../../../../lib/nox-db";

interface EndpointTestResult {
  healthy: boolean;
  statusCode: number | null;
  latencyMs: number;
  error: string | null;
  queued: boolean;
  channelConfigured: boolean;
  deliveryId: string | null;
  checkedAt: string;
}

interface NoxCueEndpointService {
  testEndpointMonitor(orgId: number, sourceId: string): Promise<EndpointTestResult>;
}

interface Ctx {
  env: NoxDatabaseEnv & { NOXCUE_RESPONSE?: NoxCueEndpointService };
  data: { orgId: number; orgLogin: string; projectId?: string | null; isAdmin: boolean };
  params: { id: string };
}

export async function onRequestPost(context: Ctx): Promise<Response> {
  const { orgId, orgLogin, projectId, isAdmin } = getCtx(context) as Ctx["data"];
  if (!orgId) return errorResponse("Missing org context", 400);
  if (!isAdmin) return errorResponse("Admin required", 403);

  const source = await getNoxDb(context.env).prepare(
    `SELECT id FROM cue_sources
      WHERE id = ? AND org_id = ? AND owner_id = ?${projectId ? " AND project_id = ?" : ""}`,
  ).bind(...(projectId
    ? [context.params.id, orgId, orgLogin, projectId]
    : [context.params.id, orgId, orgLogin])).first<{ id: string }>();
  if (!source) return errorResponse("Cue source not found", 404);

  const service = context.env.NOXCUE_RESPONSE;
  if (!service || typeof service.testEndpointMonitor !== "function") {
    return errorResponse("NoxCue endpoint checks are temporarily unavailable", 503);
  }

  try {
    const result = await service.testEndpointMonitor(orgId, context.params.id);
    if (!result.channelConfigured) {
      return errorResponse("Endpoint checked, but no NoxCue alert channel is configured for this project", 409);
    }
    if (!result.queued || !result.deliveryId) return errorResponse("Endpoint checked, but the Slack test could not be queued", 502);

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const delivery = await getNoxDb(context.env).prepare(
        "SELECT status, last_error FROM delivery_outbox WHERE id = ? AND org_id = ?",
      ).bind(result.deliveryId, orgId).first<{ status: string; last_error: string | null }>();
      if (delivery?.status === "delivered") return jsonResponse({ ...result, delivered: true });
      if (delivery?.status === "failed" || delivery?.status?.startsWith("blocked_")) {
        return errorResponse(delivery.last_error || "Slack rejected the endpoint test", 502);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return jsonResponse({ ...result, delivered: false }, 202);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Endpoint test failed";
    if (message.includes("monitor not found")) return errorResponse("Save and enable the endpoint monitor before testing it", 409);
    if (message.includes("recent scheduled endpoint check")) return errorResponse("Wait for the first scheduled endpoint check, then try again", 409);
    console.error("[noxcue-endpoint-test] service failed", { sourceId: context.params.id, error: message });
    return errorResponse("NoxCue could not run the endpoint test", 502);
  }
}
