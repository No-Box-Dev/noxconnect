import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../lib/github-app.js", () => ({
  getInstallationIdForOrg: vi.fn(async () => 12345),
  getInstallationToken: vi.fn(async () => "install-tok"),
}));
vi.mock("../../lib/inactive-repos.js", () => ({ getActiveRepoNames: vi.fn(async () => ["api"]) }));

import { onRequestPost } from "../assign";
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

function makeContext({ db, body, orgId = 1, orgLogin = "acme" }) {
  const req = new Request("http://x/api/assign", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { request: req, env: { DB: db }, data: { orgId, orgLogin, projectId: "project-1" } };
}

beforeEach(() => {
  global.fetch = vi.fn();
  getInstallationIdForOrg.mockResolvedValue(12345);
  getInstallationToken.mockResolvedValue("install-tok");
});
afterEach(() => vi.restoreAllMocks());

describe("POST /api/assign", () => {
  it("400s on bad JSON", async () => {
    const res = await onRequestPost(makeContext({ db: makeDb(), body: "{ broken" }));
    expect(res.status).toBe(400);
  });

  it("400s when required fields are missing", async () => {
    const res = await onRequestPost(makeContext({ db: makeDb(), body: { repo: "api" } }));
    expect(res.status).toBe(400);
  });

  it("400s on invalid repo name", async () => {
    const res = await onRequestPost(makeContext({ db: makeDb(), body: { repo: "../etc/passwd", issue_number: 1, assignees: [] } }));
    expect(res.status).toBe(400);
  });

  it("400s on invalid issue_number", async () => {
    const res = await onRequestPost(makeContext({ db: makeDb(), body: { repo: "api", issue_number: 0, assignees: [] } }));
    expect(res.status).toBe(400);
  });

  it("400s on invalid assignee username", async () => {
    const res = await onRequestPost(makeContext({ db: makeDb(), body: { repo: "api", issue_number: 1, assignees: ["bad name"] } }));
    expect(res.status).toBe(400);
  });

  it("propagates GitHub error status + message", async () => {
    global.fetch.mockResolvedValue({
      ok: false,
      status: 422,
      statusText: "Unprocessable",
      json: async () => ({ message: "Unprocessable Entity" }),
    });
    const res = await onRequestPost(makeContext({ db: makeDb(), body: { repo: "api", issue_number: 1, assignees: ["alice"] } }));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "Unprocessable Entity" });
  });

  it("412s when the GitHub App isn't installed for this org", async () => {
    getInstallationIdForOrg.mockResolvedValueOnce(null);
    const res = await onRequestPost(makeContext({ db: makeDb(), body: { repo: "api", issue_number: 1, assignees: ["alice"] } }));
    expect(res.status).toBe(412);
  });

  it("500s when the install-token fetch throws", async () => {
    getInstallationToken.mockRejectedValueOnce(new Error("network"));
    const res = await onRequestPost(makeContext({ db: makeDb(), body: { repo: "api", issue_number: 1, assignees: ["alice"] } }));
    expect(res.status).toBe(500);
  });

  it("PATCHes GitHub with the install token, updates D1, returns mapped assignees", async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ assignees: [{ login: "alice", avatar_url: "https://a/a.png" }] }),
    });
    const db = makeDb();
    const res = await onRequestPost(makeContext({ db, body: { repo: "api", issue_number: 42, assignees: ["alice"] } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ assignees: [{ login: "alice", avatar_url: "https://a/a.png" }] });

    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/acme/api/issues/42",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ assignees: ["alice"] }),
        headers: expect.objectContaining({
          Authorization: "Bearer install-tok",
        }),
      }),
    );

    expect(db._calls.run).toHaveLength(1);
    expect(db._calls.run[0].sql).toMatch(/UPDATE issues SET assignees_json/);
    expect(db._calls.run[0].binds[0]).toBe(JSON.stringify([{ login: "alice", avatar_url: "https://a/a.png" }]));
    expect(db._calls.run[0].binds).toContain(42);
  });
});
