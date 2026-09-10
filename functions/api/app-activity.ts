import { getCtx, errorResponse, jsonResponse } from "../lib/db";
import { getNoxDb, type NoxDatabaseEnv } from "../lib/nox-db";
import { createNoxCueServer } from "../lib/noxcue-client";

interface Env extends NoxDatabaseEnv {
  NOXCUE_INGEST?: Fetcher;
  NOXCUE_INGEST_KEY?: string;
  NOXCUE_NOXFEED_INGEST_KEY?: string;
}

interface Ctx {
  env: Env;
  data: { userLogin: string };
  request: Request;
}

interface ActivityRow {
  registered_at: string;
  last_active_period: string;
}

function utcPeriod(date: Date): string {
  return date.toISOString().slice(0, 10);
}

type TrackedApp = "noxconnect" | "noxfeed";

async function requestedApp(request: Request): Promise<TrackedApp> {
  if (!request.headers.get("Content-Type")?.toLowerCase().includes("application/json")) {
    return "noxconnect";
  }
  const body = await request.json().catch(() => null) as { app?: unknown } | null;
  if (body?.app === "noxconnect" || body?.app === "noxfeed") return body.app;
  throw new Error("invalid_app");
}

async function sendUserEvent(
  env: Env,
  key: string,
  type: "user.registered" | "user.active",
  userId: string,
  occurredAt: string,
): Promise<void> {
  const client = createNoxCueServer(env, key);
  if (!client) throw new Error("NoxCue user tracking is not configured");
  const result = type === "user.registered"
    ? await client.user.registered(userId, { occurredAt })
    : await client.user.active(userId, { occurredAt });
  if (!result.ok) throw new Error(`NoxCue rejected ${type}${result.status ? ` with status ${result.status}` : ""}`);
}

export async function onRequestPost(context: Ctx): Promise<Response> {
  const { userLogin } = getCtx(context) as Ctx["data"];
  if (!userLogin) return errorResponse("Missing user context", 400);

  const service = context.env.NOXCUE_INGEST;
  let appId: TrackedApp;
  try { appId = await requestedApp(context.request); }
  catch { return errorResponse("App must be noxconnect or noxfeed", 422); }
  const key = (appId === "noxfeed"
    ? context.env.NOXCUE_NOXFEED_INGEST_KEY
    : context.env.NOXCUE_INGEST_KEY)?.trim();
  if (!service || !key) return errorResponse("NoxCue user tracking is not configured", 503);

  const db = getNoxDb(context.env);
  const existing = await db.prepare(
    `SELECT registered_at, last_active_period
       FROM noxcue_app_user_activity WHERE app_id = ? AND github_login = ?`,
  ).bind(appId, userLogin).first<ActivityRow>();
  const now = new Date();
  const occurredAt = now.toISOString();
  const period = utcPeriod(now);

  try {
    if (!existing) {
      await sendUserEvent(context.env, key, "user.registered", userLogin, occurredAt);
      await db.prepare(
        `INSERT INTO noxcue_app_user_activity
           (app_id, github_login, registered_at, last_active_period, last_event_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(app_id, github_login) DO NOTHING`,
      ).bind(appId, userLogin, occurredAt, period, occurredAt).run();
      return jsonResponse({ app: appId, recorded: "registered", period }, 202);
    }

    if (existing.last_active_period === period) {
      return jsonResponse({ app: appId, recorded: "already_active", period });
    }

    await sendUserEvent(context.env, key, "user.active", userLogin, occurredAt);
    await db.prepare(
      `UPDATE noxcue_app_user_activity
          SET last_active_period = ?, last_event_at = ?
        WHERE app_id = ? AND github_login = ? AND last_active_period < ?`,
    ).bind(period, occurredAt, appId, userLogin, period).run();
    return jsonResponse({ app: appId, recorded: "active", period }, 202);
  } catch (error) {
    console.error(JSON.stringify({
      message: "NoxConnect user event delivery failed",
      app: appId,
      event: existing ? "user.active" : "user.registered",
      error: error instanceof Error ? error.message : String(error),
    }));
    return errorResponse("NoxCue user tracking is temporarily unavailable", 503);
  }
}
