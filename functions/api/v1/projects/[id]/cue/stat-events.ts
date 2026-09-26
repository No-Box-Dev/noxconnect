import { getCtx, jsonResponse, errorResponse } from "../../../../../lib/db";

const LABELS: Record<string, string> = {
  "users.new": "New user",
  "users.active": "User active",
};

interface Ctx {
  env: { DB: D1Database };
  params: { id: string };
  data: { orgId: number; projectId?: string | null };
}

interface EventRow {
  id: string;
  type: string;
  subject: string;
  environment: string;
  occurred_at: string;
}

export async function onRequestGet(context: Ctx): Promise<Response> {
  const { orgId, projectId } = getCtx(context);
  if (!projectId || projectId !== String(context.params.id || "")) return errorResponse("Project scope mismatch", 403);
  const rows = await context.env.DB.prepare(
    `SELECT source_id || ':registered:' || subject_hash AS id, 'users.new' AS type,
            subject_hash AS subject, occurred_at, source.environment
       FROM cue_user_registrations event JOIN cue_sources source ON source.id = event.source_id
      WHERE source.org_id = ? AND source.project_id = ?
     UNION ALL
     SELECT source_id || ':active:' || period || ':' || subject_hash, 'users.active',
            subject_hash, occurred_at, source.environment
       FROM cue_user_active_days event JOIN cue_sources source ON source.id = event.source_id
      WHERE source.org_id = ? AND source.project_id = ?
     UNION ALL
     SELECT source_id || ':custom:' || event_id, metric_key,
            subject_hash, occurred_at, source.environment
       FROM cue_activity_events event JOIN cue_sources source ON source.id = event.source_id
      WHERE source.org_id = ? AND source.project_id = ?
      ORDER BY occurred_at DESC LIMIT 100`,
  ).bind(orgId, projectId, orgId, projectId, orgId, projectId).all();
  return jsonResponse(((rows.results ?? []) as unknown as EventRow[]).map((row) => ({
    id: String(row.id),
    name: LABELS[String(row.type)] ?? String(row.type).replace(/^custom\./, "").replaceAll("_", " "),
    type: String(row.type),
    subject: `${String(row.subject).slice(0, 10)}…`,
    environment: String(row.environment),
    receivedAt: String(row.occurred_at),
    status: "accepted",
  })));
}
