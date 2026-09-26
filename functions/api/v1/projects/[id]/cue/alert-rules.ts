import { getCtx, jsonResponse, errorResponse } from "../../../../../lib/db";

const featureLabel = (key: string) => key.replace(/^auth\./, "").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
interface Ctx { env: { DB: D1Database }; params: { id: string }; data: { orgId: number; projectId?: string | null } }
interface SourceRow { id: string; name: string; environment: string; enabled: number; alerts_enabled: number }
interface FeatureRow { source_id: string; feature_key: string; name: string; environment: string; enabled: number; alerts_enabled: number }
interface MonitorRow { source_id: string; name: string; environment: string; enabled: number; alerts_enabled: number }

export async function onRequestGet(context: Ctx): Promise<Response> {
  const { orgId, projectId } = getCtx(context);
  if (!projectId || projectId !== String(context.params.id || "")) return errorResponse("Project scope mismatch", 403);
  const [sources, features, monitors] = await context.env.DB.batch([
    context.env.DB.prepare("SELECT id, name, environment, enabled, alerts_enabled FROM cue_sources WHERE org_id = ? AND project_id = ? ORDER BY environment").bind(orgId, projectId),
    context.env.DB.prepare("SELECT state.source_id, state.feature_key, source.name, source.environment, source.enabled, source.alerts_enabled FROM cue_feature_states state JOIN cue_sources source ON source.id = state.source_id WHERE source.org_id = ? AND source.project_id = ? ORDER BY source.environment, state.feature_key").bind(orgId, projectId),
    context.env.DB.prepare("SELECT monitor.source_id, monitor.enabled, source.name, source.environment, source.alerts_enabled FROM cue_endpoint_monitors monitor JOIN cue_sources source ON source.id = monitor.source_id WHERE source.org_id = ? AND source.project_id = ? ORDER BY source.environment").bind(orgId, projectId),
  ]);
  return jsonResponse([
    ...((sources.results ?? []) as unknown as SourceRow[]).map((row) => ({ id: `${row.id}:errors`, name: "Application errors", kind: "error", condition: "Alert when an error is received", environment: String(row.environment), source: String(row.name), enabled: row.enabled === 1 && row.alerts_enabled === 1 })),
    ...((features.results ?? []) as unknown as FeatureRow[]).map((row) => ({ id: `${row.source_id}:${row.feature_key}`, name: featureLabel(String(row.feature_key)), kind: "feature", condition: "Alert after repeated failures", environment: String(row.environment), source: String(row.name), enabled: row.enabled === 1 && row.alerts_enabled === 1 })),
    ...((monitors.results ?? []) as unknown as MonitorRow[]).map((row) => ({ id: `${row.source_id}:endpoint`, name: "Endpoint health", kind: "health", condition: "Alert when the endpoint check fails", environment: String(row.environment), source: String(row.name), enabled: row.enabled === 1 && row.alerts_enabled === 1 })),
  ]);
}
