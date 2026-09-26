import { getCtx, jsonResponse, errorResponse } from "../../../../../lib/db";

const DAYS: Record<string, number> = { "7d": 7, "30d": 30, "90d": 90, "1y": 365 };
interface Ctx { env: { DB: D1Database }; request: Request; params: { id: string }; data: { orgId: number; projectId?: string | null } }
interface MetricRow { metric_key: string; label: string; unit: string; period: string; value: number }

export async function onRequestGet(context: Ctx): Promise<Response> {
  const { orgId, projectId } = getCtx(context);
  const requestedProject = String(context.params.id || "");
  if (!projectId || projectId !== requestedProject) return errorResponse("Project scope mismatch", 403);
  const range = new URL(context.request.url).searchParams.get("range") || "30d";
  const days = DAYS[range] ?? 30;
  const rows = await context.env.DB.prepare(
    `SELECT metric.metric_key, definition.label, definition.unit, metric.period, metric.value
       FROM cue_daily_metrics metric
       JOIN cue_sources source ON source.id = metric.source_id
       JOIN cue_metric_definitions definition ON definition.key = metric.metric_key
       JOIN cue_project_metric_settings setting
         ON setting.project_id = source.project_id AND setting.metric_key = metric.metric_key
      WHERE source.org_id = ? AND source.project_id = ? AND source.environment = 'production'
        AND source.enabled = 1 AND setting.enabled = 1
        AND metric.period >= date('now', ?)
      ORDER BY metric.metric_key, metric.period ASC`,
  ).bind(orgId, projectId, `-${days - 1} days`).all();

  const grouped = new Map<string, MetricRow[]>();
  for (const row of (rows.results ?? []) as unknown as MetricRow[]) {
    const records = grouped.get(String(row.metric_key)) ?? [];
    records.push(row);
    grouped.set(String(row.metric_key), records);
  }
  const stats = [...grouped.entries()].map(([id, records]) => {
    const latest = records.at(-1)!;
    const previous = records.at(-2) ?? latest;
    const value = Number(latest.value);
    const prior = Number(previous.value);
    const delta = value - prior;
    const ratio = latest.unit === "ratio";
    const percent = prior === 0 ? 0 : Math.abs((delta / prior) * 100);
    const direction = delta > 0 ? "up" : delta < 0 ? "down" : "same";
    const arrow = delta > 0 ? "↑" : "↓";
    const change = delta === 0
      ? "Same as yesterday"
      : ratio
        ? `${arrow} ${Math.abs(delta * 100).toFixed(1)}pp vs yesterday`
        : `${arrow} ${Math.abs(delta).toLocaleString()} · ${percent.toFixed(1)}% vs yesterday`;
    const average = records.reduce((sum, row) => sum + Number(row.value), 0) / records.length;
    return {
      id,
      name: String(latest.label),
      value: ratio ? `${(value * 100).toFixed(1)}%` : value.toLocaleString(),
      context: `${days}d avg ${ratio ? `${(average * 100).toFixed(1)}%` : average.toFixed(1)}`,
      change,
      direction,
      points: records.map((row) => Number(row.value)),
    };
  });
  const latestPeriod = ((rows.results ?? []) as unknown as MetricRow[]).reduce((latest, row) => row.period > latest ? row.period : latest, "");
  return jsonResponse({ range, dateLabel: latestPeriod || "No reports", reportStatus: stats.length ? "Reported" : "Waiting", stats });
}
