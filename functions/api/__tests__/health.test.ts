import { describe, expect, it, vi } from "vitest";
import { onRequestGet as live } from "../health/live";
import { onRequestGet as ready } from "../health/ready";

function service(ok = true): Fetcher {
  return { fetch: vi.fn(async () => new Response(null, { status: ok ? 200 : 503 })) } as unknown as Fetcher;
}

function context(options: { heartbeat?: { status: string; last_succeeded_at: string } | null; stale?: number; dbError?: boolean; serviceOk?: boolean } = {}) {
  const heartbeat = options.heartbeat === undefined
    ? { status: "healthy", last_succeeded_at: new Date().toISOString() }
    : options.heartbeat;
  const prepare = vi.fn((sql: string) => ({
    first: vi.fn(async () => {
      if (options.dbError) throw new Error("database unavailable");
      return sql.includes("service_heartbeats") ? heartbeat : { count: options.stale ?? 0 };
    }),
  }));
  return {
    env: {
      DB: { prepare },
      NOXSPOT_RESPONSE: service(options.serviceOk ?? true),
      NOXFEED_RESPONSE: service(options.serviceOk ?? true),
    },
  } as never;
}

describe("NoxConnect health", () => {
  it("returns a minimal liveness response", async () => {
    const response = live();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ service: "noxconnect", status: "ok" });
  });

  it("is ready when storage, cron, queue and product services are healthy", async () => {
    const response = await ready(context());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok", checks: { database: true, scheduledWorker: true, deliveryQueue: true, noxspot: true, noxfeed: true } });
  });

  it("is not ready before a real scheduled heartbeat exists", async () => {
    const response = await ready(context({ heartbeat: null }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ status: "not_ready", checks: { scheduledWorker: false } });
  });

  it("is not ready for a stale heartbeat or stuck durable delivery", async () => {
    const response = await ready(context({
      heartbeat: { status: "healthy", last_succeeded_at: new Date(Date.now() - 80 * 60 * 1000).toISOString() },
      stale: 1,
    }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ checks: { scheduledWorker: false, deliveryQueue: false } });
  });

  it("fails closed without exposing database errors", async () => {
    const response = await ready(context({ dbError: true }));
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).not.toContain("database unavailable");
  });

  it("is not ready when a required product service is unavailable", async () => {
    const response = await ready(context({ serviceOk: false }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ checks: { noxspot: false, noxfeed: false } });
  });
});
