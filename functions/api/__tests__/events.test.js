import { describe, it, expect } from "vitest";
import { onRequestGet as listEvents } from "../events.js";
import { onRequestGet as getEvent } from "../events/[id].js";

function makeDb({ allResult = [], firstResult = null } = {}) {
  const calls = { all: [], first: [] };
  return {
    prepare(sql) {
      return {
        _sql: sql,
        _binds: [],
        bind(...binds) { this._binds = binds; return this; },
        async all() { calls.all.push({ sql, binds: this._binds }); return { results: allResult }; },
        async first() { calls.first.push({ sql, binds: this._binds }); return firstResult; },
      };
    },
    _calls: calls,
  };
}

function makeCtx({ db, url = "http://x/api/events", params, orgLogin = "acme" } = {}) {
  return { request: new Request(url), env: { DB: db }, data: { orgLogin, projectId: "p1" }, params };
}

describe("GET /api/events", () => {
  it("400s when orgLogin is missing", async () => {
    const res = await listEvents(makeCtx({ db: makeDb(), orgLogin: null }));
    expect(res.status).toBe(400);
  });

  it("returns events and computes nextCursor from last row", async () => {
    const db = makeDb({
      allResult: [
        { id: 200, created_at: "2025-01-15T10:00:00Z", summary: "a" },
        { id: 199, created_at: "2025-01-15T09:00:00Z", summary: "b" },
      ],
    });
    const res = await listEvents(makeCtx({ db }));
    const body = await res.json();
    expect(body.events).toHaveLength(2);
    expect(body.nextCursor).toBe("2025-01-15T09:00:00Z:199");
  });

  it("returns null nextCursor when no results", async () => {
    const db = makeDb({ allResult: [] });
    const res = await listEvents(makeCtx({ db }));
    expect((await res.json()).nextCursor).toBe(null);
  });

  it("appends type/project_id/actor_id filters to SQL + binds", async () => {
    const db = makeDb();
    await listEvents(makeCtx({ db, url: "http://x/api/events?type=narrative&project_id=p1&actor_id=a1" }));
    const { sql, binds } = db._calls.all[0];
    expect(sql).toMatch(/type = \?/);
    expect(sql).toMatch(/project_id = \?/);
    expect(sql).toMatch(/actor_id = \?/);
    expect(binds).toContain("narrative");
    expect(binds).toContain("p1");
    expect(binds).toContain("a1");
  });

  it("supports the NoxSpot issue feed type", async () => {
    const db = makeDb();
    await listEvents(makeCtx({ db, url: "http://x/api/events?type=spot%3Aissue_created" }));
    const { sql, binds } = db._calls.all[0];
    expect(sql).toMatch(/type = \?/);
    expect(binds).toContain("spot:issue_created");
  });

  it("appends trigger_types IN (...) clause when provided", async () => {
    const db = makeDb();
    await listEvents(makeCtx({ db, url: "http://x/api/events?trigger_types=github%3Apr%3Amerged" }));
    const { sql, binds } = db._calls.all[0];
    expect(sql).toMatch(/json_extract\(payload_json, '\$\.trigger_type'\) IN \(\?\)/);
    expect(binds).toContain("github:pr:merged");
  });

  it("uses composite cursor when 'before' is parseable", async () => {
    const db = makeDb();
    await listEvents(makeCtx({ db, url: "http://x/api/events?before=2025-01-15T09:00:00Z:199" }));
    const { sql, binds } = db._calls.all[0];
    expect(sql).toMatch(/created_at < \? OR \(created_at = \? AND id < \?\)/);
    expect(binds.slice(-4, -1)).toEqual(["2025-01-15T09:00:00Z", "2025-01-15T09:00:00Z", 199]);
  });

  it("falls back to id-only when 'before' is a bare integer", async () => {
    const db = makeDb();
    await listEvents(makeCtx({ db, url: "http://x/api/events?before=42" }));
    const { sql, binds } = db._calls.all[0];
    expect(sql).toMatch(/id < \?/);
    expect(binds).toContain(42);
  });

  it("appends repo + pr_number filter matching pr.number OR pr_number", async () => {
    const db = makeDb();
    await listEvents(makeCtx({ db, url: "http://x/api/events?repo=noxconnect&pr_number=42" }));
    const { sql, binds } = db._calls.all[0];
    expect(sql).toMatch(/repo = \?/);
    // Raw github events store the number at $.pr.number
    expect(sql).toMatch(/\$\.pr\.number/);
    // Narrator rows (pr_narrative, narrative, release_notes) store it
    // at $.pr_number
    expect(sql).toMatch(/\$\.pr_number/);
    expect(binds).toContain("noxconnect");
    // Bound twice — once per branch of the OR
    expect(binds.filter((b) => b === 42)).toHaveLength(2);
  });

  it("ignores pr_number without repo (both required)", async () => {
    const db = makeDb();
    await listEvents(makeCtx({ db, url: "http://x/api/events?pr_number=42" }));
    const { sql } = db._calls.all[0];
    expect(sql).not.toMatch(/pr\.number/);
  });

  it("clamps limit to [1, 200] with default 50", async () => {
    const db = makeDb();
    // limit=999 → 200, last bind value is the limit
    await listEvents(makeCtx({ db, url: "http://x/api/events?limit=999" }));
    expect(db._calls.all[0].binds.at(-1)).toBe(200);

    await listEvents(makeCtx({ db, url: "http://x/api/events?limit=abc" }));
    expect(db._calls.all[1].binds.at(-1)).toBe(50);
  });
});

describe("GET /api/events/:id", () => {
  it("400s on missing id", async () => {
    const res = await getEvent(makeCtx({ db: makeDb(), params: {} }));
    expect(res.status).toBe(400);
  });

  it("400s on non-numeric id", async () => {
    const res = await getEvent(makeCtx({ db: makeDb(), params: { id: "abc" } }));
    expect(res.status).toBe(400);
  });

  it("404s when row is missing", async () => {
    const db = makeDb({ firstResult: null });
    const res = await getEvent(makeCtx({ db, params: { id: "42" } }));
    expect(res.status).toBe(404);
  });

  it("returns the event row scoped to org", async () => {
    const db = makeDb({ firstResult: { id: 42, type: "narrative", summary: "shipped" } });
    const res = await getEvent(makeCtx({ db, params: { id: "42" } }));
    expect(await res.json()).toEqual({ event: { id: 42, type: "narrative", summary: "shipped" } });
    // SQL should filter on owner_id
    expect(db._calls.first[0].binds).toEqual([42, "acme"]);
  });
});
