import { describe, it, expect, vi, afterEach } from "vitest";
import { onRequestGet, onRequestPut } from "../config/[key].js";

function makeDb({ firstResult = null, allResult = { results: [] } } = {}) {
  const calls = { run: [], first: [], all: [], batch: [] };
  const db = {
    prepare(sql) {
      return {
        _sql: sql,
        _binds: [],
        bind(...binds) { this._binds = binds; return this; },
        async first() { calls.first.push({ sql, binds: this._binds }); return firstResult; },
        async run() { calls.run.push({ sql, binds: this._binds }); return { meta: { changes: 1 } }; },
        async all() { calls.all.push({ sql, binds: this._binds }); return allResult; },
      };
    },
    async batch(statements) {
      calls.batch.push(...statements);
      return statements.map(() => ({ meta: { changes: 1 } }));
    },
    _calls: calls,
  };
  return db;
}

function makeCtx({ db, params, method = "GET", body, headers = {}, isAdmin = true } = {}) {
  const req = body !== undefined
    ? new Request("http://x/api/config", { method, headers: { "Content-Type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) })
    : new Request("http://x/api/config", { method, headers });
  return { request: req, env: { DB: db }, data: { orgId: 1, orgLogin: "acme", isAdmin }, params };
}

afterEach(() => vi.restoreAllMocks());

describe("GET /api/config/:key", () => {
  it("400s on unknown key", async () => {
    const res = await onRequestGet(makeCtx({ db: makeDb(), params: { key: "evil" } }));
    expect(res.status).toBe(400);
  });

  it("returns default ([] for features) when row is missing", async () => {
    const db = makeDb({ firstResult: null });
    const res = await onRequestGet(makeCtx({ db, params: { key: "features" } }));
    expect(await res.json()).toEqual([]);
  });

  it("returns null default for settings when row missing", async () => {
    const db = makeDb({ firstResult: null });
    const res = await onRequestGet(makeCtx({ db, params: { key: "settings" } }));
    expect(await res.json()).toBe(null);
  });

  it("parses and returns the stored JSON", async () => {
    const db = makeDb({ firstResult: { data: '[{"title":"X"}]' } });
    const res = await onRequestGet(makeCtx({ db, params: { key: "features" } }));
    expect(await res.json()).toEqual([{ title: "X" }]);
  });

  it("returns canonical NoxTicket settings for pre-rename stored fields", async () => {
    const prefix = ["un", "ticket"].join("");
    const db = makeDb({ firstResult: { data: JSON.stringify({
      [`${prefix}Repo`]: "legacy-config",
      slack: { [`${prefix}ChannelId`]: "C1", [`${prefix}ConnectionId`]: "conn-1" },
    }) } });
    const res = await onRequestGet(makeCtx({ db, params: { key: "settings" } }));
    expect(await res.json()).toEqual({
      noxTicketRepo: "legacy-config",
      slack: { noxTicketChannelId: "C1", noxTicketConnectionId: "conn-1" },
    });
  });

  it("500s loudly on corrupt JSON", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = makeDb({ firstResult: { data: "{not json" } });
    const res = await onRequestGet(makeCtx({ db, params: { key: "features" } }));
    expect(res.status).toBe(500);
    expect(errSpy).toHaveBeenCalled();
  });
});
describe("PUT /api/config/:key", () => {
  it("403s non-admin settings writes", async () => {
    const res = await onRequestPut(makeCtx({ db: makeDb(), params: { key: "settings" }, method: "PUT", body: {}, isAdmin: false }));
    expect(res.status).toBe(403);
  });

  it("400s on unknown key", async () => {
    const res = await onRequestPut(makeCtx({ db: makeDb(), params: { key: "evil" }, method: "PUT", body: {} }));
    expect(res.status).toBe(400);
  });

  it("400s on invalid JSON", async () => {
    const res = await onRequestPut(makeCtx({ db: makeDb(), params: { key: "features" }, method: "PUT", body: "{ broken" }));
    expect(res.status).toBe(400);
  });

  it("413s when Content-Length header exceeds 256KB", async () => {
    const res = await onRequestPut(makeCtx({
      db: makeDb(),
      params: { key: "features" },
      method: "PUT",
      body: {},
      headers: { "Content-Length": String(256 * 1024 + 1) },
    }));
    expect(res.status).toBe(413);
  });

  it("413s when serialized UTF-8 byte length exceeds 256KB", async () => {
    // Build a payload > 256KB to ensure UTF-8 byte-length check catches it
    // even without a Content-Length header.
    const big = { items: "x".repeat(300 * 1024) };
    const res = await onRequestPut(makeCtx({
      db: makeDb(),
      params: { key: "features" },
      method: "PUT",
      body: big,
    }));
    expect(res.status).toBe(413);
  });

  it("upserts the row with serialized JSON", async () => {
    const db = makeDb();
    const res = await onRequestPut(makeCtx({
      db,
      params: { key: "features" },
      method: "PUT",
      body: [{ title: "Login" }],
    }));
    expect(res.status).toBe(200);
    expect(db._calls.run).toHaveLength(1);
    expect(db._calls.run[0].binds[0]).toBe(1);
    expect(db._calls.run[0].binds[1]).toBe("features");
    expect(db._calls.run[0].binds[2]).toBe(JSON.stringify([{ title: "Login" }]));
  });
});

describe("PUT /api/config/settings — NoxFeed daily summary", () => {
  it("saves a valid local time and IANA timezone", async () => {
    const db = makeDb();
    const res = await onRequestPut(makeCtx({
      db,
      params: { key: "settings" },
      method: "PUT",
      body: { noxfeedDailySummary: { enabled: true, timeLocal: "17:30", timezone: "Asia/Kuala_Lumpur" } },
    }));
    expect(res.status).toBe(200);
    expect(JSON.parse(db._calls.run[0].binds[2]).noxfeedDailySummary).toEqual({
      enabled: true,
      timeLocal: "17:30",
      timezone: "Asia/Kuala_Lumpur",
    });
  });

  it.each([
    [{ enabled: "yes", timeLocal: "17:00", timezone: "UTC" }, "on or off"],
    [{ enabled: true, timeLocal: "29:00", timezone: "UTC" }, "valid daily summary time"],
    [{ enabled: true, timeLocal: "17:00", timezone: "Not/AZone" }, "valid daily summary timezone"],
  ])("rejects invalid daily summary settings", async (noxfeedDailySummary, message) => {
    const res = await onRequestPut(makeCtx({
      db: makeDb(),
      params: { key: "settings" },
      method: "PUT",
      body: { noxfeedDailySummary },
    }));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toContain(message);
  });
});

describe("PUT /api/config/settings — boardStages validation", () => {
  const validStages = [
    { id: "todo", label: "To do", color: "#94a3b8" },
    { id: "done", label: "Done", color: "#6e9970" },
  ];

  it("422s when boardStages is empty", async () => {
    const res = await onRequestPut(makeCtx({
      db: makeDb(),
      params: { key: "settings" },
      method: "PUT",
      body: { boardStages: [] },
    }));
    expect(res.status).toBe(422);
  });

  it("422s on invalid stage id", async () => {
    const res = await onRequestPut(makeCtx({
      db: makeDb(),
      params: { key: "settings" },
      method: "PUT",
      body: { boardStages: [{ id: "BAD ID", label: "x", color: "#94a3b8" }] },
    }));
    expect(res.status).toBe(422);
  });

  it("422s on invalid hex color", async () => {
    const res = await onRequestPut(makeCtx({
      db: makeDb(),
      params: { key: "settings" },
      method: "PUT",
      body: { boardStages: [{ id: "todo", label: "x", color: "blue" }] },
    }));
    expect(res.status).toBe(422);
  });

  it("422s on duplicate stage ids", async () => {
    const res = await onRequestPut(makeCtx({
      db: makeDb(),
      params: { key: "settings" },
      method: "PUT",
      body: {
        boardStages: [
          { id: "todo", label: "x", color: "#94a3b8" },
          { id: "todo", label: "y", color: "#94a3b8" },
        ],
      },
    }));
    expect(res.status).toBe(422);
  });

  it("409s and returns orphans when removing a stage that still contains features", async () => {
    const db = makeDb({
      allResult: {
        results: [
          {
            number: 7,
            title: "Old feature",
            labels_json: JSON.stringify([{ name: "status:legacy" }]),
          },
        ],
      },
    });
    const res = await onRequestPut(makeCtx({
      db,
      params: { key: "settings" },
      method: "PUT",
      body: { boardStages: validStages },
    }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.orphans).toHaveLength(1);
    expect(body.orphans[0]).toMatchObject({ number: 7, title: "Old feature", status: "legacy" });
    // Should NOT have written the row.
    expect(db._calls.run).toHaveLength(0);
  });

  it("saves when boardStages is valid and no orphans exist", async () => {
    const db = makeDb({ allResult: { results: [] } });
    const res = await onRequestPut(makeCtx({
      db,
      params: { key: "settings" },
      method: "PUT",
      body: { boardStages: validStages },
    }));
    expect(res.status).toBe(200);
    expect(db._calls.run).toHaveLength(1);
  });
});

describe("PUT /api/config/settings — app toggles", () => {
  it("migrates a retired alert toggle before validating and saving settings", async () => {
    const db = makeDb();
    const res = await onRequestPut(makeCtx({
      db,
      params: { key: "settings" },
      method: "PUT",
      body: {
        apps: { noxalert: false, noxfeed: true },
        slack: {
          noxalertChannelId: "",
          releaseNotesChannelId: "",
        },
        savedSiteName: "Keep unrelated settings",
      },
    }));

    expect(res.status).toBe(200);
    const saved = JSON.parse(db._calls.batch[0]._binds[2]);
    expect(saved.apps).toEqual({ noxfeed: true, noxcue: false });
    expect(saved.slack).toEqual({ noxCueChannelId: "", releaseNotesChannelId: "" });
    expect(saved.savedSiteName).toBe("Keep unrelated settings");
  });

  it("persists optional app booleans", async () => {
    const db = makeDb();
    const body = {
      apps: { noxfeed: false, noxticket: true, noxspot: false, noxcue: true },
      slack: undefined,
      savedSiteName: "Keep this setup",
    };
    const res = await onRequestPut(makeCtx({ db, params: { key: "settings" }, method: "PUT", body }));
    expect(res.status).toBe(200);
    expect(db._calls.run).toHaveLength(0);
    expect(db._calls.batch[0]._binds[2]).toBe(JSON.stringify(body));
    expect(db._calls.batch.slice(1)).toHaveLength(4);
    expect(db._calls.batch[1]._sql).toContain("blocked_service_disabled");
    expect(db._calls.batch[1]._binds).toContain("noxticket");
    expect(db._calls.batch[2]._sql).toContain("blocked_service_disabled");
    expect(db._calls.batch[2]._binds).toEqual(expect.arrayContaining(["posts", "release_notes"]));
    expect(db._calls.batch[3]._sql).toContain("blocked_service_disabled");
    expect(db._calls.batch[3]._binds).toContain("noxspot");
    expect(db._calls.batch[4]._sql).toContain("status = 'pending'");
    expect(db._calls.batch[4]._binds).toContain("noxcue");
  });

  it("rejects NoxConnect and non-boolean app values", async () => {
    for (const apps of [{ noxconnect: false }, { noxfeed: "yes" }]) {
      const res = await onRequestPut(makeCtx({
        db: makeDb(), params: { key: "settings" }, method: "PUT", body: { apps },
      }));
      expect(res.status).toBe(422);
    }
  });
});

describe("PUT /api/config/settings — release-notes prompt", () => {
  it("saves the complete prompt exactly as entered", async () => {
    const db = makeDb();
    const prompt = "Audience: internal teams\nInclude impact, rollout, and verification.";
    const res = await onRequestPut(makeCtx({
      db,
      params: { key: "settings" },
      method: "PUT",
      body: { releaseNotesPrompt: prompt },
    }));

    expect(res.status).toBe(200);
    expect(JSON.parse(db._calls.run[0].binds[2]).releaseNotesPrompt).toBe(prompt);
  });

  it("removes an empty override so the built-in base is used", async () => {
    const db = makeDb();
    const res = await onRequestPut(makeCtx({
      db,
      params: { key: "settings" },
      method: "PUT",
      body: { releaseNotesPrompt: "   ", savedSiteName: "keep" },
    }));

    expect(res.status).toBe(200);
    expect(JSON.parse(db._calls.run[0].binds[2])).toEqual({ savedSiteName: "keep" });
  });

  it("rejects non-text and oversized prompts with a clear correction", async () => {
    for (const releaseNotesPrompt of [123, "x".repeat(20_001)]) {
      const res = await onRequestPut(makeCtx({
        db: makeDb(),
        params: { key: "settings" },
        method: "PUT",
        body: { releaseNotesPrompt },
      }));
      expect(res.status).toBe(422);
      expect((await res.json()).error).toMatch(/prompt/i);
    }
  });
});
