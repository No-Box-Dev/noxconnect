import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock everything the handler delegates to so we can assert on calls without
// touching real GitHub / D1.
// All handler delegates return resolved promises so the webhook's
// `waitUntil(p.catch(...))` calls don't blow up on `.catch of undefined`.
vi.mock("../../lib/github-sync.js", () => ({
  upsertIssue: vi.fn(() => Promise.resolve()),
  upsertFeature: vi.fn(() => Promise.resolve()),
  upsertPR: vi.fn(() => Promise.resolve()),
  upsertMember: vi.fn(() => Promise.resolve()),
  removeMember: vi.fn(() => Promise.resolve()),
  upsertTeam: vi.fn(() => Promise.resolve()),
  removeTeam: vi.fn(() => Promise.resolve()),
  addTeamMember: vi.fn(() => Promise.resolve()),
  removeTeamMember: vi.fn(() => Promise.resolve()),
  bootstrapInstallation: vi.fn(() => Promise.resolve()),
  markRepoArchived: vi.fn(() => Promise.resolve()),
  removeRepo: vi.fn(() => Promise.resolve()),
  renameRepo: vi.fn(() => Promise.resolve()),
  touchRepoPushed: vi.fn(() => Promise.resolve()),
  syncRepo: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../lib/events.js", () => ({
  // Default: return a benign merged-PR event so the merge-task enqueue branch
  // runs on every pass-through test. Individual tests can override with
  // .mockResolvedValueOnce for the pr:opened branch.
  storeEvent: vi.fn(async () => ({ id: 1, type: "github:pr:merged" })),
}));
vi.mock("../../lib/gh-mirror.js", () => ({
  upsertInstallation: vi.fn(),
  setInstallationRepos: vi.fn(),
  getInstallationRepos: vi.fn(async () => []),
}));
vi.mock("../../lib/github-app.js", () => ({
  getInstallationToken: vi.fn(async () => "inst-tok"),
}));
vi.mock("../../lib/repo-tracking.js", () => ({
  startRepoTracking: vi.fn(async () => {}),
}));
vi.mock("../../lib/narrator.js", () => ({
  narrateEvent: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../lib/noxticket-slack.js", () => ({
  stageNoxTicketActivity: vi.fn(async () => ({ queued: true })),
}));
vi.mock("../../lib/noxspot-resolution.js", () => ({
  resolveNoxSpotReportFromIssue: vi.fn(async () => ({ status: "resolved" })),
  reopenNoxSpotReportFromIssue: vi.fn(async () => ({ status: "open" })),
}));

import { onRequestPost } from "../webhook.js";
import { upsertIssue, upsertPR, upsertMember, removeMember, touchRepoPushed } from "../../lib/github-sync.js";
import { storeEvent } from "../../lib/events.js";
import { stageNoxTicketActivity } from "../../lib/noxticket-slack.js";
import { reopenNoxSpotReportFromIssue, resolveNoxSpotReportFromIssue } from "../../lib/noxspot-resolution.js";

const SECRET = "shh";

// Compute the real HMAC-SHA256 signature so verifySignature accepts the request.
async function sign(body) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  const hex = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `sha256=${hex}`;
}

function makeDb({ firstByFragment = {} } = {}) {
  const calls = { run: [], batch: [], first: [] };
  return {
    prepare(sql) {
      return {
        _sql: sql,
        _binds: [],
        bind(...binds) { this._binds = binds; return this; },
        async first() {
          calls.first.push({ sql, binds: this._binds });
          for (const [frag, result] of Object.entries(firstByFragment)) {
            if (sql.includes(frag)) return result;
          }
          return null;
        },
        async run() { calls.run.push({ sql, binds: this._binds }); return { meta: { changes: 0 } }; },
      };
    },
    async batch(stmts) { calls.batch.push(stmts.map((s) => ({ sql: s._sql, binds: s._binds }))); return stmts.map(() => ({ meta: { changes: 0 } })); },
    _calls: calls,
  };
}

async function makeRequest({ event, payload }) {
  const body = JSON.stringify(payload);
  const signature = await sign(body);
  return new Request("http://x/api/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Hub-Signature-256": signature,
      "X-GitHub-Event": event,
      "X-GitHub-Delivery": "delivery-1",
    },
    body,
  });
}

function makeCtx({ db, request, env = {}, waitUntil = vi.fn() }) {
  return {
    request,
    env: { DB: db, GITHUB_WEBHOOK_SECRET: SECRET, TASK_QUEUE: { send: vi.fn() }, ...env },
    waitUntil,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => vi.restoreAllMocks());

describe("POST /api/webhook — auth + envelope", () => {
  it("500s when GITHUB_WEBHOOK_SECRET is not configured", async () => {
    const req = new Request("http://x/api/webhook", { method: "POST", body: "{}" });
    const res = await onRequestPost(makeCtx({ db: makeDb(), request: req, env: { GITHUB_WEBHOOK_SECRET: undefined } }));
    expect(res.status).toBe(500);
  });

  it("401s on missing signature", async () => {
    const req = new Request("http://x/api/webhook", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "X-GitHub-Event": "ping" },
    });
    const res = await onRequestPost(makeCtx({ db: makeDb(), request: req }));
    expect(res.status).toBe(401);
  });

  it("401s on bad signature", async () => {
    const req = new Request("http://x/api/webhook", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "X-GitHub-Event": "ping", "X-Hub-Signature-256": "sha256=deadbeef" },
    });
    const res = await onRequestPost(makeCtx({ db: makeDb(), request: req }));
    expect(res.status).toBe(401);
  });

  it("400s on invalid JSON payload", async () => {
    const sigFor = await sign("not json");
    const req = new Request("http://x/api/webhook", {
      method: "POST",
      body: "not json",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": sigFor,
        "X-GitHub-Event": "ping",
      },
    });
    const res = await onRequestPost(makeCtx({ db: makeDb(), request: req }));
    expect(res.status).toBe(400);
  });

  it("responds 'pong' to ping event", async () => {
    const req = await makeRequest({ event: "ping", payload: { zen: "hi" } });
    const res = await onRequestPost(makeCtx({ db: makeDb(), request: req }));
    expect(await res.json()).toEqual({ ok: true, message: "pong" });
  });
});

describe("POST /api/webhook — event routing", () => {
  it("skips when org is not in the payload", async () => {
    const req = await makeRequest({ event: "issues", payload: { action: "opened", issue: {} } });
    const res = await onRequestPost(makeCtx({ db: makeDb(), request: req }));
    const body = await res.json();
    expect(body.skipped).toBe("no organization in payload");
  });

  it("skips when org is not tracked", async () => {
    const req = await makeRequest({ event: "issues", payload: { action: "opened", organization: { login: "ghost" }, issue: {} } });
    const res = await onRequestPost(makeCtx({ db: makeDb({ firstByFragment: { "SELECT id FROM orgs": null } }), request: req }));
    const body = await res.json();
    expect(body.skipped).toBe("org not tracked");
  });

  it("routes issues.opened to upsertIssue and upsertMember", async () => {
    const db = makeDb({ firstByFragment: { "SELECT id FROM orgs": { id: 7 } } });
    const req = await makeRequest({
      event: "issues",
      payload: {
        action: "opened",
        organization: { login: "acme" },
        repository: { name: "api" },
        issue: { number: 1, user: { login: "alice", type: "User" } },
        sender: { login: "alice" },
      },
    });
    const res = await onRequestPost(makeCtx({ db, request: req }));
    expect(res.status).toBe(200);
    expect(upsertIssue).toHaveBeenCalledWith(expect.any(Object), 7, "api", expect.any(Object), null);
    expect(upsertMember).toHaveBeenCalled();
  });

  it("issues.closed passes sender.login as closed_by", async () => {
    const db = makeDb({ firstByFragment: { "SELECT id FROM orgs": { id: 7 } } });
    const req = await makeRequest({
      event: "issues",
      payload: {
        action: "closed",
        organization: { login: "acme" },
        repository: { name: "api" },
        issue: { number: 1, user: { login: "alice", type: "User" } },
        sender: { login: "bob" },
      },
    });
    await onRequestPost(makeCtx({ db, request: req }));
    expect(upsertIssue).toHaveBeenCalledWith(expect.any(Object), 7, "api", expect.any(Object), "bob");
    expect(stageNoxTicketActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      orgId: 7, ownerId: "acme", repo: "api", action: "closed", actor: "bob",
    }));
    expect(resolveNoxSpotReportFromIssue).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      orgId: 7, ownerId: "acme", repo: "api", issueNumber: 1, actor: "bob",
    }));
  });

  it("issues.reopened restores the linked NoxSpot report", async () => {
    const db = makeDb({ firstByFragment: { "SELECT id FROM orgs": { id: 7 } } });
    const req = await makeRequest({
      event: "issues",
      payload: {
        action: "reopened",
        organization: { login: "acme" },
        repository: { name: "api" },
        issue: { number: 1, user: { login: "alice", type: "User" } },
        sender: { login: "bob" },
      },
    });
    expect((await onRequestPost(makeCtx({ db, request: req }))).status).toBe(200);
    expect(reopenNoxSpotReportFromIssue).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      orgId: 7, ownerId: "acme", repo: "api", issueNumber: 1, actor: "bob",
    }));
  });

  it("issues.deleted on noxconnect repo also drops the features row", async () => {
    const db = makeDb({ firstByFragment: { "SELECT id FROM orgs": { id: 7 } } });
    const req = await makeRequest({
      event: "issues",
      payload: {
        action: "deleted",
        organization: { login: "acme" },
        repository: { name: "noxconnect" },
        issue: { number: 42 },
      },
    });
    const res = await onRequestPost(makeCtx({ db, request: req }));
    expect(res.status).toBe(200);
    const sqls = db._calls.run.map((c) => c.sql);
    expect(sqls.some((s) => s.includes("DELETE FROM issues"))).toBe(true);
    expect(sqls.some((s) => s.includes("DELETE FROM features"))).toBe(true);
  });

  it("routes pull_request.opened to upsertPR + upsertMember", async () => {
    const db = makeDb({ firstByFragment: { "SELECT id FROM orgs": { id: 7 } } });
    const req = await makeRequest({
      event: "pull_request",
      payload: {
        action: "opened",
        organization: { login: "acme" },
        repository: { name: "api" },
        pull_request: { number: 100, user: { login: "alice", type: "User" }, head: { ref: "branch" }, body: "" },
      },
    });
    const res = await onRequestPost(makeCtx({ db, request: req }));
    expect(res.status).toBe(200);
    expect(upsertPR).toHaveBeenCalled();
    expect(upsertMember).toHaveBeenCalled();
  });

  it("pull_request.opened enqueues NARRATE_PR_OPENED (not merge tasks)", async () => {
    // Load-bearing: the PRs feed depends on the webhook routing pr:opened
    // events to a different narrator than pr:merged. If this test fails, PRs
    // will silently show up in Posts/Release-notes with the wrong voice or
    // not at all in the PRs feed.
    vi.mocked(storeEvent).mockResolvedValueOnce({ id: 55, type: "github:pr:opened" });
    const db = makeDb({ firstByFragment: { "SELECT id FROM orgs": { id: 7 } } });
    const send = vi.fn();
    const req = await makeRequest({
      event: "pull_request",
      payload: {
        action: "opened",
        organization: { login: "acme" },
        repository: { name: "api" },
        pull_request: { number: 100, user: { login: "alice", type: "User" }, head: { ref: "branch" }, body: "" },
      },
    });
    await onRequestPost(makeCtx({ db, request: req, env: { TASK_QUEUE: { send } } }));
    const enqueuedTypes = send.mock.calls.map((c) => c[0]?.type);
    expect(enqueuedTypes).toContain("narrate_pr_opened");
    expect(enqueuedTypes).not.toContain("narrate");
    expect(enqueuedTypes).not.toContain("release_notes");
  });

  it("pull_request.closed(merged=true) enqueues NARRATE + RELEASE_NOTES (not pr-opened)", async () => {
    vi.mocked(storeEvent).mockResolvedValueOnce({ id: 56, type: "github:pr:merged" });
    const db = makeDb({ firstByFragment: { "SELECT id FROM orgs": { id: 7 } } });
    const send = vi.fn();
    const req = await makeRequest({
      event: "pull_request",
      payload: {
        action: "closed",
        organization: { login: "acme" },
        repository: { name: "api" },
        pull_request: { number: 100, merged: true, user: { login: "alice", type: "User" }, head: { ref: "branch" }, body: "" },
      },
    });
    await onRequestPost(makeCtx({ db, request: req, env: { TASK_QUEUE: { send } } }));
    const enqueuedTypes = send.mock.calls.map((c) => c[0]?.type);
    expect(enqueuedTypes).toContain("narrate");
    expect(enqueuedTypes).toContain("release_notes");
    expect(enqueuedTypes).not.toContain("narrate_pr_opened");
  });

  it("routes member.removed to removeMember", async () => {
    const db = makeDb({ firstByFragment: { "SELECT id FROM orgs": { id: 7 } } });
    const req = await makeRequest({
      event: "member",
      payload: { action: "removed", organization: { login: "acme" }, member: { login: "alice" } },
    });
    await onRequestPost(makeCtx({ db, request: req }));
    expect(removeMember).toHaveBeenCalledWith(expect.any(Object), 7, "alice");
  });

  it("routes push to touchRepoPushed", async () => {
    const db = makeDb({ firstByFragment: { "SELECT id FROM orgs": { id: 7 } } });
    const req = await makeRequest({
      event: "push",
      payload: { organization: { login: "acme" }, repository: { name: "api" } },
    });
    const res = await onRequestPost(makeCtx({ db, request: req }));
    expect(res.status).toBe(200);
    expect(touchRepoPushed).toHaveBeenCalledWith(expect.any(Object), 7, "api");
  });
});

describe("POST /api/webhook — installation event", () => {
  it("skips when installation/account is missing", async () => {
    const req = await makeRequest({ event: "installation", payload: { action: "created", installation: {} } });
    const res = await onRequestPost(makeCtx({ db: makeDb(), request: req }));
    const body = await res.json();
    expect(body.skipped).toBe("missing installation/account");
  });

  it("installation.created upserts org + enqueues bootstrap task", async () => {
    const db = makeDb({ firstByFragment: { "SELECT id FROM orgs": { id: 9 } } });
    const send = vi.fn();
    const req = await makeRequest({
      event: "installation",
      payload: {
        action: "created",
        installation: { id: 100, account: { login: "acme", type: "Organization" } },
        repositories: [{ full_name: "acme/api" }],
      },
    });
    const res = await onRequestPost(makeCtx({ db, request: req, env: { TASK_QUEUE: { send } } }));
    expect(res.status).toBe(200);
    // Bootstrap now runs via the durable queue instead of context.waitUntil.
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: "bootstrap", orgId: 9, accountLogin: "acme", installationId: 100 }),
    );
    // First batch is the orgs upsert
    expect(db._calls.batch[0][0].sql).toMatch(/INSERT INTO orgs/);
  });

  it("installation.deleted clears installation_id", async () => {
    const db = makeDb();
    const req = await makeRequest({
      event: "installation",
      payload: {
        action: "deleted",
        installation: { id: 100, account: { login: "acme" } },
      },
    });
    const res = await onRequestPost(makeCtx({ db, request: req }));
    expect(res.status).toBe(200);
    expect(db._calls.run[0].sql).toMatch(/UPDATE orgs SET installation_id = NULL/);
  });
});
