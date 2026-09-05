import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../lib/inactive-repos.js", () => ({
  getActiveRepoNames: vi.fn(),
}));

import { onRequestGet as getIssue } from "../issues/[repo]/[number].js";
import { onRequestGet as getPR } from "../prs/[repo]/[number].js";
import { onRequestPost as archivePost, onRequestDelete as archiveDelete } from "../projects/[id]/archive.js";
import { getActiveRepoNames } from "../../lib/inactive-repos.js";

function makeDb({ firstResult = null, projectResult = { repo: "api", archived: 0 }, runResult = { meta: { changes: 1 } } } = {}) {
  const calls = { first: [], run: [] };
  return {
    prepare(sql) {
      return {
        _sql: sql,
        _binds: [],
        bind(...binds) { this._binds = binds; return this; },
        async first() {
          calls.first.push({ sql, binds: this._binds });
          return sql.includes("FROM projects project") ? projectResult : firstResult;
        },
        async run() { calls.run.push({ sql, binds: this._binds }); return runResult; },
      };
    },
    _calls: calls,
  };
}

function makeCtx({ db, params, method = "GET", body, data = { orgId: 1, orgLogin: "acme", isAdmin: true } } = {}) {
  const req = body !== undefined
    ? new Request("http://x/api", { method, body: typeof body === "string" ? body : JSON.stringify(body) })
    : new Request("http://x/api", { method });
  return { request: req, env: { DB: db }, data, params };
}

beforeEach(() => getActiveRepoNames.mockReset());

describe("GET /api/issues/:repo/:number", () => {
  it("400s on missing repo", async () => {
    const res = await getIssue(makeCtx({ db: makeDb(), params: { number: "1" } }));
    expect(res.status).toBe(400);
  });

  it("400s on invalid number", async () => {
    const res = await getIssue(makeCtx({ db: makeDb(), params: { repo: "api", number: "abc" } }));
    expect(res.status).toBe(400);
  });

  it("404s when repo is not active", async () => {
    getActiveRepoNames.mockResolvedValue(["other"]);
    const res = await getIssue(makeCtx({ db: makeDb(), params: { repo: "api", number: "1" } }));
    expect(res.status).toBe(404);
  });

  it("404s when issue row is missing", async () => {
    getActiveRepoNames.mockResolvedValue(["api"]);
    const res = await getIssue(makeCtx({ db: makeDb({ firstResult: null }), params: { repo: "api", number: "1" } }));
    expect(res.status).toBe(404);
  });

  it("returns the issue with parsed JSON fields", async () => {
    getActiveRepoNames.mockResolvedValue(["api"]);
    const row = {
      id: 1,
      number: 42,
      title: "Bug",
      assignees_json: '[{"login":"alice"}]',
      labels_json: '[{"name":"bug"}]',
      closed_by: null,
    };
    const res = await getIssue(makeCtx({ db: makeDb({ firstResult: row }), params: { repo: "api", number: "42" } }));
    const body = await res.json();
    expect(body.issue.assignees).toEqual([{ login: "alice" }]);
    expect(body.issue.labels).toEqual([{ name: "bug" }]);
    expect(body.issue.closed_by).toBe(null);
  });
});

describe("GET /api/prs/:repo/:number", () => {
  it("400s on invalid number", async () => {
    const res = await getPR(makeCtx({ db: makeDb(), params: { repo: "api", number: "0" } }));
    expect(res.status).toBe(400);
  });

  it("404s when repo is inactive", async () => {
    getActiveRepoNames.mockResolvedValue([]);
    const res = await getPR(makeCtx({ db: makeDb(), params: { repo: "api", number: "1" } }));
    expect(res.status).toBe(404);
  });

  it("returns the PR row when present", async () => {
    getActiveRepoNames.mockResolvedValue(["api"]);
    const row = {
      number: 100,
      title: "Fix",
      draft: 1,
      requested_reviewers_json: '[{"login":"alice"}]',
      labels_json: '[]',
    };
    const res = await getPR(makeCtx({ db: makeDb({ firstResult: row }), params: { repo: "api", number: "100" } }));
    const body = await res.json();
    expect(body.pr.draft).toBe(true);
    expect(body.pr.requested_reviewers).toEqual([{ login: "alice" }]);
  });
});

describe("POST/DELETE /api/projects/:id/archive", () => {
  it("403s non-admin changes", async () => {
    const res = await archivePost(makeCtx({ db: makeDb(), params: { id: "p1" }, method: "POST", data: { orgId: 1, orgLogin: "acme", isAdmin: false } }));
    expect(res.status).toBe(403);
  });

  it("400s when orgLogin is missing", async () => {
    const res = await archivePost(makeCtx({ db: makeDb(), params: { id: "p1" }, method: "POST", data: { orgLogin: null } }));
    expect(res.status).toBe(400);
  });

  it("400s when project id is missing", async () => {
    const res = await archivePost(makeCtx({ db: makeDb(), params: {}, method: "POST" }));
    expect(res.status).toBe(400);
  });

  it("404s when no row was updated (unknown project)", async () => {
    const db = makeDb({ projectResult: null, runResult: { meta: { changes: 0 } } });
    const res = await archivePost(makeCtx({ db, params: { id: "ghost" }, method: "POST" }));
    expect(res.status).toBe(404);
  });

  it("POST archives the project (archived=1 with archived_at set)", async () => {
    const db = makeDb();
    const res = await archivePost(makeCtx({ db, params: { id: "p1" }, method: "POST" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, id: "p1", archived: true });
    const { binds } = db._calls.run[0];
    expect(binds[0]).toBe(1);                    // archived value
    expect(typeof binds[1]).toBe("string");      // archived_at ISO
    expect(binds[2]).toBe("p1");
    expect(binds[3]).toBe("acme");
  });

  it("DELETE unarchives (archived=0 with archived_at=null)", async () => {
    const db = makeDb();
    const res = await archiveDelete(makeCtx({ db, params: { id: "p1" }, method: "DELETE" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, id: "p1", archived: false });
    const { binds } = db._calls.run[0];
    expect(binds[0]).toBe(0);
    expect(binds[1]).toBe(null);
  });

  it("DELETE refuses to restore a GitHub-retired repository", async () => {
    const db = makeDb({
      projectResult: {
        repo: "old-api",
        archived: 1,
        archived_at: null,
        retired_at: "2026-07-23T07:00:00Z",
      },
    });
    const res = await archiveDelete(makeCtx({ db, params: { id: "p1" }, method: "DELETE" }));
    expect(res.status).toBe(409);
    expect(db._calls.run).toHaveLength(0);
  });
});
