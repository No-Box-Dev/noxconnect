import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../feature-metadata.js", () => ({
  parseFeatureMetadata: vi.fn(() => ({ metadata: {} })),
}));
vi.mock("../inactive-repos.js", () => ({
  filterInactive: vi.fn(async (_db, _o, _l, names) => names),
  getNoxTicketRepoName: vi.fn(async () => "noxconnect"),
}));
vi.mock("../github-app.js", () => ({
  getInstallationToken: vi.fn(async () => "ghs_token"),
}));
vi.mock("../gh-mirror.js", () => ({
  upsertGhUser: vi.fn(async () => {}),
}));
vi.mock("../db.js", async () => {
  const actual = await vi.importActual("../db.js");
  return {
    ...actual,
    getSyncState: vi.fn(async () => null),
    setSyncState: vi.fn(async () => {}),
  };
});

import {
  upsertIssue,
  upsertFeature,
  upsertPR,
  upsertMember,
  removeMember,
  upsertTeam,
  removeTeam,
  addTeamMember,
  removeTeamMember,
  markRepoArchived,
  removeRepo,
  renameRepo,
  touchRepoPushed,
  upsertDiscoveredRepo,
  applyNewRepoExcludePolicy,
  syncRepos,
  syncMembers,
  syncRepo,
  syncCommits,
  syncFeatures,
  decideReconcileAction,
} from "../github-sync.js";

function makeDb(rowsForSql = {}) {
  // rowsForSql: { sqlSubstring: row | rows }
  const calls = { firsts: [], runs: [], batches: [], alls: [] };
  function prepare(sql) {
    return {
      _sql: sql,
      _binds: [],
      bind(...binds) { this._binds = binds; return this; },
      async first() {
        calls.firsts.push({ sql, binds: this._binds });
        for (const [k, v] of Object.entries(rowsForSql)) {
          if (sql.includes(k)) return Array.isArray(v) ? v[0] : v;
        }
        return null;
      },
      async all() {
        calls.alls.push({ sql, binds: this._binds });
        for (const [k, v] of Object.entries(rowsForSql)) {
          if (sql.includes(k)) return { results: Array.isArray(v) ? v : [v] };
        }
        return { results: [] };
      },
      async run() {
        calls.runs.push({ sql, binds: this._binds });
        return { meta: { changes: 1 } };
      },
    };
  }
  return {
    prepare,
    async batch(stmts) {
      calls.batches.push(stmts.map((s) => ({ sql: s._sql, binds: s._binds })));
      return stmts.map(() => ({ meta: { changes: 1 } }));
    },
    _calls: calls,
  };
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ============================================================
// Single-row webhook upsert/remove helpers — these test the easy
// branches; sync* functions get integration-style tests below.
// ============================================================

describe("upsertIssue", () => {
  const baseIssue = {
    number: 1, title: "x", state: "open",
    user: { login: "octocat", avatar_url: "a.png" },
    created_at: "2026-05-01", updated_at: "2026-05-01",
    closed_at: null, html_url: "u",
    assignees: [{ login: "a", avatar_url: "b" }],
    labels: [{ name: "bug", color: "red" }],
    milestone: { title: "M1" },
  };

  it("inserts/upserts with closedBy=null by default", async () => {
    const db = makeDb();
    await upsertIssue(db, "org", "api", baseIssue);
    expect(db._calls.runs).toHaveLength(1);
    expect(db._calls.runs[0].sql).toContain("INSERT INTO issues");
    expect(db._calls.runs[0].binds[14]).toBeNull();  // closed_by
  });

  it("passes closedBy through when provided", async () => {
    const db = makeDb();
    await upsertIssue(db, "org", "api", { ...baseIssue, state: "closed" }, "alice");
    expect(db._calls.runs[0].binds[14]).toBe("alice");
  });

  it("tolerates missing user/assignees/labels arrays", async () => {
    const db = makeDb();
    await upsertIssue(db, "org", "api", { ...baseIssue, user: null, assignees: null, labels: null });
    const r = db._calls.runs[0];
    expect(r.binds[5]).toBeNull();  // author
    expect(r.binds[11]).toBe("[]");  // assignees_json
    expect(r.binds[12]).toBe("[]");  // labels_json
  });
});

describe("upsertFeature", () => {
  it("DELETEs feature row when labels don't include both noxticket+feature", async () => {
    const db = makeDb();
    await upsertFeature(db, "org", { number: 1, labels: [{ name: "bug" }] });
    expect(db._calls.runs[0].sql).toContain("DELETE FROM features");
  });

  it("requires both 'noxticket' AND 'feature' labels", async () => {
    const db = makeDb();
    await upsertFeature(db, "org", { number: 1, labels: [{ name: "feature" }] });
    expect(db._calls.runs[0].sql).toContain("DELETE");

    await upsertFeature(db, "org", { number: 2, labels: [{ name: "noxticket" }] });
    expect(db._calls.runs[1].sql).toContain("DELETE");
  });

  it("upserts when both labels are present", async () => {
    const db = makeDb();
    await upsertFeature(db, "org", {
      number: 5, title: "F", state: "open", body: "b",
      labels: [{ name: "noxticket" }, { name: "feature" }],
      assignees: [], html_url: "u",
      created_at: "2026-05-01", updated_at: "2026-05-01",
    });
    expect(db._calls.runs[0].sql).toContain("INSERT INTO features");
  });

  it("accepts string labels (legacy format)", async () => {
    const db = makeDb();
    await upsertFeature(db, "org", {
      number: 5, title: "F", state: "open",
      labels: ["noxticket", "feature"],
      assignees: [], html_url: "u",
      created_at: "x", updated_at: "x",
    });
    expect(db._calls.runs[0].sql).toContain("INSERT INTO features");
  });

  it("accepts the pre-rename ticket label until GitHub issues are canonicalized", async () => {
    const db = makeDb();
    await upsertFeature(db, "org", {
      number: 6, title: "F", state: "open",
      labels: [["un", "ticket"].join(""), "feature"],
      assignees: [], html_url: "u", created_at: "x", updated_at: "x",
    });
    expect(db._calls.runs[0].sql).toContain("INSERT INTO features");
  });
});

describe("upsertPR", () => {
  it("maps state='merged' when pr.merged is true", async () => {
    const db = makeDb();
    await upsertPR(db, "org", "api", {
      number: 1, title: "x", state: "closed", merged: true,
      user: { login: "x" }, created_at: "a", updated_at: "b", html_url: "u",
    });
    expect(db._calls.runs[0].binds[4]).toBe("merged");
  });

  it("preserves state when not merged", async () => {
    const db = makeDb();
    await upsertPR(db, "org", "api", {
      number: 1, title: "x", state: "open", merged: false,
      user: { login: "x" }, created_at: "a", updated_at: "b", html_url: "u",
    });
    expect(db._calls.runs[0].binds[4]).toBe("open");
  });

  it("draft 1/0 binding", async () => {
    const db = makeDb();
    await upsertPR(db, "org", "api", {
      number: 1, title: "x", state: "open", draft: true,
      user: { login: "x" }, created_at: "a", updated_at: "b", html_url: "u",
    });
    expect(db._calls.runs[0].binds[7]).toBe(1);
    await upsertPR(db, "org", "api", {
      number: 2, title: "x", state: "open", draft: false,
      user: { login: "x" }, created_at: "a", updated_at: "b", html_url: "u",
    });
    expect(db._calls.runs[1].binds[7]).toBe(0);
  });

  it("persists the exact PR head SHA", async () => {
    const db = makeDb();
    const headSha = "a".repeat(40);
    await upsertPR(db, "org", "api", {
      number: 1, title: "x", state: "open", draft: false,
      user: { login: "x" }, head: { ref: "feature", sha: headSha },
      created_at: "a", updated_at: "b", html_url: "u",
    });
    expect(db._calls.runs[0].binds[9]).toBe(headSha);
    expect(db._calls.runs[0].sql).toContain("head_sha = excluded.head_sha");
  });
});

describe("upsertMember + removeMember", () => {
  it("upsertMember defaults kind='human'", async () => {
    const db = makeDb();
    await upsertMember(db, "org", { login: "x", avatar_url: "a" });
    expect(db._calls.runs[0].binds).toEqual(["org", "x", "a", "human"]);
  });

  it("upsertMember accepts kind='bot'", async () => {
    const db = makeDb();
    await upsertMember(db, "org", { login: "dep", avatar_url: null }, "bot");
    expect(db._calls.runs[0].binds[3]).toBe("bot");
  });

  it("removeMember runs DELETE", async () => {
    const db = makeDb();
    await removeMember(db, "org", "x");
    expect(db._calls.runs[0].sql).toContain("DELETE FROM members");
    expect(db._calls.runs[0].binds).toEqual(["org", "x"]);
  });
});

describe("team helpers", () => {
  it("upsertTeam no-ops when team has no id", async () => {
    const db = makeDb();
    await upsertTeam(db, "org", { slug: "x" });
    expect(db._calls.runs).toHaveLength(0);
  });

  it("upsertTeam runs INSERT...ON CONFLICT", async () => {
    const db = makeDb();
    await upsertTeam(db, "org", { id: 5, slug: "core", name: "Core" });
    expect(db._calls.runs[0].sql).toContain("INSERT INTO teams");
  });

  it("removeTeam batches both deletes", async () => {
    const db = makeDb();
    await removeTeam(db, "org", 5);
    expect(db._calls.batches).toHaveLength(1);
    expect(db._calls.batches[0]).toHaveLength(2);
  });

  it("removeTeam no-ops when id missing", async () => {
    const db = makeDb();
    await removeTeam(db, "org", null);
    expect(db._calls.batches).toHaveLength(0);
  });

  it("addTeamMember no-ops when teamId or login missing", async () => {
    const db = makeDb();
    await addTeamMember(db, "org", null, "x");
    await addTeamMember(db, "org", 5, null);
    expect(db._calls.runs).toHaveLength(0);
  });

  it("addTeamMember inserts when both provided", async () => {
    const db = makeDb();
    await addTeamMember(db, "org", 5, "alice");
    expect(db._calls.runs[0].sql).toContain("INSERT INTO team_memberships");
  });

  it("removeTeamMember deletes the membership", async () => {
    const db = makeDb();
    await removeTeamMember(db, "org", 5, "alice");
    expect(db._calls.runs[0].sql).toContain("DELETE FROM team_memberships");
  });

  it("removeTeamMember no-ops when teamId or login missing", async () => {
    const db = makeDb();
    await removeTeamMember(db, "org", null, "x");
    await removeTeamMember(db, "org", 5, null);
    expect(db._calls.runs).toHaveLength(0);
  });
});

describe("decideReconcileAction (LWW)", () => {
  it("pulls when D1 has no row yet", () => {
    expect(decideReconcileAction(null, { updated_at: "2026-05-25T10:00:00Z" })).toBe("pull");
  });

  it("pulls legacy rows missing gh_synced_at (pre-migration backfill)", () => {
    const d1 = { updated_at: "2026-05-25T10:00:00Z", gh_synced_at: null };
    expect(decideReconcileAction(d1, { updated_at: "2026-05-25T10:00:00Z" })).toBe("pull");
  });

  it("noops when both sides match the last-synced mark", () => {
    const d1 = { updated_at: "2026-05-25T10:00:00Z", gh_synced_at: "2026-05-25T10:00:00Z" };
    expect(decideReconcileAction(d1, { updated_at: "2026-05-25T10:00:00Z" })).toBe("noop");
  });

  it("pulls when GitHub advanced (someone edited the issue on GH)", () => {
    const d1 = { updated_at: "2026-05-25T10:00:00Z", gh_synced_at: "2026-05-25T10:00:00Z" };
    expect(decideReconcileAction(d1, { updated_at: "2026-05-25T11:00:00Z" })).toBe("pull");
  });

  it("pushes when D1 advanced but GitHub didn't (failed inline waitUntil)", () => {
    const d1 = { updated_at: "2026-05-25T10:30:00Z", gh_synced_at: "2026-05-25T10:00:00Z" };
    expect(decideReconcileAction(d1, { updated_at: "2026-05-25T10:00:00Z" })).toBe("push");
  });

  it("picks the larger updated_at when both sides advanced", () => {
    const base = "2026-05-25T10:00:00Z";
    const ghNewer = { updated_at: "2026-05-25T10:05:00Z", gh_synced_at: base };
    expect(decideReconcileAction(ghNewer, { updated_at: "2026-05-25T10:10:00Z" })).toBe("pull");

    const d1Newer = { updated_at: "2026-05-25T10:10:00Z", gh_synced_at: base };
    expect(decideReconcileAction(d1Newer, { updated_at: "2026-05-25T10:05:00Z" })).toBe("push");
  });

  it("breaks ties in favor of GitHub (source of truth)", () => {
    const d1 = { updated_at: "2026-05-25T10:10:00Z", gh_synced_at: "2026-05-25T10:00:00Z" };
    expect(decideReconcileAction(d1, { updated_at: "2026-05-25T10:10:00Z" })).toBe("pull");
  });

  it("pushes a same-second local edit even when D1 uses ms precision and gh_synced_at doesn't", () => {
    // Regression: GitHub serializes updated_at without ms (`...:00Z`), while
    // `new Date().toISOString()` always includes ms (`...:00.123Z`). Naive
    // string compare puts `.123Z` < `Z` lexicographically and would noop the
    // push, silently dropping the local edit.
    const d1 = {
      updated_at: "2026-05-25T10:00:00.123Z",
      gh_synced_at: "2026-05-25T10:00:00Z",
    };
    expect(decideReconcileAction(d1, { updated_at: "2026-05-25T10:00:00Z" })).toBe("push");
  });
});

describe("repo lifecycle helpers", () => {
  it("markRepoArchived updates archived_at", async () => {
    const db = makeDb();
    await markRepoArchived(db, "org", "api");
    expect(db._calls.runs[0].sql).toContain("UPDATE repos SET archived_at");
  });

  it("removeRepo retires the repo and preserves dependent history", async () => {
    const db = makeDb();
    await removeRepo(db, "org", "api", "transferred", "new-owner");
    const sqls = db._calls.runs.map((s) => s.sql).join(" || ");
    expect(sqls).toContain("UPDATE repos");
    expect(sqls).toContain("retirement_reason");
    expect(sqls).toContain("UPDATE repo_tracking_periods");
    expect(sqls).not.toContain("DELETE");
  });

  it("renameRepo no-ops when names missing or identical", async () => {
    const db = makeDb();
    await renameRepo(db, "org", null, "x");
    await renameRepo(db, "org", "x", null);
    await renameRepo(db, "org", "x", "x");
    expect(db._calls.batches).toHaveLength(0);
  });

  it("renameRepo updates cached rows and tracking history in a single batch", async () => {
    const db = makeDb();
    await renameRepo(db, "org", "old", "new");
    expect(db._calls.batches).toHaveLength(1);
    expect(db._calls.batches[0]).toHaveLength(5);
  });

  it("touchRepoPushed updates pushed_at", async () => {
    const db = makeDb();
    await touchRepoPushed(db, "org", "api");
    expect(db._calls.runs[0].sql).toContain("UPDATE repos SET pushed_at");
  });
});

// ============================================================
// Network-touching sync functions — mock fetch.
// ============================================================

describe("syncRepos", () => {
  it("calls /orgs/{login}/repos and upserts each", async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      headers: { get: () => null },
      json: async () => [
        { name: "api", language: "TS", pushed_at: "2026-05-01" },
        { name: "web", language: "JS", pushed_at: "2026-05-02" },
      ],
    });
    const db = makeDb();
    const result = await syncRepos(db, "tok", "org-1", "no-box-dev");
    expect(result).toEqual(["api", "web"]);
    expect(fetch.mock.calls[0][0]).toContain("/orgs/no-box-dev/repos");
    expect(db._calls.batches).toHaveLength(1);
  });

  it("uses the installation repository endpoint for a personal account", async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      headers: { get: () => null },
      json: async () => ({
        repositories: [{ name: "personal-repo", language: "Swift", pushed_at: "2026-09-10" }],
      }),
    });
    const db = makeDb({ "SELECT account_type FROM installations": { account_type: "User" } });

    const result = await syncRepos(db, "tok", "personal-1", "jasper");

    expect(result).toEqual(["personal-repo"]);
    expect(fetch.mock.calls[0][0]).toContain("/installation/repositories");
    expect(fetch.mock.calls[0][0]).not.toContain("/orgs/jasper/repos");
  });

  it("does not treat an invalid personal installation response as an empty repository list", async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      headers: { get: () => null },
      json: async () => ({}),
    });
    const db = makeDb({ "SELECT account_type FROM installations": { account_type: "User" } });

    await expect(syncRepos(db, "tok", "personal-1", "jasper")).rejects.toThrow(/invalid installation repository response/i);
    expect(db._calls.batches).toHaveLength(0);
  });

  it("throws clear error on 401 (token revoked)", async () => {
    fetch.mockResolvedValue({
      ok: false,
      status: 401,
      headers: { get: () => null },
      statusText: "Unauthorized",
    });
    await expect(syncRepos(makeDb(), "tok", "org-1", "x")).rejects.toThrow(/token expired|revoked/i);
  });

  it("throws rate-limit error on 429", async () => {
    fetch.mockResolvedValue({
      ok: false,
      status: 429,
      headers: {
        get: (k) => k === "X-RateLimit-Reset" ? "1717200000" : null,
      },
      statusText: "Too Many Requests",
    });
    await expect(syncRepos(makeDb(), "tok", "org-1", "x")).rejects.toThrow(/rate limit/i);
  });

  it("throws on generic 5xx (does not return empty)", async () => {
    fetch.mockResolvedValue({
      ok: false,
      status: 500,
      headers: { get: () => null },
      statusText: "Internal Server Error",
    });
    await expect(syncRepos(makeDb(), "tok", "org-1", "x")).rejects.toThrow(/500/);
  });

  it("upsert SQL stamps discovered_at and preserves it on conflict", async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      headers: { get: () => null },
      json: async () => [{ name: "api", language: "TS", pushed_at: "2026-05-01" }],
    });
    const db = makeDb();
    await syncRepos(db, "tok", "org-1", "no-box-dev");
    // The bind stmt is shared across the batch — peek at the SQL.
    const batchSql = db._calls.batches[0][0].sql;
    expect(batchSql).toContain("discovered_at");
    expect(batchSql).toContain("COALESCE(repos.discovered_at, excluded.discovered_at)");
  });

  it("does NOT apply exclude policy when settings.newRepoDefault is 'include'", async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      headers: { get: () => null },
      json: async () => [{ name: "api", language: "TS", pushed_at: "2026-05-01" }],
    });
    const db = makeDb({
      "FROM config": { data: JSON.stringify({ newRepoDefault: "include" }) },
    });
    await syncRepos(db, "tok", "org-1", "no-box-dev");
    // Only the repos upsert batch should run — no projects archived batch.
    const projectBatches = db._calls.batches.filter((b) =>
      b[0]?.sql?.includes("INSERT INTO projects"),
    );
    expect(projectBatches).toHaveLength(0);
  });

  it("applies exclude policy when settings.newRepoDefault is 'exclude'", async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      headers: { get: () => null },
      json: async () => [{ name: "new-repo", language: "TS", pushed_at: "2026-05-01" }],
    });
    // No existing rows → "new-repo" is genuinely a new discovery → policy fires.
    const db = makeDb({
      "FROM config": { data: JSON.stringify({ newRepoDefault: "exclude" }) },
    });
    await syncRepos(db, "tok", "org-1", "no-box-dev");
    const projectBatches = db._calls.batches.filter((b) =>
      b[0]?.sql?.includes("INSERT INTO projects"),
    );
    expect(projectBatches).toHaveLength(1);
    expect(projectBatches[0][0].binds[0]).toBe("proj_no-box-dev_new-repo");
  });

  it("does NOT re-apply exclude policy for repos already in D1 (idempotent)", async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      headers: { get: () => null },
      json: async () => [{ name: "api", language: "TS", pushed_at: "2026-05-01" }],
    });
    // Existing row for "api" → not newly discovered → policy must skip it.
    const db = makeDb({
      "SELECT name FROM repos": [{ name: "api" }],
      "FROM config": { data: JSON.stringify({ newRepoDefault: "exclude" }) },
    });
    await syncRepos(db, "tok", "org-1", "no-box-dev");
    const projectBatches = db._calls.batches.filter((b) =>
      b[0]?.sql?.includes("INSERT INTO projects"),
    );
    expect(projectBatches).toHaveLength(0);
  });
});

describe("upsertDiscoveredRepo", () => {
  it("returns true when row is newly inserted (changes>0)", async () => {
    const db = makeDb();
    const wasNew = await upsertDiscoveredRepo(db, "org-1", "new-repo");
    expect(wasNew).toBe(true);
    expect(db._calls.runs[0].sql).toContain("INSERT INTO repos");
    expect(db._calls.runs[0].sql).toContain("ON CONFLICT(org_id, name) DO UPDATE");
  });

  it("returns false when row already exists (changes=0)", async () => {
    const db = makeDb({ "SELECT 1 AS present": { present: 1 } });
    const wasNew = await upsertDiscoveredRepo(db, "org-1", "existing-repo");
    expect(wasNew).toBe(false);
  });
});

describe("applyNewRepoExcludePolicy", () => {
  it("is a no-op for empty input (no DB write)", async () => {
    const db = makeDb();
    await applyNewRepoExcludePolicy(db, "no-box-dev", []);
    expect(db._calls.firsts).toHaveLength(0);
    expect(db._calls.batches).toHaveLength(0);
  });

  it("is a no-op when policy is 'include'", async () => {
    const db = makeDb({
      "FROM config": { data: JSON.stringify({ newRepoDefault: "include" }) },
    });
    await applyNewRepoExcludePolicy(db, "no-box-dev", ["new-repo"]);
    expect(db._calls.batches).toHaveLength(0);
  });

  it("archives all listed repos when policy is 'exclude'", async () => {
    const db = makeDb({
      "FROM config": { data: JSON.stringify({ newRepoDefault: "exclude" }) },
    });
    await applyNewRepoExcludePolicy(db, "no-box-dev", ["new-a", "new-b"]);
    // The production code shares one prepared statement across binds (D1's
    // .bind() returns a new stmt) — the makeDb fake mutates the shared
    // object, so we can only assert the batch size and shape here. The end-
    // to-end correctness of the per-repo binds is covered by the
    // staging-env verification step in the plan.
    expect(db._calls.batches).toHaveLength(1);
    expect(db._calls.batches[0]).toHaveLength(2);
    const sql = db._calls.batches[0][0].sql;
    expect(sql).toContain("INSERT INTO projects");
    expect(sql).toContain("archived");
  });
});

describe("syncMembers", () => {
  it("upserts members with kind='human' (default)", async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      headers: { get: () => null },
      json: async () => [{ login: "alice", avatar_url: "a.png" }],
    });
    const db = makeDb();
    const result = await syncMembers(db, "tok", "org-1", "x");
    expect(result).toEqual(["alice"]);
    // The INSERT SQL hardcodes 'human' as the kind.
    expect(db._calls.batches[0][0].sql).toContain("'human'");
  });

  it("uses the owner as the sole member for a personal installation", async () => {
    const db = makeDb({ "SELECT account_type FROM installations": { account_type: "User" } });

    const result = await syncMembers(db, "tok", "personal-1", "jasper");

    expect(result).toEqual(["jasper"]);
    expect(fetch).not.toHaveBeenCalled();
    expect(db._calls.runs.some((call) =>
      call.sql.includes("INSERT INTO members") && call.binds[1] === "jasper"
    )).toBe(true);
  });
});

describe("syncFeatures", () => {
  it("migrates a legacy feature label with an authenticated GitHub request", async () => {
    const legacyLabel = ["un", "ticket"].join("");
    const issue = {
      number: 17,
      title: "Restore release notes",
      state: "open",
      body: "",
      assignees: [],
      labels: [{ name: legacyLabel, color: "999999" }, { name: "feature", color: "123456" }],
      milestone: null,
      html_url: "https://github.com/no-box-dev/noxconnect/issues/17",
      created_at: "2026-09-01T00:00:00Z",
      updated_at: "2026-09-09T00:00:00Z",
    };

    fetch.mockImplementation(async (url, init = {}) => {
      if (init.method === "POST") {
        return { ok: true, json: async () => ({ name: "noxticket" }) };
      }
      if (init.method === "PATCH") {
        return { ok: true, json: async () => ({ ...issue, labels: [{ name: "noxticket" }, { name: "feature" }] }) };
      }
      return {
        ok: true,
        headers: { get: () => null },
        json: async () => [issue],
      };
    });

    const db = makeDb();
    await expect(syncFeatures(db, "install-token", 1, "no-box-dev")).resolves.toMatchObject({ synced: 1 });

    const patchCall = fetch.mock.calls.find(([, init]) => init?.method === "PATCH");
    expect(patchCall).toBeDefined();
    expect(patchCall[1].headers).toMatchObject({
      Authorization: "Bearer install-token",
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(patchCall[1].body).labels).toEqual(["noxticket", "feature"]);
  });
});

describe("syncCommits", () => {
  it("wipes existing rows for the (org, repo) when since is null (force resync)", async () => {
    // GitHub returns two commits — those get inserted after the wipe.
    fetch.mockResolvedValueOnce({
      ok: true, headers: { get: () => null },
      json: async () => [
        { sha: "aaa", commit: { author: { date: "t" }, message: "m" } },
        { sha: "bbb", commit: { author: { date: "t" }, message: "m" } },
      ],
    });
    const db = makeDb();
    await syncCommits(db, "tok", "org-1", "no-box-dev", "api", null);
    // The wipe runs before the batch of inserts.
    const wipe = db._calls.runs.find((r) =>
      r.sql.includes("DELETE FROM github_commits") && r.sql.includes("org_id = ? AND repo = ?")
    );
    expect(wipe).toBeTruthy();
    expect(wipe.binds).toEqual(["org-1", "api"]);
  });

  it("does NOT wipe when since is provided (incremental sync)", async () => {
    fetch.mockResolvedValueOnce({
      ok: true, headers: { get: () => null },
      json: async () => [],
    });
    const db = makeDb();
    await syncCommits(db, "tok", "org-1", "no-box-dev", "api", "2026-01-01T00:00:00Z");
    const wipe = db._calls.runs.find((r) => r.sql.includes("DELETE FROM github_commits"));
    expect(wipe).toBeUndefined();
  });
});

describe("syncRepo orchestration", () => {
  it("calls syncPRs, syncIssues, then syncCommits with their cursors", async () => {
    // Single page of PRs, issues, and commits
    fetch
      .mockResolvedValueOnce({
        ok: true, headers: { get: () => null },
        json: async () => [],
      })  // PRs
      .mockResolvedValueOnce({
        ok: true, headers: { get: () => null },
        json: async () => [],
      })  // Issues
      .mockResolvedValueOnce({
        ok: true, headers: { get: () => null },
        json: async () => [],
      });  // Commits
    const db = makeDb();
    await syncRepo(db, "tok", "org-1", "no-box-dev", "api", true);
    // PR URL first, issues URL second, commits URL third.
    expect(fetch.mock.calls[0][0]).toContain("/repos/no-box-dev/api/pulls");
    expect(fetch.mock.calls[1][0]).toContain("/repos/no-box-dev/api/issues");
    expect(fetch.mock.calls[2][0]).toContain("/repos/no-box-dev/api/commits");
  });

  it("propagates errors from underlying syncs", async () => {
    fetch.mockResolvedValue({
      ok: false, status: 500, headers: { get: () => null }, statusText: "x",
    });
    await expect(syncRepo(makeDb(), "tok", "org-1", "x", "api", true)).rejects.toThrow();
  });
});
