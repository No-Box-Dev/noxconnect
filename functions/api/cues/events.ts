import { z } from "zod";
import { getCtx, errorResponse, jsonResponse } from "../../lib/db";
import { validate } from "../../lib/validate";

const QuerySchema = z.object({
  sourceId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

interface Ctx {
  env: { DB: D1Database };
  data: { orgId: number; projectId?: string | null };
  request: Request;
}

export async function onRequestGet(context: Ctx): Promise<Response> {
  const { orgId, projectId } = getCtx(context) as Ctx["data"];
  if (!orgId) return errorResponse("Missing org context", 400);
  const url = new URL(context.request.url);
  const parsed = validate(QuerySchema, Object.fromEntries(url.searchParams.entries()));
  if (!parsed.ok) return parsed.response;

  let sql = `SELECT event.delivery_id, event.type, event.summary, event.payload_json, event.created_at,
                    delivery.status AS delivery_status, delivery.delivered_at
               FROM events event
               LEFT JOIN delivery_outbox delivery
                 ON delivery.source = 'noxcue' AND delivery.source_id = event.delivery_id
              WHERE event.org_id = ? AND event.source = 'noxcue'`;
  const binds: Array<string | number> = [orgId];
  if (projectId) {
    sql += ` AND EXISTS (
      SELECT 1 FROM cue_sources source
       WHERE source.id = json_extract(event.payload_json, '$.sourceId')
         AND source.org_id = ? AND source.project_id = ?
    )`;
    binds.push(orgId, projectId);
  }
  if (parsed.data.sourceId) {
    sql += " AND json_extract(event.payload_json, '$.sourceId') = ?";
    binds.push(parsed.data.sourceId);
  }
  sql += " ORDER BY event.created_at DESC, event.id DESC LIMIT ?";
  binds.push(parsed.data.limit);
  const result = await context.env.DB.prepare(sql).bind(...binds).all<Record<string, unknown>>();
  return jsonResponse({ events: (result.results ?? []).map((row) => ({
    id: row.delivery_id,
    type: row.type,
    title: row.summary,
    event: parsePayload(row.payload_json),
    receivedAt: row.created_at,
    deliveryStatus: row.delivery_status ?? null,
    deliveredAt: row.delivered_at ?? null,
  })) });
}

function parsePayload(raw: unknown): unknown {
  try { return JSON.parse(String(raw ?? "{}")); }
  catch { return {}; }
}
