import { z } from "zod";
import { getCtx, errorResponse, jsonResponse } from "../../../../lib/db";
import { getNoxDb, type NoxDatabaseEnv } from "../../../../lib/nox-db";
import { validate } from "../../../../lib/validate";
import { encryptToken } from "../../../../lib/crypto.js";
import { connectAppleAnalytics } from "../../../../lib/apple-analytics.js";

const inputSchema = z.object({
  appId: z.string().trim().regex(/^\d{6,20}$/, "Enter the numeric Apple app ID"),
  issuerId: z.string().trim().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "Enter a valid issuer ID"),
  keyId: z.string().trim().regex(/^[A-Z0-9]{8,20}$/i, "Enter a valid key ID"),
  privateKey: z.string().trim().min(100).max(10_000)
    .regex(/^-----BEGIN PRIVATE KEY-----[\s\S]+-----END PRIVATE KEY-----$/, "Upload the .p8 private key"),
}).strict();

interface AppleConnectionRow {
  app_id: string;
  key_id: string;
  status: "waiting_for_reports" | "active" | "error";
  last_synced_at: string | null;
  last_successful_period: string | null;
  last_error: string | null;
  created_at: string;
}

interface Ctx {
  env: NoxDatabaseEnv & { ENCRYPTION_KEY?: string };
  data: { orgId: number; orgLogin: string; isAdmin: boolean };
  params: { id: string };
  request: Request;
}

async function ownedProductionSource(context: Ctx) {
  const { orgId, orgLogin } = getCtx(context) as Ctx["data"];
  return getNoxDb(context.env).prepare(
    `SELECT id, environment FROM cue_sources
      WHERE id = ? AND org_id = ? AND owner_id = ?`,
  ).bind(context.params.id, orgId, orgLogin).first<{ id: string; environment: string }>();
}

function connectionJson(row: AppleConnectionRow | null) {
  if (!row) return { connected: false };
  return {
    connected: true,
    appId: row.app_id,
    keyId: row.key_id,
    status: row.status,
    lastSyncedAt: row.last_synced_at,
    lastSuccessfulPeriod: row.last_successful_period,
    lastError: row.last_error,
    createdAt: row.created_at,
  };
}

export async function onRequestGet(context: Ctx): Promise<Response> {
  const { orgId, isAdmin } = getCtx(context) as Ctx["data"];
  if (!orgId) return errorResponse("Missing org context", 400);
  if (!isAdmin) return errorResponse("Admin required", 403);
  const source = await ownedProductionSource(context);
  if (!source) return errorResponse("Cue source not found", 404);
  const row = await getNoxDb(context.env).prepare(
    `SELECT app_id, key_id, status, last_synced_at, last_successful_period, last_error, created_at
       FROM cue_apple_connections WHERE source_id = ? AND org_id = ?`,
  ).bind(context.params.id, orgId).first<AppleConnectionRow>();
  return jsonResponse(connectionJson(row));
}

export async function onRequestPut(context: Ctx): Promise<Response> {
  const { orgId, isAdmin } = getCtx(context) as Ctx["data"];
  if (!orgId) return errorResponse("Missing org context", 400);
  if (!isAdmin) return errorResponse("Admin required", 403);
  const source = await ownedProductionSource(context);
  if (!source) return errorResponse("Cue source not found", 404);
  if (source.environment !== "production") {
    return errorResponse("App Store Connect analytics can only be attached to a production source", 409);
  }
  let raw: unknown;
  try { raw = await context.request.json(); }
  catch { return errorResponse("Invalid JSON body", 400); }
  const parsed = validate(inputSchema, raw);
  if (!parsed.ok) return parsed.response;
  if (!context.env.ENCRYPTION_KEY) return errorResponse("Credential encryption is unavailable", 503);

  try {
    const credentials = {
      issuerId: parsed.data.issuerId,
      keyId: parsed.data.keyId,
      privateKey: parsed.data.privateKey,
    };
    const [{ reportRequestId }, encryptedPrivateKey] = await Promise.all([
      connectAppleAnalytics(credentials, parsed.data.appId),
      encryptToken(parsed.data.privateKey, context.env.ENCRYPTION_KEY),
    ]);
    const now = new Date().toISOString();
    const db = getNoxDb(context.env);
    const previous = await db.prepare(
      "SELECT app_id FROM cue_apple_connections WHERE source_id = ?",
    ).bind(context.params.id).first<{ app_id: string }>();
    const upsert = db.prepare(
      `INSERT INTO cue_apple_connections
         (source_id, org_id, app_id, issuer_id, key_id, encrypted_private_key,
          report_request_id, status, last_error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'waiting_for_reports', NULL, ?, ?)
       ON CONFLICT(source_id) DO UPDATE SET
         app_id = excluded.app_id,
         issuer_id = excluded.issuer_id,
         key_id = excluded.key_id,
         encrypted_private_key = excluded.encrypted_private_key,
         report_request_id = excluded.report_request_id,
         status = 'waiting_for_reports',
         last_error = NULL,
         updated_at = excluded.updated_at`,
    ).bind(
      context.params.id, orgId, parsed.data.appId, parsed.data.issuerId, parsed.data.keyId,
      encryptedPrivateKey, reportRequestId, now, now,
    );
    if (previous && previous.app_id !== parsed.data.appId) {
      await db.batch([
        db.prepare("DELETE FROM cue_apple_processed_instances WHERE source_id = ?").bind(context.params.id),
        db.prepare("DELETE FROM cue_external_metric_contributions WHERE source_id = ? AND provider = 'apple-app-store-connect'").bind(context.params.id),
        db.prepare("DELETE FROM cue_daily_metrics WHERE source_id = ? AND metric_key LIKE 'apple.%'").bind(context.params.id),
        upsert,
      ]);
    } else {
      await upsert.run();
    }
    const row = await db.prepare(
      `SELECT app_id, key_id, status, last_synced_at, last_successful_period, last_error, created_at
         FROM cue_apple_connections WHERE source_id = ?`,
    ).bind(context.params.id).first<AppleConnectionRow>();
    return jsonResponse(connectionJson(row));
  } catch (error) {
    const message = error instanceof Error ? error.message : "App Store Connect connection failed";
    if (message.includes("403") || message.toLowerCase().includes("forbidden")) {
      return errorResponse("The API key cannot create analytics reports. Connect once with an Admin key.", 409);
    }
    if (message.includes("401") || message.includes("private key")) {
      return errorResponse("App Store Connect rejected the issuer, key ID, or .p8 private key", 400);
    }
    if (message.includes("UNIQUE constraint failed") && message.includes("app_id")) {
      return errorResponse("This Apple app is already connected to another NoxCue source", 409);
    }
    return errorResponse(message.slice(0, 300), 502);
  }
}

export async function onRequestDelete(context: Ctx): Promise<Response> {
  const { orgId, isAdmin } = getCtx(context) as Ctx["data"];
  if (!orgId) return errorResponse("Missing org context", 400);
  if (!isAdmin) return errorResponse("Admin required", 403);
  const source = await ownedProductionSource(context);
  if (!source) return errorResponse("Cue source not found", 404);
  const result = await getNoxDb(context.env).prepare(
    "DELETE FROM cue_apple_connections WHERE source_id = ? AND org_id = ?",
  ).bind(context.params.id, orgId).run();
  if (!result.meta.changes) return errorResponse("Apple analytics connection not found", 404);
  return jsonResponse({ ok: true });
}
