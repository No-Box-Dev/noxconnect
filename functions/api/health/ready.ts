interface Env {
  DB: D1Database;
  NOXTICKET_SERVICE?: Fetcher;
  NOXSPOT_RESPONSE?: Fetcher;
  NOXCUE_RESPONSE?: Fetcher;
  NOXFEED_RESPONSE?: Fetcher;
}

interface Context { env: Env }
interface HeartbeatRow { status: string; last_succeeded_at: string | null }
interface CountRow { count: number }

const HEARTBEAT_MAX_AGE_MS = 75 * 60 * 1000;
const SERVICE_TIMEOUT_MS = 2_000;

async function probeService(service: Fetcher | undefined, url: string): Promise<boolean> {
  if (!service) return false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SERVICE_TIMEOUT_MS);
  try {
    const response = await service.fetch(new Request(url, { signal: controller.signal }));
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export async function onRequestGet(context: Context): Promise<Response> {
  const checks: Record<string, boolean> = {
    database: false,
    scheduledWorker: false,
    deliveryQueue: false,
    noxticket: false,
    noxspot: false,
    noxcue: false,
    noxfeed: false,
  };

  try {
    const heartbeat = await context.env.DB.prepare(
      "SELECT status, last_succeeded_at FROM service_heartbeats WHERE component = 'scheduled.cron'",
    ).first<HeartbeatRow>();
    const staleOutbox = await context.env.DB.prepare(`
      SELECT COUNT(*) AS count
      FROM delivery_outbox
      WHERE status IN ('pending', 'queued', 'processing', 'retrying')
        AND created_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-70 minutes')
    `).first<CountRow>();
    checks.database = true;
    const lastSuccessMs = heartbeat?.last_succeeded_at ? Date.parse(heartbeat.last_succeeded_at) : Number.NaN;
    checks.scheduledWorker = heartbeat?.status === "healthy"
      && Number.isFinite(lastSuccessMs)
      && Date.now() - lastSuccessMs <= HEARTBEAT_MAX_AGE_MS;
    checks.deliveryQueue = Number(staleOutbox?.count ?? 0) === 0;
  } catch {
    // Public health responses expose component state, never internal errors.
  }

  [checks.noxticket, checks.noxspot, checks.noxcue, checks.noxfeed] = await Promise.all([
    probeService(context.env.NOXTICKET_SERVICE, "https://noxticket.internal/health"),
    probeService(context.env.NOXSPOT_RESPONSE, "https://noxspot.internal/health"),
    probeService(context.env.NOXCUE_RESPONSE, "https://noxcue.internal/health"),
    probeService(context.env.NOXFEED_RESPONSE, "https://noxfeed.internal/health"),
  ]);

  const ready = Object.values(checks).every(Boolean);
  return Response.json(
    { service: "noxconnect", status: ready ? "ok" : "not_ready", checks },
    { status: ready ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
