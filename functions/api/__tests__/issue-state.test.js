import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../lib/github-app.js", () => ({
  getInstallationIdForOrg: vi.fn(async () => 12345),
  getInstallationToken: vi.fn(async () => "install-tok"),
}));
vi.mock("../../lib/inactive-repos.js", () => ({ getActiveRepoNames: vi.fn(async () => ["api"]) }));

import { onRequestPost } from "../issue-state";
import { getInstallationIdForOrg, getInstallationToken } from "../../lib/github-app.js";

function makeDb() {
  const calls = { run: [] };
  return {
    prepare(sql) {
      return {
        _sql: sql,
        _binds: [],
        bind(...binds) { this._binds = binds; return this; },
        async run() { calls.run.push({ sql, binds: this._binds }); return { meta: { changes: 1 } }; },
      };
    },
    _calls: calls,
  };
}

function makeContext({ body, db }) {
  const req = new Request("http://x/api/issue-state", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { request: req, env: { DB: db ?? makeDb() }, data: { orgId: 1, orgLogin: "acme", projectId: "project-1" } };
}

beforeEach(() => {
  global.fetch = vi.fn();
  getInstallationIdForOrg.mockResolvedValue(12345);
  getInstallationToken.mockResolvedValue("install-tok");
});
afterEach(() => vi.restoreAllMocks());

describe("POST /api/issue-state", () => {
  it("400s on bad JSON", async () => {
    const res = await onRequestPost(makeContext({ body: "broken" }));
    expect(res.status).toBe(400);
  });

  it("400s on missing fields", async () => {
    const res = await onRequestPost(makeContext({ body: { repo: "api" } }));
    expect(res.status).toBe(400);
  });

  it("400s on invalid state", async () => {
    const res = await onRequestPost(makeContext({ body: { repo: "api", issue_number: 1, state: "frozen" } }));
    expect(res.status).toBe(400);
  });

  it("400s on bad repo name", async () => {
    const res = await onRequestPost(makeContext({ body: { repo: "../etc", issue_number: 1, state: "open" } }));
    expect(res.status).toBe(400);
  });

  it("400s on bad issue_number", async () => {
    const res = await onRequestPost(makeContext({ body: { repo: "api", issue_number: 0, state: "open" } }));
    expect(res.status).toBe(400);
  });

  it("forwards GitHub status on error", async () => {
    global.fetch.mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ message: "Not Found" }),
    });
    const res = await onRequestPost(makeContext({ body: { repo: "api", issue_number: 99, state: "closed" } }));
    expect(res.status).toBe(404);
  });

  it("412s when the GitHub App isn't installed for this org", async () => {
    getInstallationIdForOrg.mockResolvedValueOnce(null);
    const res = await onRequestPost(makeContext({ body: { repo: "api", issue_number: 1, state: "closed" } }));
    expect(res.status).toBe(412);
  });

  it("500s when the install-token fetch throws", async () => {
    getInstallationToken.mockRejectedValueOnce(new Error("network"));
    const res = await onRequestPost(makeContext({ body: { repo: "api", issue_number: 1, state: "closed" } }));
    expect(res.status).toBe(500);
  });

  it("PATCHes GitHub with the install token, then updates D1 with closed_at", async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ closed_at: "2025-01-15T10:00:00Z" }),
    });
    const ctx = makeContext({ body: { repo: "api", issue_number: 42, state: "closed" } });
    const res = await onRequestPost(ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, state: "closed", closed_at: "2025-01-15T10:00:00Z" });
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/issues/42"),
      expect.objectContaining({
        method: "PATCH",
        headers: expect.objectContaining({ Authorization: "Bearer install-tok" }),
      }),
    );
    expect(ctx.env.DB._calls.run).toHaveLength(1);
    const { sql, binds } = ctx.env.DB._calls.run[0];
    expect(sql).toMatch(/UPDATE issues SET state = \?, closed_at = \?/);
    expect(binds).toEqual(["closed", "2025-01-15T10:00:00Z", 1, "api", 42]);
  });

  it("sets closed_at=null when reopening (GitHub returns closed_at=null)", async () => {
    global.fetch.mockResolvedValue({ ok: true, json: async () => ({ closed_at: null }) });
    const ctx = makeContext({ body: { repo: "api", issue_number: 42, state: "open" } });
    const res = await onRequestPost(ctx);
    expect(res.status).toBe(200);
    expect(ctx.env.DB._calls.run[0].binds[1]).toBe(null);
  });
});
