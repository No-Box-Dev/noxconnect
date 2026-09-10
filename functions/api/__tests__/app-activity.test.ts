import { describe, expect, it, vi } from "vitest";
import { onRequestPost } from "../app-activity";

function makeContext(existing: { registered_at: string; last_active_period: string } | null, app?: "noxconnect" | "noxfeed") {
  const writes: Array<{ sql: string; binds: unknown[] }> = [];
  const requests: Request[] = [];
  const db = {
    prepare(sql: string) {
      const statement = {
        binds: [] as unknown[],
        bind(...values: unknown[]) { this.binds = values; return this; },
        async first() { return existing; },
        async run() { writes.push({ sql, binds: this.binds }); return { success: true }; },
      };
      return statement;
    },
  };
  const fetch = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
    requests.push(new Request(request, init));
    return new Response(JSON.stringify({ accepted: true }), { status: 202 });
  });
  return {
    context: {
      env: {
        DB: db,
        NOXCUE_INGEST_KEY: `nox_secret_${"a".repeat(40)}`,
        NOXCUE_NOXFEED_INGEST_KEY: `nox_secret_${"b".repeat(40)}`,
        NOXCUE_INGEST: { fetch },
      },
      data: { userLogin: "Alice" },
      request: new Request("https://app.noxhere.com/api/app-activity", app ? {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app }),
      } : { method: "POST" }),
    },
    fetch,
    requests,
    writes,
  };
}

describe("POST /api/app-activity", () => {
  it("records a first visit as a registration using the trusted user", async () => {
    const state = makeContext(null);
    const response = await onRequestPost(state.context as never);

    expect(response.status).toBe(202);
    expect(state.fetch).toHaveBeenCalledOnce();
    expect(await state.requests[0]!.json()).toMatchObject({
      type: "user.registered",
      userId: "Alice",
    });
    expect(state.requests[0]!.headers.get("X-Nox-Ingest-Key")).toBe(`nox_secret_${"a".repeat(40)}`);
    expect(state.writes.some(({ sql }) => sql.includes("INSERT INTO noxcue_app_user_activity"))).toBe(true);
  });

  it("does not emit a duplicate event for an already-active user", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const state = makeContext({ registered_at: new Date().toISOString(), last_active_period: today });
    const response = await onRequestPost(state.context as never);

    expect(response.status).toBe(200);
    expect(state.fetch).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({ recorded: "already_active", period: today });
  });

  it("records activity on the next UTC day", async () => {
    const state = makeContext({ registered_at: "2026-08-30T00:00:00Z", last_active_period: "2026-08-30" });
    const response = await onRequestPost(state.context as never);

    expect(response.status).toBe(202);
    expect(await state.requests[0]!.json()).toMatchObject({ type: "user.active", userId: "Alice" });
    expect(state.writes.some(({ sql }) => sql.includes("UPDATE noxcue_app_user_activity"))).toBe(true);
  });

  it("keeps NoxFeed users in its own source", async () => {
    const state = makeContext(null, "noxfeed");
    const response = await onRequestPost(state.context as never);

    expect(response.status).toBe(202);
    expect(state.requests[0]!.headers.get("X-Nox-Ingest-Key")).toBe(`nox_secret_${"b".repeat(40)}`);
    expect(state.writes.find(({ sql }) => sql.includes("INSERT INTO noxcue_app_user_activity"))?.binds[0]).toBe("noxfeed");
    expect(await response.json()).toMatchObject({ app: "noxfeed", recorded: "registered" });
  });

  it("does not advance local state when NoxCue rejects the event", async () => {
    const state = makeContext(null);
    state.fetch.mockResolvedValueOnce(new Response("no", { status: 401 }));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const response = await onRequestPost(state.context as never);
      expect(response.status).toBe(503);
      expect(state.writes).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });
});
