import { describe, it, expect } from "vitest";
import { onRequestGet as listActors } from "../actors.js";
import { onRequestGet as getActor, onRequestPatch as patchActor } from "../actors/[id]";

function makeDb({ allResult = [], firstResults = [] } = {}) {
  const calls = { all: [], first: [], run: [] };
  let firstIdx = 0;
  return {
    prepare(sql) {
      return {
        _sql: sql,
        _binds: [],
        bind(...binds) { this._binds = binds; return this; },
        async all() { calls.all.push({ sql, binds: this._binds }); return { results: allResult }; },
        async first() {
          calls.first.push({ sql, binds: this._binds });
          return firstIdx < firstResults.length ? firstResults[firstIdx++] : null;
        },
        async run() { calls.run.push({ sql, binds: this._binds }); return { meta: { changes: 1 } }; },
      };
    },
    _calls: calls,
  };
}

function makeCtx({ db, params, body, orgLogin = "acme", method = "GET", isAdmin = true }) {
  const req = body !== undefined
    ? new Request("http://x/api/actors", { method, headers: { "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) })
    : new Request("http://x/api/actors", { method });
  return { request: req, env: { DB: db }, data: { orgId: 1, orgLogin, isAdmin }, params };
}

describe("GET /api/actors", () => {
  it("400s when orgLogin is missing", async () => {
    const res = await listActors(makeCtx({ db: makeDb(), orgLogin: null }));
    expect(res.status).toBe(400);
  });

  it("returns the unioned rows wrapped as { actors: [...] }", async () => {
    const db = makeDb({ allResult: [{ id: "actor_alice", name: "Alice" }] });
    const res = await listActors(makeCtx({ db }));
    expect(await res.json()).toEqual({ actors: [{ id: "actor_alice", name: "Alice" }] });
  });
});

describe("GET /api/actors/:id", () => {
  it("400s when id is missing", async () => {
    const res = await getActor(makeCtx({ db: makeDb(), params: {} }));
    expect(res.status).toBe(400);
  });

  it("returns the joined row when found", async () => {
    const db = makeDb({ firstResults: [{ id: "actor_alice", name: "Alice", github_login: "alice" }] });
    const res = await getActor(makeCtx({ db, params: { id: "actor_alice" } }));
    expect(await res.json()).toEqual({ actor: { id: "actor_alice", name: "Alice", github_login: "alice" } });
  });

  it("falls back to the standalone actors query if join misses", async () => {
    const db = makeDb({ firstResults: [null, { id: "actor_standalone", name: "Lone" }] });
    const res = await getActor(makeCtx({ db, params: { id: "actor_standalone" } }));
    expect(await res.json()).toEqual({ actor: { id: "actor_standalone", name: "Lone" } });
  });

  it("404s when neither query returns a row", async () => {
    const db = makeDb({ firstResults: [null, null] });
    const res = await getActor(makeCtx({ db, params: { id: "ghost" } }));
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/actors/:id", () => {
  it("403s non-admin updates", async () => {
    const res = await patchActor(makeCtx({ db: makeDb(), params: { id: "actor_alice" }, method: "PATCH", body: { tone: "warm" }, isAdmin: false }));
    expect(res.status).toBe(403);
  });

  it("400s on invalid JSON", async () => {
    const res = await patchActor(makeCtx({ db: makeDb(), params: { id: "actor_alice" }, method: "PATCH", body: "{ broken" }));
    expect(res.status).toBe(400);
  });

  it("404s when actor row doesn't exist and id is not actor_<login>", async () => {
    const db = makeDb({ firstResults: [null] });
    const res = await patchActor(makeCtx({ db, params: { id: "weird_id" }, method: "PATCH", body: { tone: "x" } }));
    expect(res.status).toBe(404);
  });

  it("404s when actor_<login> exists but no matching gh_users row", async () => {
    const db = makeDb({ firstResults: [null, null] }); // not existing, no gh_user
    const res = await patchActor(makeCtx({ db, params: { id: "actor_ghost" }, method: "PATCH", body: { tone: "x" } }));
    expect(res.status).toBe(404);
  });

  it("400s when no editable fields supplied", async () => {
    const db = makeDb({ firstResults: [{ id: "actor_alice" }] });
    const res = await patchActor(makeCtx({ db, params: { id: "actor_alice" }, method: "PATCH", body: { not_editable: "x" } }));
    expect(res.status).toBe(400);
  });

  it("updates editable fields and returns fresh row", async () => {
    const db = makeDb({
      firstResults: [
        { id: "actor_alice" },                                // existing actors row check
        { id: "actor_alice", name: "Alice", tone: "warm" },   // refetch after update
      ],
    });
    const res = await patchActor(makeCtx({
      db,
      params: { id: "actor_alice" },
      method: "PATCH",
      body: { tone: "warm", name: "Alice" },
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ actor: { id: "actor_alice", name: "Alice", tone: "warm" } });
    // The UPDATE statement should bind values + the actor id + owner_id
    const update = db._calls.run[0];
    expect(update.sql).toMatch(/UPDATE actors SET tone = \?, name = \?/);
    expect(update.binds.at(-2)).toBe("actor_alice");
    expect(update.binds.at(-1)).toBe("acme");
  });

  it("coerces empty string to null when binding", async () => {
    const db = makeDb({
      firstResults: [
        { id: "actor_alice" },
        { id: "actor_alice", tone: null },
      ],
    });
    await patchActor(makeCtx({
      db,
      params: { id: "actor_alice" },
      method: "PATCH",
      body: { tone: "" },
    }));
    expect(db._calls.run[0].binds[0]).toBe(null);
  });
});
