import { z } from "zod";
import { getCtx, errorResponse, jsonResponse } from "../../lib/db";
import { validate } from "../../lib/validate";
import { canReadProjectResource } from "../../lib/api-auth.js";

const QuerySchema = z.object({
  sourceId: z.string().uuid(),
  days: z.coerce.number().int().min(1).max(31).default(14),
});

interface Ctx {
  env: { DB: D1Database };
  data: { orgId: number; isAdmin: boolean; auth?: { type?: string } };
  request: Request;
}

interface MetricRow {
  period: string;
  metric_key: string;
  value: number;
  origin: "reported" | "calculated";
  updated_at: string;
}

interface ActivityMetricRow {
  period: string;
  metric_key: string;
  label: string;
  total_events: number;
  total_users: number;
  updated_at: string;
}

export async function onRequestGet(context: Ctx): Promise<Response> {
  const { orgId } = getCtx(context) as Ctx["data"];
  if (!orgId) return errorResponse("Missing org context", 400);
  if (!canReadProjectResource(context.data)) return errorResponse("Admin required", 403);
  const parsed = validate(QuerySchema, Object.fromEntries(new URL(context.request.url).searchParams.entries()));
  if (!parsed.ok) return parsed.response;
  const source = await context.env.DB.prepare(
    "SELECT id FROM cue_sources WHERE id = ? AND org_id = ?",
  ).bind(parsed.data.sourceId, orgId).first();
  if (!source) return errorResponse("Cue source not found", 404);

  const [catalog, metricRows, activityRows, digests, errorGroups] = await Promise.all([
    context.env.DB.prepare(
      `SELECT key, label, domain, unit, origin, description, formula_key, version
         FROM cue_metric_definitions ORDER BY rowid`,
    ).all<Record<string, unknown>>(),
    context.env.DB.prepare(
      `SELECT period, metric_key, value, origin, updated_at
         FROM cue_daily_metrics
        WHERE source_id = ?
          AND period >= date('now', ?)
        ORDER BY period DESC, metric_key`,
    ).bind(parsed.data.sourceId, `-${parsed.data.days - 1} days`).all<MetricRow>(),
    context.env.DB.prepare(
      `WITH RECURSIVE periods(period) AS (
         SELECT date('now', ?)
         UNION ALL SELECT date(period, '+1 day') FROM periods WHERE period < date('now')
       ), definitions(metric_key, label) AS (
         SELECT metric.metric_key, metric.label
           FROM cue_custom_metrics metric
           JOIN cue_sources source ON source.id = ?
          WHERE metric.org_id = source.org_id AND metric.enabled = 1
            AND ((source.project_id IS NOT NULL AND metric.project_id = source.project_id)
              OR (source.project_id IS NULL AND metric.source_id = source.id))
       )
       SELECT periods.period, definitions.metric_key, definitions.label,
         (SELECT COUNT(*) FROM cue_activity_events activity
           WHERE activity.source_id = ? AND activity.metric_key = definitions.metric_key
             AND activity.period <= periods.period) AS total_events,
         (SELECT COUNT(*) FROM cue_user_registrations registration
           WHERE registration.source_id = ? AND registration.period <= periods.period) AS total_users,
         COALESCE((SELECT MAX(activity.received_at) FROM cue_activity_events activity
           WHERE activity.source_id = ? AND activity.metric_key = definitions.metric_key), '') AS updated_at
       FROM periods CROSS JOIN definitions ORDER BY periods.period DESC, definitions.metric_key`,
    ).bind(`-${parsed.data.days - 1} days`, parsed.data.sourceId, parsed.data.sourceId,
      parsed.data.sourceId, parsed.data.sourceId).all<ActivityMetricRow>(),
    context.env.DB.prepare(
      `SELECT run.period, run.created_at, delivery.status, delivery.delivered_at
         FROM cue_digest_runs run
         LEFT JOIN delivery_outbox delivery ON delivery.id = run.outbox_id
        WHERE run.source_id = ?
        ORDER BY run.period DESC LIMIT ?`,
    ).bind(parsed.data.sourceId, parsed.data.days).all<Record<string, unknown>>(),
    context.env.DB.prepare(
      `SELECT fingerprint, title, error_code, component, environment,
              first_seen_at, last_seen_at, occurrence_count, last_notified_at
         FROM cue_error_groups
        WHERE source_id = ?
        ORDER BY last_seen_at DESC LIMIT 20`,
    ).bind(parsed.data.sourceId).all<Record<string, unknown>>(),
  ]);

  const days = new Map<string, Record<string, { value: number; origin: string; updatedAt: string }>>();
  for (const row of metricRows.results ?? []) {
    const values = days.get(row.period) ?? {};
    values[row.metric_key] = { value: row.value, origin: row.origin, updatedAt: row.updated_at };
    days.set(row.period, values);
  }
  const customCatalog = new Map<string, { key: string; label: string; unit: "count" | "decimal" }>();
  for (const row of activityRows.results ?? []) {
    const values = days.get(row.period) ?? {};
    const total = Number(row.total_events ?? 0);
    const users = Number(row.total_users ?? 0);
    values[row.metric_key] = { value: total, origin: "calculated", updatedAt: row.updated_at };
    if (users > 0) values[`${row.metric_key}.per_user`] = { value: total / users, origin: "calculated", updatedAt: row.updated_at };
    days.set(row.period, values);
    customCatalog.set(row.metric_key, { key: row.metric_key, label: `${row.label} total`, unit: "count" });
    customCatalog.set(`${row.metric_key}.per_user`, { key: `${row.metric_key}.per_user`, label: `${row.label} per user`, unit: "decimal" });
  }
  return jsonResponse({
    catalog: [...(catalog.results ?? []).map((row) => ({
      key: row.key,
      label: row.label,
      domain: row.domain,
      unit: row.unit,
      origin: row.origin,
      description: row.description,
      formulaKey: row.formula_key,
      version: row.version,
    })), ...[...customCatalog.values()].map((metric) => ({
      ...metric, domain: "activity", origin: "calculated", description: metric.label,
      formulaKey: metric.key, version: 1,
    }))],
    days: [...days].map(([period, metrics]) => ({ period, metrics })),
    digests: (digests.results ?? []).map((row) => ({
      period: row.period,
      createdAt: row.created_at,
      status: row.status ?? "stored",
      deliveredAt: row.delivered_at ?? null,
    })),
    errorGroups: (errorGroups.results ?? []).map((row) => ({
      fingerprint: row.fingerprint,
      title: row.title,
      errorCode: row.error_code,
      component: row.component,
      environment: row.environment,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      occurrenceCount: row.occurrence_count,
      lastNotifiedAt: row.last_notified_at,
    })),
  });
}
