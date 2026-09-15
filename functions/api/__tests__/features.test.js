import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../lib/github-app.js", () => ({
  getInstallationIdForOrg: vi.fn(async () => 12345),
  getInstallationToken: vi.fn(async () => "install-tok"),
}));
vi.mock("../../lib/op-failures.js", () => ({
  recordFailure: vi.fn(async () => {}),
}));

import { onRequestGet, onRequestPost } from "../features";
import { onRequestPatch, onRequestDelete } from "../features/[number]";
import { getInstallationIdForOrg } from "../../lib/github-app.js";
import { recordFailure } from "../../lib/op-failures.js";
import { __resetLabelCacheForTests } from "../../lib/feature-issues.js";

// Existing-labels response that matches the default board stages with their
// canonical colors — when ensureNoxTicketRepoLabels sees these, no POST/PATCH
// fires and the next mocked fetch is the actual create/patch call.
const LABELS_OK_RESPONSE = {
  ok: true,
  json: async () => [
    { name: "noxticket", color: "1B6971" },
    { name: "feature", color: "1B6971" },
    { name: "backlog", color: "94A3B8" },
    { name: "status:todo", color: "94a3b8" },
    { name: "status:specced", color: "8b83b8" },
    { name: "status:staging", color: "b89464" },
    { name: "status:ready", color: "6a9991" },
    { name: "status:production", color: "6e9970" },
  ],
};

// Per-query first() lookup: matches on a substring of the SQL so a single
// test can return different rows for the orgs lookup vs the features row.
// Pass `firstByQuery: { "FROM features": {...}, "FROM orgs": {...} }` etc.
function makeDb({
  batchResults = [],
  firstResult = null,
  firstByQuery = null,
  allResult = { results: [] },
  runResult = { meta: { changes: 1 } },
} = {}) {
  const calls = { batch: [], run: [], prepared: [], first: [], all: [] };
  function prepare(sql) {
    calls.prepared.push(sql);
    return {
      _sql: sql,
      _binds: [],
      bind(...binds) { this._binds = binds; return this; },
      async run() { calls.run.push({ sql, binds: this._binds }); return runResult; },
      async first() {
        calls.first.push({ sql, binds: this._binds });
        if (firstByQuery) {
          for (const [needle, value] of Object.entries(firstByQuery)) {
            if (sql.includes(needle)) return value;
          }
          return null;
        }
        return firstResult;
      },
      async all() { calls.all.push({ sql, binds: this._binds }); return allResult; },
    };
  }
  return {
    prepare,
    async batch(stmts) {
      calls.batch.push(stmts.map((s) => ({ sql: s._sql, binds: s._binds })));
      return batchResults;
    },
    _calls: calls,
  };
}

function makeCtx({
  db,
  url = "http://x/api/features",
  method = "GET",
  body,
  params,
  orgId = 1,
  orgLogin = "acme",
  waitUntil = vi.fn((p) => p),
}) {
  const req = body !== undefined
    ? new Request(url, { method, headers: { "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) })
    : new Request(url, { method });
  return {
    request: req,
    env: { DB: db },
    data: { orgId, orgLogin, projectId: "project-1" },
    params: params ?? {},
    waitUntil,
  };
}

beforeEach(() => {
  global.fetch = vi.fn();
  vi.mocked(getInstallationIdForOrg).mockResolvedValue(12345);
  vi.mocked(recordFailure).mockClear();
  __resetLabelCacheForTests();
});
afterEach(() => vi.restoreAllMocks());

describe("GET /api/features", () => {
  it("returns features parsed from D1 rows", async () => {
    const db = makeDb({
      allResult: { results: [
        { number: 42, title: "Login", state: "open", body: "Plan", assignees_json: '[]', labels_json: '[]' },
        { number: 43, title: "Signup", state: "open", body: "Plan", assignees_json: '[]', labels_json: '[]' },
      ] },
    });
    const res = await onRequestGet(makeCtx({ db }));
    const data = await res.json();
    expect(data).toHaveLength(2);
    expect(data[0].number).toBe(42);
    expect(data[1].number).toBe(43);
  });

  it("filters by state from query param (default 'open')", async () => {
    const db = makeDb({ allResult: { results: [] } });
    await onRequestGet(makeCtx({ db, url: "http://x/api/features?state=closed" }));
    expect(db._calls.all[0].binds).toEqual([1, "project-1", "closed"]);
  });
});

describe("POST /api/features", () => {
  it("400s on bad JSON", async () => {
    const res = await onRequestPost(makeCtx({ db: makeDb(), method: "POST", body: "{ broken" }));
    expect(res.status).toBe(400);
  });

  it("422s on empty title", async () => {
    const res = await onRequestPost(makeCtx({ db: makeDb(), method: "POST", body: { title: "" } }));
    expect(res.status).toBe(422);
  });

  it("422s on invalid status", async () => {
    const res = await onRequestPost(makeCtx({ db: makeDb(), method: "POST", body: { title: "X", status: "bogus" } }));
    expect(res.status).toBe(422);
  });

  it("412s when the GitHub App is not installed for the org", async () => {
    vi.mocked(getInstallationIdForOrg).mockResolvedValueOnce(null);
    const res = await onRequestPost(makeCtx({
      db: makeDb(), method: "POST",
      body: { title: "Login", status: "todo" },
    }));
    expect(res.status).toBe(412);
  });

  it("creates issue with the install token, mirrors to D1, returns Feature", async () => {
    global.fetch
      .mockResolvedValueOnce(LABELS_OK_RESPONSE)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          number: 7, title: "Login", state: "open",
          body: "plan\n\n<!-- noxticket:metadata\n{}\n-->",
          assignees: [], labels: [{ name: "noxticket", color: "1B6971" }, { name: "feature", color: "1B6971" }],
          html_url: "https://github.com/acme/noxconnect/issues/7",
          created_at: "t", updated_at: "t",
        }),
      });
    const db = makeDb({ allResult: { results: [] } });
    const res = await onRequestPost(makeCtx({
      db, method: "POST",
      body: { title: "Login", status: "todo", owners: ["alice"] },
    }));
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.id).toBe(7);
    expect(data.title).toBe("Login");
    expect(data.status).toBe("todo");
    // GitHub was called with the install token, not a user token.
    const createCall = global.fetch.mock.calls[1];
    expect(createCall[1].headers.Authorization).toBe("Bearer install-tok");
    expect(db._calls.run).toHaveLength(1);  // upsert ran
  });

  it("400s when org context is missing", async () => {
    const res = await onRequestPost({
      request: new Request("http://x", { method: "POST", body: "{}" }),
      env: { DB: makeDb() },
      data: { orgId: 1 },  // no orgLogin
      waitUntil: vi.fn(),
    });
    expect(res.status).toBe(400);
  });

  it("attaches the backlog label when body has backlog:true", async () => {
    global.fetch
      .mockResolvedValueOnce(LABELS_OK_RESPONSE)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          number: 8, title: "Later", state: "open",
          body: "",
          assignees: [],
          labels: [{ name: "noxticket" }, { name: "feature" }, { name: "backlog" }],
          html_url: "u", created_at: "t", updated_at: "t",
        }),
      });
    const db = makeDb({ allResult: { results: [] } });
    const res = await onRequestPost(makeCtx({
      db, method: "POST",
      body: { title: "Later", status: "todo", backlog: true },
    }));
    expect(res.status).toBe(201);

    // GitHub create was called with a labels array that includes "backlog".
    const createCall = global.fetch.mock.calls[1];
    const sentBody = JSON.parse(createCall[1].body);
    expect(sentBody.labels).toContain("backlog");
  });
});

describe("PATCH /api/features/:number", () => {
  it("400s on bad number", async () => {
    const res = await onRequestPatch(makeCtx({ db: makeDb(), method: "PATCH", body: {}, params: { number: "abc" } }));
    expect(res.status).toBe(400);
  });

  it("404s when feature row is missing", async () => {
    const res = await onRequestPatch(makeCtx({
      db: makeDb({ firstResult: null }),
      method: "PATCH", body: {}, params: { number: "5" },
    }));
    expect(res.status).toBe(404);
  });

  it("422s on invalid status", async () => {
    const res = await onRequestPatch(makeCtx({
      db: makeDb({
        firstResult: {
          number: 5, title: "X", state: "open", body: "",
          assignees_json: "[]", labels_json: "[]", html_url: "u",
        },
      }),
      method: "PATCH", body: { status: "bogus" }, params: { number: "5" },
    }));
    expect(res.status).toBe(422);
  });

  it("412s when the GitHub App is not installed for the org", async () => {
    vi.mocked(getInstallationIdForOrg).mockResolvedValueOnce(null);
    const db = makeDb({
      firstResult: {
        number: 5, title: "X", state: "open", body: "",
        assignees_json: "[]", labels_json: "[]", html_url: "u",
      },
    });
    const res = await onRequestPatch(makeCtx({
      db, method: "PATCH",
      body: { status: "staging" }, params: { number: "5" },
    }));
    expect(res.status).toBe(412);
  });

  it("returns immediately from D1 and fires GitHub PATCH via waitUntil", async () => {
    const initialBody = `do it\n\n<!-- noxticket:metadata\n${JSON.stringify({
      statusHistory: [{ status: "todo", timestamp: "t1" }],
    })}\n-->`;
    global.fetch
      .mockResolvedValueOnce(LABELS_OK_RESPONSE)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          number: 5, title: "X", state: "open",
          body: "ignored", assignees: [],
          labels: [{ name: "noxticket", color: "1B6971" }, { name: "feature", color: "1B6971" },
                   { name: "status:staging", color: "B89464" }],
          html_url: "u", created_at: "t", updated_at: "t",
        }),
      });
    const db = makeDb({
      firstResult: {
        number: 5, title: "X", state: "open", body: initialBody,
        assignees_json: "[]", labels_json: JSON.stringify([{ name: "noxticket" }, { name: "feature" }]),
        html_url: "u",
      },
      allResult: { results: [] },
    });
    const waitUntil = vi.fn((p) => p);
    const res = await onRequestPatch(makeCtx({
      db, method: "PATCH",
      body: { status: "staging" }, params: { number: "5" },
      waitUntil,
    }));
    expect(res.status).toBe(200);
    const data = await res.json();
    // Response carries the optimistic state (status flipped to staging) even
    // before the GitHub PATCH finishes.
    expect(data.status).toBe("staging");
    // D1 was updated optimistically — at least the upsert ran.
    expect(db._calls.run.length).toBeGreaterThanOrEqual(1);
    // GitHub PATCH was queued for waitUntil — drive it.
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await waitUntil.mock.calls[0][0];
    // 2 fetches: GET labels (cache miss) + PATCH issue.
    expect(global.fetch).toHaveBeenCalledTimes(2);
    const ghCall = global.fetch.mock.calls[1];
    expect(ghCall[1].headers.Authorization).toBe("Bearer install-tok");
    const ghBody = JSON.parse(ghCall[1].body);
    expect(ghBody.labels).toEqual(["noxticket", "feature", "status:staging"]);
    const meta = JSON.parse(ghBody.body.match(/<!-- noxticket:metadata\n([\s\S]+)\n-->/)[1]);
    expect(meta.statusHistory).toHaveLength(2);
    expect(meta.statusHistory[1].status).toBe("staging");
  });

  it("records op_failure when the GitHub PATCH eventually fails", async () => {
    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      json: async () => ({ message: "no perms" }),
    });
    const db = makeDb({
      firstResult: {
        number: 5, title: "X", state: "open", body: "",
        assignees_json: "[]", labels_json: "[]", html_url: "u",
      },
      allResult: { results: [] },
    });
    const waitUntil = vi.fn((p) => p);
    const res = await onRequestPatch(makeCtx({
      db, method: "PATCH",
      body: { status: "staging" }, params: { number: "5" },
      waitUntil,
    }));
    expect(res.status).toBe(200);
    await waitUntil.mock.calls[0][0];
    expect(recordFailure).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ op: "patchFeatureIssue", deliveryId: "feature-5" }),
    );
  });

  it("sends only the changed fields — a title-only PATCH omits body/labels/assignees", async () => {
    // Regression guard for the lost-update race: two concurrent PATCHes
    // that both blindly echoed title+body+labels+assignees would overwrite
    // each other's untouched fields. This asserts a title-only PATCH ships
    // ONLY the title, so a concurrent status PATCH can land labels/body
    // without collision.
    const initialBody = `do it\n\n<!-- noxticket:metadata\n${JSON.stringify({
      statusHistory: [{ status: "todo", timestamp: "t1" }],
    })}\n-->`;
    global.fetch
      .mockResolvedValueOnce(LABELS_OK_RESPONSE)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          number: 5, title: "New title", state: "open",
          body: "ignored", assignees: [], labels: [],
          html_url: "u", created_at: "t", updated_at: "t",
        }),
      });
    const db = makeDb({
      firstResult: {
        number: 5, title: "X", state: "open", body: initialBody,
        assignees_json: "[]", labels_json: JSON.stringify([{ name: "noxticket" }, { name: "feature" }]),
        html_url: "u",
      },
      allResult: { results: [] },
    });
    const waitUntil = vi.fn((p) => p);
    await onRequestPatch(makeCtx({
      db, method: "PATCH",
      body: { title: "New title" }, params: { number: "5" },
      waitUntil,
    }));
    await waitUntil.mock.calls[0][0];
    const ghCall = global.fetch.mock.calls[1];
    const ghBody = JSON.parse(ghCall[1].body);
    expect(ghBody.title).toBe("New title");
    expect(ghBody.body).toBeUndefined();
    expect(ghBody.labels).toBeUndefined();
    expect(ghBody.assignees).toBeUndefined();
  });

  it("rejects invalid owner usernames", async () => {
    const db = makeDb({
      firstResult: {
        number: 5, title: "X", state: "open", body: "",
        assignees_json: "[]", labels_json: "[]", html_url: "u",
      },
      allResult: { results: [] },
    });
    global.fetch
      .mockResolvedValueOnce(LABELS_OK_RESPONSE)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          number: 5, title: "X", state: "open", body: "",
          assignees: [], labels: [], html_url: "u", created_at: "t", updated_at: "t",
        }),
      });
    const waitUntil = vi.fn((p) => p);
    await onRequestPatch(makeCtx({
      db, method: "PATCH",
      body: { owners: ["alice", "bad name", "../etc"] },
      params: { number: "5" },
      waitUntil,
    }));
    await waitUntil.mock.calls[0][0];
    const ghCall = global.fetch.mock.calls[1];
    const ghBody = JSON.parse(ghCall[1].body);
    expect(ghBody.assignees).toEqual(["alice"]);  // invalid usernames stripped
  });
});

describe("DELETE /api/features/:number", () => {
  it("400s on bad number", async () => {
    const res = await onRequestDelete(makeCtx({ db: makeDb(), method: "DELETE", params: { number: "abc" } }));
    expect(res.status).toBe(400);
  });

  it("404s when feature row is missing", async () => {
    const res = await onRequestDelete(makeCtx({
      db: makeDb({ firstResult: null }),
      method: "DELETE", params: { number: "5" },
    }));
    expect(res.status).toBe(404);
  });

  it("412s when the GitHub App is not installed for the org", async () => {
    vi.mocked(getInstallationIdForOrg).mockResolvedValueOnce(null);
    const db = makeDb({
      firstResult: {
        number: 5, title: "X", state: "open", body: "",
        assignees_json: "[]", labels_json: "[]", html_url: "u",
      },
    });
    const res = await onRequestDelete(makeCtx({ db, method: "DELETE", params: { number: "5" } }));
    expect(res.status).toBe(412);
  });

  it("closes D1 row first, fires GitHub close via waitUntil, keeps user labels", async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        number: 5, title: "X", state: "closed", body: "",
        assignees: [], labels: [{ name: "bug" }],
        html_url: "u", created_at: "t", updated_at: "t",
      }),
    });
    const db = makeDb({
      firstResult: {
        number: 5, title: "X", state: "open", body: "",
        assignees_json: "[]",
        labels_json: JSON.stringify([
          { name: "noxticket" }, { name: "feature" },
          { name: "status:ready" }, { name: "bug" },
        ]),
        html_url: "u",
      },
    });
    const waitUntil = vi.fn((p) => p);
    const res = await onRequestDelete(makeCtx({ db, method: "DELETE", params: { number: "5" }, waitUntil }));
    expect(res.status).toBe(200);
    // D1 close + spec detach run in one batch, before the GitHub PATCH is
    // awaited. First statement closes the feature, second detaches specs
    // that pointed at it (so they don't become orphans pointing at a
    // closed issue).
    expect(db._calls.batch).toHaveLength(1);
    const [closeStmt, detachStmt] = db._calls.batch[0];
    expect(closeStmt.sql).toContain("UPDATE features");
    expect(closeStmt.binds[0]).toContain("bug");
    expect(closeStmt.binds[0]).not.toContain("noxconnect");
    expect(closeStmt.binds[0]).not.toContain("status:");
    expect(detachStmt.sql).toContain("UPDATE specs");
    expect(detachStmt.sql).toContain("feature_number = NULL");
    expect(detachStmt.binds).toEqual([1, "project-1", 5]);
    // Drive the GitHub call.
    await waitUntil.mock.calls[0][0];
    const ghCall = global.fetch.mock.calls[0];
    expect(ghCall[1].headers.Authorization).toBe("Bearer install-tok");
    const ghBody = JSON.parse(ghCall[1].body);
    expect(ghBody.state).toBe("closed");
    expect(ghBody.labels).toEqual(["bug"]);
  });

  it("records op_failure when the GitHub close eventually fails", async () => {
    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: "Not Found",
      json: async () => ({ message: "gone" }),
    });
    const db = makeDb({
      firstResult: {
        number: 5, title: "X", state: "open", body: "",
        assignees_json: "[]",
        labels_json: JSON.stringify([{ name: "noxticket" }, { name: "feature" }]),
        html_url: "u",
      },
    });
    const waitUntil = vi.fn((p) => p);
    const res = await onRequestDelete(makeCtx({ db, method: "DELETE", params: { number: "5" }, waitUntil }));
    expect(res.status).toBe(200);
    await waitUntil.mock.calls[0][0];
    expect(recordFailure).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ op: "deleteFeatureIssue", deliveryId: "feature-5" }),
    );
  });
});
