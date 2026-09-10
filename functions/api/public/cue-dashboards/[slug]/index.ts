import { jsonResponse } from "../../../../lib/db";
import { completedPeriodAt, loadNoxCueDigestData } from "../../../../lib/noxcue-digest-data.js";
import { loadCueFeatureCatalog } from "../../../../lib/noxcue-feature-catalog";
import { loadEnabledNoxCueMetricKeys, selectNoxCueDigestMetrics } from "../../../../lib/noxcue-project-metrics.js";
import {
  cueDashboardCookieName,
  cueDashboardSessionCookie,
  hasValidCueDashboardSession,
  readCookie,
  sha256,
} from "../../../../lib/project-share";

interface Ctx { env: { DB: D1Database }; params: { slug: string }; request: Request }
interface ShareRow { id: string; org_id: number; project_id: string; project_name: string }
interface SourceRow {
  id: string; name: string; environment: string; enabled: number; alerts_enabled: number;
  digest_enabled: number; timezone: string; digest_time_local: string;
  health_enabled: number | null; health_url: string | null; health_status: string | null;
  health_last_checked_at: string | null; health_last_status_code: number | null;
  health_last_latency_ms: number | null; health_last_error: string | null;
}
interface ErrorOccurrenceRow {
  id: string; source_id: string | null; fingerprint: string | null; message: string | null;
  occurred_at: string | null; received_at: string; url: string | null; error_code: string | null;
  component: string | null; environment: string | null; fatal: number | null; unhandled: number | null;
  release: string | null; runtime: string | null; error_name: string | null; error_stack: string | null; error_status: number | null;
}
interface FeatureResultRow {
  event_id: string; source_id: string; feature_key: string;
  outcome: "success" | "rejected" | "failure"; reason: string | null;
  message: string | null; error_name: string | null; error_message: string | null;
  error_code: string | null; error_stack: string | null; error_status: number | null; duration_ms: number | null;
  context_environment: string | null; context_release: string | null;
  context_runtime: string | null; context_url: string | null;
  diagnosis_summary: string | null; diagnosis_causes: string | null; diagnosis_fixes: string | null;
  occurred_at: string; received_at: string;
}

function response(data: unknown, status = 200) {
  const result = jsonResponse(data, status);
  result.headers.set("Cache-Control", "private, no-store");
  result.headers.set("X-Robots-Tag", "noindex, nofollow");
  return result;
}

async function resolveShare(context: Ctx): Promise<ShareRow | null> {
  return context.env.DB.prepare(
    `SELECT share.id, share.org_id, share.project_id, project.name AS project_name
       FROM cue_dashboard_shares share
       JOIN projects project ON project.id = share.project_id
      WHERE share.slug = ? AND share.enabled = 1 AND COALESCE(project.archived, 0) = 0`,
  ).bind(context.params.slug).first<ShareRow>();
}

function safeErrorUrl(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return `${url.origin}${url.pathname}`;
  } catch { return null; }
}

function safeStringArray(raw: string | null, limit = 5): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string" && value.length > 0)
        .slice(0, limit).map((value) => value.slice(0, 500))
      : [];
  } catch { return []; }
}

export async function onRequestGet(context: Ctx): Promise<Response> {
  const share = await resolveShare(context);
  if (!share) return response({ error: "Dashboard not found" }, 404);
  if (!(await hasValidCueDashboardSession(context.env.DB, context.request, context.params.slug, share.id))) {
    return response({ error: "Password required", projectName: share.project_name }, 401);
  }

  const [sourceResult, occurrenceResult, featureResult] = await Promise.all([
    context.env.DB.prepare(
      `SELECT source.id, source.name, source.environment, source.enabled, source.alerts_enabled,
            source.digest_enabled, source.timezone, source.digest_time_local,
            monitor.enabled AS health_enabled, monitor.url AS health_url,
            monitor.status AS health_status, monitor.last_checked_at AS health_last_checked_at,
            monitor.last_status_code AS health_last_status_code,
            monitor.last_latency_ms AS health_last_latency_ms, monitor.last_error AS health_last_error
       FROM cue_sources source
       LEFT JOIN cue_endpoint_monitors monitor ON monitor.source_id = source.id
      WHERE source.org_id = ? AND source.project_id = ?
      ORDER BY CASE source.environment WHEN 'production' THEN 0 WHEN 'staging' THEN 1 ELSE 2 END,
               source.created_at LIMIT 20`,
    ).bind(share.org_id, share.project_id).all<SourceRow>(),
    context.env.DB.prepare(
      `SELECT event.delivery_id AS id,
              json_extract(event.payload_json, '$.sourceId') AS source_id,
              json_extract(event.payload_json, '$.data.fingerprint') AS fingerprint,
              json_extract(event.payload_json, '$.message') AS message,
              json_extract(event.payload_json, '$.occurredAt') AS occurred_at,
              event.created_at AS received_at,
              json_extract(event.payload_json, '$.url') AS url,
              json_extract(event.payload_json, '$.data.errorCode') AS error_code,
              json_extract(event.payload_json, '$.data.component') AS component,
              json_extract(event.payload_json, '$.data.environment') AS environment,
              json_extract(event.payload_json, '$.data.fatal') AS fatal,
              json_extract(event.payload_json, '$.data.unhandled') AS unhandled,
              json_extract(event.payload_json, '$.context.release') AS release,
              json_extract(event.payload_json, '$.context.runtime') AS runtime,
              json_extract(event.payload_json, '$.error.name') AS error_name,
              json_extract(event.payload_json, '$.error.stack') AS error_stack,
              json_extract(event.payload_json, '$.error.status') AS error_status
         FROM events event
        WHERE event.org_id = ? AND event.project_id = ?
          AND event.source = 'noxcue' AND event.type = 'error.occurred'
        ORDER BY event.created_at DESC, event.id DESC LIMIT 250`,
    ).bind(share.org_id, share.project_id).all<ErrorOccurrenceRow>(),
    context.env.DB.prepare(
      `SELECT result.event_id, result.source_id, result.feature_key, result.outcome, result.reason,
              result.message,
              json_extract(result.error_json, '$.name') AS error_name,
              json_extract(result.error_json, '$.message') AS error_message,
              json_extract(result.error_json, '$.code') AS error_code,
              json_extract(result.error_json, '$.stack') AS error_stack,
              json_extract(result.error_json, '$.status') AS error_status,
              json_extract(result.error_json, '$.context.environment') AS context_environment,
              json_extract(result.error_json, '$.context.release') AS context_release,
              json_extract(result.error_json, '$.context.runtime') AS context_runtime,
              json_extract(result.error_json, '$.context.url') AS context_url,
              json_extract(result.error_json, '$.diagnosis.summary') AS diagnosis_summary,
              json_extract(result.error_json, '$.diagnosis.possibleCauses') AS diagnosis_causes,
              json_extract(result.error_json, '$.diagnosis.possibleFixes') AS diagnosis_fixes,
              result.duration_ms, result.occurred_at, result.received_at
         FROM cue_feature_results result
         JOIN cue_sources source ON source.id = result.source_id
        WHERE source.org_id = ? AND source.project_id = ? AND result.is_test = 0
        ORDER BY result.received_at DESC LIMIT 250`,
    ).bind(share.org_id, share.project_id).all<FeatureResultRow>(),
  ]);

  const occurrences = new Map<string, ErrorOccurrenceRow[]>();
  for (const row of occurrenceResult.results ?? []) {
    if (!row.source_id || !row.fingerprint) continue;
    const key = `${row.source_id}\u0000${row.fingerprint}`;
    const rows = occurrences.get(key) ?? [];
    if (rows.length < 20) rows.push(row);
    occurrences.set(key, rows);
  }

  const featureResults = new Map<string, FeatureResultRow[]>();
  for (const row of featureResult.results ?? []) {
    const key = `${row.source_id}\u0000${row.feature_key}`;
    const rows = featureResults.get(key) ?? [];
    if (rows.length < 20) rows.push(row);
    featureResults.set(key, rows);
  }

  const sources = await Promise.all((sourceResult.results ?? []).map(async (source) => {
    const period = completedPeriodAt(source.timezone);
    const [digest, enabledKeys, featureCatalog, errorResult] = await Promise.all([
      loadNoxCueDigestData(context.env.DB, source.id, period),
      loadEnabledNoxCueMetricKeys(context.env.DB, share.org_id, share.project_id, source.id),
      loadCueFeatureCatalog(context.env.DB, share.org_id, {
        sourceId: source.id, sourceName: source.name,
        projectId: share.project_id, projectName: share.project_name,
      }),
      context.env.DB.prepare(
        `SELECT fingerprint, title, error_code, component, first_seen_at, last_seen_at, occurrence_count,
                status, acknowledged_at, acknowledged_by, resolved_at, resolved_by
           FROM cue_error_groups WHERE source_id = ?
          ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'acknowledged' THEN 1 ELSE 2 END,
                   last_seen_at DESC LIMIT 20`,
      ).bind(source.id).all<Record<string, unknown>>(),
    ]);
    const selected = selectNoxCueDigestMetrics(digest, enabledKeys);
    return {
      id: source.id, name: source.name, environment: source.environment, period,
      settings: {
        collecting: source.enabled === 1, digestEnabled: source.digest_enabled === 1,
        alertsEnabled: source.alerts_enabled === 1, timezone: source.timezone,
        digestTimeLocal: source.digest_time_local,
      },
      endpoint: {
        enabled: source.health_enabled === 1, url: source.health_url,
        status: source.health_status ?? "waiting", lastCheckedAt: source.health_last_checked_at,
        statusCode: source.health_last_status_code, latencyMs: source.health_last_latency_ms,
        error: source.health_last_error,
      },
      metrics: selected.metrics,
      comparisons: selected.comparisons,
      metricLabels: selected.metricLabels,
      features: featureCatalog.features.filter((feature) => feature.enabled).map((feature) => {
        const results = featureResults.get(`${source.id}\u0000${feature.key}`) ?? [];
        const incidentStartedAt = feature.incidentStartedAt;
        return {
          key: feature.key, label: feature.label, description: feature.description,
          failureMessage: feature.failureMessage, status: feature.status,
          lastResultAt: feature.lastResultAt, lastFailureAt: feature.lastFailureAt,
          lastSuccessAt: feature.lastSuccessAt, incidentStartedAt,
          consecutiveFailures: feature.consecutiveFailures,
          successfulAttemptsSinceLastFailure: feature.consecutiveSuccesses,
          lastReason: feature.lastReason, successes24h: feature.successes24h,
          rejections24h: feature.rejections24h, failures24h: feature.failures24h,
          results: results.map((result) => ({
            id: result.event_id, outcome: result.outcome, reason: result.reason,
            message: result.message, error: result.error_message ? {
              name: result.error_name, message: result.error_message,
              code: result.error_code, status: result.error_status, stack: result.error_stack,
            } : null,
            context: {
              environment: result.context_environment,
              release: result.context_release,
              runtime: result.context_runtime,
              url: safeErrorUrl(result.context_url),
            },
            diagnosis: {
              summary: result.diagnosis_summary,
              possibleCauses: safeStringArray(result.diagnosis_causes),
              possibleFixes: safeStringArray(result.diagnosis_fixes),
            },
            durationMs: result.duration_ms, occurredAt: result.occurred_at, receivedAt: result.received_at,
          })),
        };
      }),
      errors: (errorResult.results ?? []).map((row) => ({
        fingerprint: row.fingerprint, title: row.title, errorCode: row.error_code, component: row.component,
        firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at,
        occurrenceCount: Number(row.occurrence_count ?? 0),
        status: row.status ?? "open", acknowledgedAt: row.acknowledged_at ?? null,
        acknowledgedBy: row.acknowledged_by ?? null, resolvedAt: row.resolved_at ?? null,
        resolvedBy: row.resolved_by ?? null,
        occurrences: (occurrences.get(`${source.id}\u0000${String(row.fingerprint ?? "")}`) ?? []).map((item) => ({
          id: item.id,
          message: item.message,
          occurredAt: item.occurred_at ?? item.received_at,
          receivedAt: item.received_at,
          url: safeErrorUrl(item.url),
          errorCode: item.error_code,
          component: item.component,
          environment: item.environment,
          release: item.release,
          runtime: item.runtime,
          errorName: item.error_name,
          errorStack: item.error_stack,
          errorStatus: item.error_status,
          fatal: item.fatal === 1,
          unhandled: item.unhandled === 1,
        })),
      })),
    };
  }));
  return response({ project: { name: share.project_name }, generatedAt: new Date().toISOString(), sources });
}

export async function onRequestDelete(context: Ctx): Promise<Response> {
  const share = await resolveShare(context);
  if (!share) return response({ ok: true });
  const token = readCookie(context.request, cueDashboardCookieName(context.params.slug));
  if (token) {
    await context.env.DB.prepare("DELETE FROM cue_dashboard_share_sessions WHERE token_hash = ? AND share_id = ?")
      .bind(await sha256(token), share.id).run();
  }
  const result = response({ ok: true });
  result.headers.set("Set-Cookie", cueDashboardSessionCookie(context.params.slug, "", 0));
  return result;
}
