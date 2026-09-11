import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const RELEASE_NOTES_SYSTEM = "NOXFEED_RELEASE_NOTES_SYSTEM ".repeat(3);
const PR_OPENED_SYSTEM = "NOXFEED_PR_OPENED_SYSTEM ".repeat(3);

vi.mock("../llm.js", () => ({
  completeNarrative: vi.fn(),
  NARRATOR_MODEL: "claude-haiku-4-5-20251001",
  RELEASE_NOTES_MAX_TOKENS: 4096,
}));
vi.mock("../op-failures.js", () => ({
  recordFailure: vi.fn(async () => {}),
}));
vi.mock("../slack.js", () => ({
  resolveSlackChannels: vi.fn(async () => ({ postsChannelId: "", releaseNotesChannelId: "" })),
  resolveSlackRoute: vi.fn((channels, service) => (
    service === "noxfeed_release_notes" ? channels.releaseNotesChannelId : channels.postsChannelId
  ) || channels.noxFeedChannelId || channels.fallbackChannelId || ""),
  resolveSlackConnectionId: vi.fn((channels, service) => (
    service === "noxfeed_release_notes" ? channels.releaseNotesConnectionId : channels.postsConnectionId
  ) || channels.fallbackConnectionId || ""),
}));
vi.mock("../noxfeed-response.js", () => ({
  getNoxFeedPrompt: vi.fn(async (_env, kind, input, override) => ({
    system: override || (kind === "release_notes" ? RELEASE_NOTES_SYSTEM : kind === "pr_opened" ? PR_OPENED_SYSTEM : "NOXFEED_ACTOR_SYSTEM ".repeat(4)),
    user: `${input.actorName ? `You are ${input.actorName}.\n` : ""}Project: ${input.projectName}\n${JSON.stringify(input.event)}`,
  })),
  generateNoxFeedContent: vi.fn(),
  getNoxFeedSlackResponse: vi.fn(async (env, kind, input) => ({ message: { text: input.summary, blocks: [kind, input] } })),
}));
vi.mock("../delivery-outbox.js", () => ({
  stageSlackDelivery: vi.fn(async () => ({ id: "delivery-1", status: "pending" })),
  queueOutboxDelivery: vi.fn(async () => true),
  markOutboxBlocked: vi.fn(async () => {}),
}));
vi.mock("../noxfeed-routing.js", () => ({
  resolveNoxFeedDestination: vi.fn(async () => null),
}));

import {
  narrateEvent,
  narrateReleaseNotes,
  narratePrOpened,
  NARRATABLE_TYPES,
  NARRATABLE_TYPES_OPENED,
} from "../narrator.js";
import { completeNarrative } from "../llm.js";
import { recordFailure } from "../op-failures.js";
import { resolveSlackChannels } from "../slack.js";
import { markOutboxBlocked, queueOutboxDelivery, stageSlackDelivery } from "../delivery-outbox.js";
import { resolveNoxFeedDestination } from "../noxfeed-routing.js";
import { generateNoxFeedContent, getNoxFeedSlackResponse } from "../noxfeed-response.js";

// D1 stub: dispatch by SQL substring. Tests configure what each query returns
// and inspect _calls.runs/binds for the INSERT side effect.
function makeDb({
  event = null,
  project = null,
  actor = null,
  settings = null,
  existingReleaseNote = null,
  existingNarrative = null,
  existingPrNarrative = null,
  reusablePrNarrative = null, // { summary, technical_summary, model } — reuse SELECT
  pullRequest = null,
  org = { id: "org-1" },
} = {}) {
  const calls = { firsts: [], runs: [] };
  function prepare(sql) {
    return {
      _sql: sql,
      _binds: [],
      bind(...binds) { this._binds = binds; return this; },
      async first() {
        calls.firsts.push({ sql, binds: this._binds });
        // findExistingPrNarrative is the only SELECT that reads `summary` from
        // a pr_narrative row — route it to reusablePrNarrative so tests can
        // simulate "same PR was narrated at open time" without also tripping
        // the pr_narrative *dedup* SELECT below.
        if (sql.includes("type = 'pr_narrative'") && sql.includes("summary")) return reusablePrNarrative;
        if (sql.includes("type = 'pr_narrative'")) return existingPrNarrative;
        if (sql.includes("type = 'release_notes'")) return existingReleaseNote;
        if (sql.includes("type = 'narrative'")) return existingNarrative;
        if (sql.includes("FROM events")) return event;
        if (sql.includes("FROM projects")) return project;
        if (sql.includes("FROM actors")) return actor;
        if (sql.includes("FROM pull_requests")) return pullRequest;
        if (sql.includes("FROM config")) return settings;
        if (sql.includes("FROM orgs")) return org;
        return null;
      },
      async run() {
        calls.runs.push({ sql, binds: this._binds });
        return { meta: { changes: 1 } };
      },
    };
  }
  return { prepare, _calls: calls };
}

const ENV = (db) => ({ DB: db, ANTHROPIC_API_KEY: "managed-key" });

const EVENT_ROW = {
  id: 1,
  type: "github:pr:merged",
  actor_id: "actor-1",
  project_id: "proj-1",
  org: "no-box-dev",
  repo: "noxconnect",
  owner_id: "owner-1",
  summary: "PR #42: do thing",
  payload_json: JSON.stringify({ pr: { number: 42, title: "do thing" } }),
  created_at: "2026-05-17T10:00:00Z",
};

const PROJECT_ROW = { name: "noxconnect", narrator_enabled: 1 };
const ACTOR_ROW = { id: "actor-1", name: "Jane", tone: "Dry but warm" };

beforeEach(() => {
  completeNarrative.mockReset();
  generateNoxFeedContent.mockReset();
  generateNoxFeedContent.mockImplementation(fakeProductGeneration);
  recordFailure.mockClear();
  resolveSlackChannels.mockReset();
  resolveSlackChannels.mockResolvedValue({ postsChannelId: "", releaseNotesChannelId: "" });
  stageSlackDelivery.mockReset();
  stageSlackDelivery.mockResolvedValue({ id: "delivery-1", status: "pending" });
  queueOutboxDelivery.mockReset();
  queueOutboxDelivery.mockResolvedValue(true);
  markOutboxBlocked.mockReset();
  resolveNoxFeedDestination.mockReset();
  resolveNoxFeedDestination.mockResolvedValue(null);
});
afterEach(() => vi.restoreAllMocks());

async function fakeProductGeneration(_env, kind, input, override) {
  const system = override || (kind === "release_notes" ? RELEASE_NOTES_SYSTEM : kind === "pr_opened" ? PR_OPENED_SYSTEM : "NOXFEED_ACTOR_SYSTEM ".repeat(4));
  const user = `${input.actorName ? `You are ${input.actorName}.\n` : ""}Project: ${input.projectName}\n${JSON.stringify(input.event)}`;
  const text = await completeNarrative(
    {
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "managed-key",
      model: "claude-haiku-4-5-20251001",
      source: "managed",
    },
    system,
    user,
    ...(kind === "release_notes" ? [{ maxTokens: 4096, tag: "release-notes" }] : []),
  );
  if (!text) {
    return { status: "unavailable", model: "claude-haiku-4-5-20251001", errorCode: "provider_unavailable" };
  }
  if (kind === "release_notes") {
    return {
      status: "generated",
      model: "claude-haiku-4-5-20251001",
      output: { summary: fakeReleaseNote(text, input.event) },
    };
  }
  const raw = String(text).trim();
  let parsed;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }
  const summary = limitForTest(parsed?.social || raw, 800);
  const technical = Array.isArray(parsed?.technical) && parsed.technical.length === 3
    ? parsed.technical.map((line, index) => `${["What it does", "How it works", "What it touches"][index]}: ${String(line).replace(/^(what it does|how it works|what it touches)\s*:\s*/i, "")}`).join("\n")
    : [
        `What it does: ${input.event?.payload?.pr?.title || input.event?.summary}`,
        "How it works: Updates the implementation described by the pull request",
        `What it touches: ${input.projectName}`,
      ].join("\n");
  return {
    status: "generated",
    model: "claude-haiku-4-5-20251001",
    output: { summary, technicalSummary: technical },
  };
}

function limitForTest(value, max) {
  const text = String(value).trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function fakeReleaseNote(value, event) {
  const pr = event?.payload?.pr ?? {};
  let text = String(value)
    .replaceAll("[repo]", event?.repo ?? "")
    .replaceAll("[title]", pr.title ?? "")
    .replaceAll("[author]", pr.author ?? "")
    .replaceAll("[merger]", pr.merged_by ?? pr.author ?? "")
    .replaceAll("[head_ref]", pr.head_ref ?? "")
    .replaceAll("[base_ref]", pr.base_ref ?? "");
  const fields = [
    ["Repository", event?.repo],
    ["Pull Request", pr.number ? `#${pr.number}${pr.title ? ` - ${pr.title}` : ""}` : null],
    ["Author", pr.author ? `${pr.author} | Merged by: ${pr.merged_by ?? pr.author}` : null],
    ["Branch", pr.head_ref || pr.base_ref ? `${pr.head_ref ?? "?"} → ${pr.base_ref ?? "?"}` : null],
    ["Environment", event?.environment],
  ].filter(([, field]) => field);
  const lines = text.trim().split(/\r?\n/);
  for (const [label, field] of fields) {
    const index = lines.findIndex((line) => new RegExp(`^${label}:`, "i").test(line));
    if (index >= 0) lines[index] = `${label}: ${field}`;
    else lines.splice(Math.min(1, lines.length), 0, `${label}: ${field}`);
  }
  return lines.join("\n");
}

describe("NARRATABLE_TYPES", () => {
  it("exports the narratable type list with pr:merged", () => {
    expect(NARRATABLE_TYPES).toContain("github:pr:merged");
  });
  it("exports the pr-opened narratable type list with pr:opened", () => {
    expect(NARRATABLE_TYPES_OPENED).toContain("github:pr:opened");
  });
  it("keeps merged and opened lists disjoint", () => {
    for (const t of NARRATABLE_TYPES) {
      expect(NARRATABLE_TYPES_OPENED).not.toContain(t);
    }
  });
});

describe("narrateEvent — preconditions", () => {
  it("does nothing when the event row is missing", async () => {
    const db = makeDb();
    await narrateEvent(ENV(db), 999);
    expect(completeNarrative).not.toHaveBeenCalled();
    expect(db._calls.runs).toHaveLength(0);
  });

  it("skips events whose type is not narratable", async () => {
    const db = makeDb({ event: { ...EVENT_ROW, type: "github:pr:opened" } });
    await narrateEvent(ENV(db), 1);
    expect(completeNarrative).not.toHaveBeenCalled();
    expect(db._calls.runs).toHaveLength(0);
  });

  it("skips events missing actor_id", async () => {
    const db = makeDb({ event: { ...EVENT_ROW, actor_id: null } });
    await narrateEvent(ENV(db), 1);
    expect(completeNarrative).not.toHaveBeenCalled();
  });

  it("skips events missing project_id", async () => {
    const db = makeDb({ event: { ...EVENT_ROW, project_id: null } });
    await narrateEvent(ENV(db), 1);
    expect(completeNarrative).not.toHaveBeenCalled();
  });

  it("skips events missing owner_id", async () => {
    const db = makeDb({ event: { ...EVENT_ROW, owner_id: null } });
    await narrateEvent(ENV(db), 1);
    expect(completeNarrative).not.toHaveBeenCalled();
  });

  it("returns when project row is missing", async () => {
    const db = makeDb({ event: EVENT_ROW });
    await narrateEvent(ENV(db), 1);
    expect(completeNarrative).not.toHaveBeenCalled();
  });

  it("returns when project narrator is disabled (narrator_enabled = 0)", async () => {
    const db = makeDb({
      event: EVENT_ROW,
      project: { ...PROJECT_ROW, narrator_enabled: 0 },
    });
    await narrateEvent(ENV(db), 1);
    expect(completeNarrative).not.toHaveBeenCalled();
  });

  it("returns when actor row is missing", async () => {
    const db = makeDb({ event: EVENT_ROW, project: PROJECT_ROW });
    await narrateEvent(ENV(db), 1);
    expect(completeNarrative).not.toHaveBeenCalled();
  });
});

describe("narrateEvent — happy path", () => {
  it("calls completeNarrative with the actor system + built user message", async () => {
    const db = makeDb({ event: EVENT_ROW, project: PROJECT_ROW, actor: ACTOR_ROW });
    completeNarrative.mockResolvedValue("I merged the login button.");
    await narrateEvent(ENV(db), 1);
    expect(completeNarrative).toHaveBeenCalledTimes(1);
    const [config, systemPrompt, userMessage] = completeNarrative.mock.calls[0];
    expect(config).toMatchObject({
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "managed-key",
      model: "claude-haiku-4-5-20251001",
      source: "managed",
    });
    expect(typeof systemPrompt).toBe("string");
    expect(systemPrompt.length).toBeGreaterThan(50);
    expect(userMessage).toContain("You are Jane.");
    expect(userMessage).toContain("Project: noxconnect");
  });

  it("inserts a narrative event with the LLM-generated summary and NARRATOR_MODEL", async () => {
    const db = makeDb({ event: EVENT_ROW, project: PROJECT_ROW, actor: ACTOR_ROW });
    completeNarrative.mockResolvedValue("I merged the login button.");
    await narrateEvent(ENV(db), 1);
    expect(db._calls.runs).toHaveLength(1);
    const run = db._calls.runs[0];
    expect(run.sql).toContain("INSERT INTO events");
    const [source, type, actorId, projId, org, repo, summary, technicalSummary, payloadJson, ownerId, createdAt] = run.binds;
    expect(source).toBe("narrator");
    expect(type).toBe("narrative");
    expect(actorId).toBe("actor-1");
    expect(projId).toBe("proj-1");
    expect(org).toBe("no-box-dev");
    expect(repo).toBe("noxconnect");
    expect(summary).toBe("I merged the login button.");
    expect(technicalSummary).toBe([
      "What it does: do thing",
      "How it works: Updates the implementation described by the pull request",
      "What it touches: noxconnect",
    ].join("\n"));
    expect(ownerId).toBe("owner-1");
    expect(createdAt).toBe("2026-05-17T10:00:00Z");
    const payload = JSON.parse(payloadJson);
    expect(payload).toEqual({
      trigger_event_id: 1,
      trigger_type: "github:pr:merged",
      model: "claude-haiku-4-5-20251001",
      pr_number: 42,
    });
  });

  it("trims whitespace from the LLM output", async () => {
    const db = makeDb({ event: EVENT_ROW, project: PROJECT_ROW, actor: ACTOR_ROW });
    completeNarrative.mockResolvedValue("   spaced narrative   ");
    await narrateEvent(ENV(db), 1);
    expect(db._calls.runs[0].binds[6]).toBe("spaced narrative");
  });

  it("truncates output longer than 800 chars with an ellipsis", async () => {
    const db = makeDb({ event: EVENT_ROW, project: PROJECT_ROW, actor: ACTOR_ROW });
    completeNarrative.mockResolvedValue("x".repeat(900));
    await narrateEvent(ENV(db), 1);
    const summary = db._calls.runs[0].binds[6];
    expect(summary.length).toBe(800);
    expect(summary.endsWith("…")).toBe(true);
  });

  it("does not truncate output exactly 800 chars", async () => {
    const db = makeDb({ event: EVENT_ROW, project: PROJECT_ROW, actor: ACTOR_ROW });
    completeNarrative.mockResolvedValue("y".repeat(800));
    await narrateEvent(ENV(db), 1);
    const summary = db._calls.runs[0].binds[6];
    expect(summary.length).toBe(800);
    expect(summary.endsWith("…")).toBe(false);
  });
});

describe("narrateEvent — fallback path", () => {
  it("falls back to row.summary with model='fallback' when LLM returns null", async () => {
    const db = makeDb({ event: EVENT_ROW, project: PROJECT_ROW, actor: ACTOR_ROW });
    completeNarrative.mockResolvedValue(null);
    await narrateEvent(ENV(db), 1);
    expect(db._calls.runs).toHaveLength(1);
    const run = db._calls.runs[0];
    expect(run.binds[6]).toBe("PR #42: do thing");
    const payload = JSON.parse(run.binds[8]);
    expect(payload.model).toBe("fallback");
  });

  it("records an op_failures entry when LLM returns null", async () => {
    const db = makeDb({ event: EVENT_ROW, project: PROJECT_ROW, actor: ACTOR_ROW });
    completeNarrative.mockResolvedValue(null);
    await narrateEvent(ENV(db), 1);
    expect(recordFailure).toHaveBeenCalledTimes(1);
    const [, args] = recordFailure.mock.calls[0];
    expect(args).toMatchObject({
      ownerId: "owner-1",
      op: "narrateEvent",
      deliveryId: "event-1",
    });
    expect(args.error).toContain("NoxFeed generation unavailable");
    expect(args.error).toContain("provider_unavailable");
  });

  it("does NOT insert when LLM returns null AND row.summary is missing", async () => {
    const db = makeDb({
      event: { ...EVENT_ROW, summary: null },
      project: PROJECT_ROW,
      actor: ACTOR_ROW,
    });
    completeNarrative.mockResolvedValue(null);
    await narrateEvent(ENV(db), 1);
    expect(db._calls.runs).toHaveLength(0);
  });
});

describe("narrateEvent — idempotency", () => {
  it("skips when a narrative row already exists for the PR", async () => {
    const db = makeDb({
      event: EVENT_ROW,
      project: PROJECT_ROW,
      actor: ACTOR_ROW,
      existingNarrative: { id: 99 },
    });
    await narrateEvent(ENV(db), 1);
    expect(completeNarrative).not.toHaveBeenCalled();
    expect(db._calls.runs).toHaveLength(0);
  });

  it("dedups by (owner_id, repo, pr_number), not by trigger_event_id", async () => {
    // GitHub redelivers webhooks: same PR → new trigger event row with a
    // different id. The early-exit SELECT must bind on pr_number (42 from
    // EVENT_ROW.payload_json), not on row.id (1).
    const db = makeDb({ event: EVENT_ROW, project: PROJECT_ROW, actor: ACTOR_ROW });
    completeNarrative.mockResolvedValue("ok");
    await narrateEvent(ENV(db), 1);
    const dedupSelect = db._calls.firsts.find(
      (f) => f.sql.includes("type = 'narrative'") && f.sql.includes("pr_number"),
    );
    expect(dedupSelect).toBeDefined();
    expect(dedupSelect.binds).toEqual(["owner-1", "noxconnect", 42]);
  });

  it("uses INSERT ... ON CONFLICT DO NOTHING so concurrent writers can't double-insert", async () => {
    const db = makeDb({ event: EVENT_ROW, project: PROJECT_ROW, actor: ACTOR_ROW });
    completeNarrative.mockResolvedValue("ok");
    await narrateEvent(ENV(db), 1);
    const insert = db._calls.runs.find((r) => r.sql.includes("INSERT INTO events"));
    expect(insert.sql).toMatch(/ON CONFLICT\s+DO NOTHING/i);
  });

  it("skips the Slack mirror when the INSERT was suppressed by the unique index", async () => {
    // A concurrent narrator beat us to the row — D1 returns changes=0 from
    // ON CONFLICT DO NOTHING. The Slack mirror must not fire, otherwise the
    // same merged PR would post twice to the channel.
    const db = makeDb({ event: EVENT_ROW, project: PROJECT_ROW, actor: ACTOR_ROW });
    const realPrepare = db.prepare;
    db.prepare = (sql) => {
      const stmt = realPrepare(sql);
      if (sql.includes("INSERT INTO events")) {
        const orig = stmt.run.bind(stmt);
        stmt.run = async () => {
          await orig();
          return { meta: { changes: 0 } };
        };
      }
      return stmt;
    };
    resolveSlackChannels.mockResolvedValue({ postsChannelId: "C1", releaseNotesChannelId: "" });
    completeNarrative.mockResolvedValue("ok");
    await narrateEvent(ENV(db), 1);
    expect(stageSlackDelivery).not.toHaveBeenCalled();
  });
});

describe("narrateReleaseNotes", () => {
  it("inserts a release_notes row when the LLM produces text", async () => {
    const db = makeDb({ event: EVENT_ROW, project: PROJECT_ROW, actor: ACTOR_ROW });
    completeNarrative.mockResolvedValue("🐛 noxconnect #42 Merged - Bugfix\nDetails: fixed the thing.");
    await narrateReleaseNotes(ENV(db), 1);
    expect(completeNarrative).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.any(String),
      { maxTokens: 4096, tag: "release-notes" },
    );
    const inserts = db._calls.runs.filter((r) => r.sql.includes("INSERT INTO events"));
    expect(inserts).toHaveLength(1);
    const [source, type] = inserts[0].binds;
    expect(source).toBe("release-notes");
    expect(type).toBe("release_notes");
  });

  it("replaces model placeholders and always includes the release environment", async () => {
    const db = makeDb({
      event: EVENT_ROW,
      project: PROJECT_ROW,
      actor: ACTOR_ROW,
      pullRequest: { author: "Jane", merged_by: "Sam", head_ref: "develop", base_ref: "main" },
    });
    completeNarrative.mockResolvedValue([
      "🐛 [repo] #42 Merged - Bugfix",
      "Repository: [repo]",
      "Pull Request: #42 - [title]",
      "Author: [author] | Merged by: [merger]",
      "Branch: [head_ref] → [base_ref]",
      "",
      "Change Summary",
      "Details: fixed the thing.",
    ].join("\n"));
    await narrateReleaseNotes(ENV(db), 1);
    const insert = db._calls.runs.find((run) => run.sql.includes("INSERT INTO events"));
    expect(insert.binds[6]).toContain("🐛 noxconnect #42 Merged - Bugfix");
    expect(insert.binds[6]).toContain("Repository: noxconnect");
    expect(insert.binds[6]).toContain("Author: Jane | Merged by: Sam");
    expect(insert.binds[6]).toContain("Branch: develop → main");
    expect(insert.binds[6]).toContain("Environment: Production");
    expect(JSON.parse(insert.binds[7]).environment).toBe("Production");
  });

  it("uses the default system prompt when no override is configured", async () => {
    const db = makeDb({ event: EVENT_ROW, project: PROJECT_ROW, actor: ACTOR_ROW });
    completeNarrative.mockResolvedValue("ok");
    await narrateReleaseNotes(ENV(db), 1);
    const [, systemPrompt] = completeNarrative.mock.calls[0];
    expect(systemPrompt).toBe(RELEASE_NOTES_SYSTEM);
  });

  it("uses the admin override prompt from settings.releaseNotesPrompt", async () => {
    const db = makeDb({
      event: EVENT_ROW,
      project: PROJECT_ROW,
      actor: ACTOR_ROW,
      settings: { data: JSON.stringify({ releaseNotesPrompt: "CUSTOM RELEASE-NOTE VOICE" }) },
    });
    completeNarrative.mockResolvedValue("ok");
    await narrateReleaseNotes(ENV(db), 1);
    const [, systemPrompt] = completeNarrative.mock.calls[0];
    expect(systemPrompt).toBe("CUSTOM RELEASE-NOTE VOICE");
  });

  it("skips when a release_notes row already exists for the trigger", async () => {
    const db = makeDb({
      event: EVENT_ROW,
      project: PROJECT_ROW,
      actor: ACTOR_ROW,
      existingReleaseNote: { id: 99 },
    });
    await narrateReleaseNotes(ENV(db), 1);
    expect(completeNarrative).not.toHaveBeenCalled();
    expect(db._calls.runs).toHaveLength(0);
  });

  it("falls back to row.summary when the LLM fails and records op_failure", async () => {
    const db = makeDb({ event: EVENT_ROW, project: PROJECT_ROW, actor: ACTOR_ROW });
    completeNarrative.mockResolvedValue(null);
    await narrateReleaseNotes(ENV(db), 1);
    const insert = db._calls.runs.find((r) => r.sql.includes("INSERT INTO events"));
    expect(insert.binds[6]).toBe("PR #42: do thing");
    expect(JSON.parse(insert.binds[7]).model).toBe("fallback");
    expect(recordFailure).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ op: "narrateReleaseNotes" }),
    );
  });

  it("respects narrator_enabled=0 (same gate as narrateEvent)", async () => {
    const db = makeDb({
      event: EVENT_ROW,
      project: { ...PROJECT_ROW, narrator_enabled: 0 },
      actor: ACTOR_ROW,
    });
    await narrateReleaseNotes(ENV(db), 1);
    expect(completeNarrative).not.toHaveBeenCalled();
  });
});

// PR identity is the dedup unit (migration 0033). Narratable events
// (github:pr:merged) always carry pr.number, so a missing pr.number means
// either the row is corrupt or the event type is wrong — short-circuit
// rather than narrate a row we couldn't dedup later.
describe("narrateEvent — payload parsing", () => {
  it("short-circuits on corrupt payload_json (no pr.number means no dedup key)", async () => {
    const db = makeDb({
      event: { ...EVENT_ROW, payload_json: "not json" },
      project: PROJECT_ROW,
      actor: ACTOR_ROW,
    });
    completeNarrative.mockResolvedValue("ok");
    await narrateEvent(ENV(db), 1);
    expect(completeNarrative).not.toHaveBeenCalled();
  });

  it("short-circuits on null payload_json", async () => {
    const db = makeDb({
      event: { ...EVENT_ROW, payload_json: null },
      project: PROJECT_ROW,
      actor: ACTOR_ROW,
    });
    completeNarrative.mockResolvedValue("ok");
    await narrateEvent(ENV(db), 1);
    expect(completeNarrative).not.toHaveBeenCalled();
  });

  it("short-circuits on non-object JSON (string/array)", async () => {
    const db = makeDb({
      event: { ...EVENT_ROW, payload_json: '"just a string"' },
      project: PROJECT_ROW,
      actor: ACTOR_ROW,
    });
    completeNarrative.mockResolvedValue("ok");
    await narrateEvent(ENV(db), 1);
    expect(completeNarrative).not.toHaveBeenCalled();
  });

  it("narrates when payload carries pr.number (happy path for github:pr:merged)", async () => {
    const db = makeDb({ event: EVENT_ROW, project: PROJECT_ROW, actor: ACTOR_ROW });
    completeNarrative.mockResolvedValue("ok");
    await narrateEvent(ENV(db), 1);
    expect(completeNarrative).toHaveBeenCalled();
    // pr_number is denormalized into the narrative payload for the
    // PR-identity UNIQUE INDEX. Verify it's written.
    const insert = db._calls.runs.find((r) => r.sql.includes("INSERT INTO events"));
    expect(JSON.parse(insert.binds[8]).pr_number).toBe(42);
  });
});

describe("narrateEvent — app-only merged post", () => {
  it("stores the social narrative without staging a second Slack message", async () => {
    const db = makeDb({ event: EVENT_ROW, project: PROJECT_ROW, actor: ACTOR_ROW });
    completeNarrative.mockResolvedValue("I merged it.");
    resolveSlackChannels.mockResolvedValue({ postsChannelId: "C1", releaseNotesChannelId: "C1" });

    await narrateEvent(ENV(db), 1);

    expect(db._calls.runs.some((run) => run.sql.includes("INSERT INTO events"))).toBe(true);
    expect(stageSlackDelivery).not.toHaveBeenCalled();
  });
});

describe("narrateReleaseNotes — Slack mirror", () => {
  it("stages exactly one Slack delivery when both merge narrators run", async () => {
    const db = makeDb({
      event: EVENT_ROW,
      project: PROJECT_ROW,
      actor: ACTOR_ROW,
      reusablePrNarrative: { summary: "I shipped the social post.", model: "glm-5" },
    });
    completeNarrative.mockResolvedValue("✅ noxconnect #42 Merged - Feature\n\nSummary\nOutcome: shipped");
    resolveSlackChannels.mockResolvedValue({ postsChannelId: "C2", releaseNotesChannelId: "C2" });

    await narrateEvent(ENV(db), 1);
    await narrateReleaseNotes(ENV(db), 1);

    expect(stageSlackDelivery).toHaveBeenCalledTimes(1);
    expect(stageSlackDelivery).toHaveBeenCalledWith(db, expect.objectContaining({
      source: "release_notes", channelId: "C2",
    }));
    expect(getNoxFeedSlackResponse).toHaveBeenCalledWith(expect.anything(), "release_notes", expect.objectContaining({
      summary: expect.stringContaining("Outcome: shipped"),
      post: expect.objectContaining({
        actorName: "Jane",
        summary: "I shipped the social post.",
      }),
    }));
  });

  it("posts to the Release-notes channel after inserting a release_notes row", async () => {
    const db = makeDb({ event: EVENT_ROW, project: PROJECT_ROW, actor: ACTOR_ROW });
    completeNarrative.mockResolvedValue("🐛 noxconnect #42 ...");
    resolveSlackChannels.mockResolvedValue({ postsChannelId: "", releaseNotesChannelId: "C2" });
    await narrateReleaseNotes(ENV(db), 1);
    expect(stageSlackDelivery).toHaveBeenCalledWith(db, expect.objectContaining({
      source: "release_notes", sourceId: "1:release_notes", channelId: "C2",
      payload: expect.objectContaining({ releaseNote: expect.objectContaining({ summary: expect.any(String) }) }),
    }));
  });

  it("does NOT post to Slack when the gate (narrator_enabled=0) blocks", async () => {
    const db = makeDb({
      event: EVENT_ROW,
      project: { ...PROJECT_ROW, narrator_enabled: 0 },
      actor: ACTOR_ROW,
    });
    resolveSlackChannels.mockResolvedValue({ postsChannelId: "C1", releaseNotesChannelId: "C2" });
    await narrateReleaseNotes(ENV(db), 1);
    expect(stageSlackDelivery).not.toHaveBeenCalled();
  });
});

// -------- narratePrOpened --------
// Sibling of narrateEvent, but fires on PR-open events and writes a
// pr_narrative row that the merge-time narrators later reuse.

const EVENT_ROW_OPENED = {
  ...EVENT_ROW,
  type: "github:pr:opened",
  summary: "PR #42: do thing",
};

describe("narratePrOpened — preconditions", () => {
  it("does nothing when the event row is missing", async () => {
    const db = makeDb();
    await narratePrOpened(ENV(db), 999);
    expect(completeNarrative).not.toHaveBeenCalled();
    expect(db._calls.runs).toHaveLength(0);
  });

  it("skips events whose type is not pr:opened (e.g. pr:merged)", async () => {
    const db = makeDb({ event: EVENT_ROW });
    await narratePrOpened(ENV(db), 1);
    expect(completeNarrative).not.toHaveBeenCalled();
    expect(db._calls.runs).toHaveLength(0);
  });

  it("skips when the actor row is missing (no author to attribute)", async () => {
    const db = makeDb({ event: EVENT_ROW_OPENED, project: PROJECT_ROW });
    await narratePrOpened(ENV(db), 1);
    expect(completeNarrative).not.toHaveBeenCalled();
  });

  it("skips when narrator_enabled=0", async () => {
    const db = makeDb({
      event: EVENT_ROW_OPENED,
      project: { ...PROJECT_ROW, narrator_enabled: 0 },
      actor: ACTOR_ROW,
    });
    await narratePrOpened(ENV(db), 1);
    expect(completeNarrative).not.toHaveBeenCalled();
  });

  it("skips draft PRs — the Opened feed only surfaces ready-for-review", async () => {
    const draftRow = {
      ...EVENT_ROW_OPENED,
      payload_json: JSON.stringify({ pr: { number: 42, title: "wip: do thing", draft: true } }),
    };
    const db = makeDb({ event: draftRow, project: PROJECT_ROW, actor: ACTOR_ROW });
    await narratePrOpened(ENV(db), 1);
    expect(completeNarrative).not.toHaveBeenCalled();
    expect(db._calls.runs.find((r) => r.sql.includes("INSERT INTO events"))).toBeUndefined();
  });
});

describe("narratePrOpened — happy path", () => {
  it("calls the LLM with the PR_OPENED_SYSTEM prompt", async () => {
    const db = makeDb({ event: EVENT_ROW_OPENED, project: PROJECT_ROW, actor: ACTOR_ROW });
    completeNarrative.mockResolvedValue("Fixing the login redirect.");
    await narratePrOpened(ENV(db), 1);
    expect(completeNarrative).toHaveBeenCalledTimes(1);
    const [, systemPrompt] = completeNarrative.mock.calls[0];
    expect(systemPrompt).toBe(PR_OPENED_SYSTEM);
  });

  it("inserts a pr_narrative row with source=pr-opened-narrator", async () => {
    const db = makeDb({ event: EVENT_ROW_OPENED, project: PROJECT_ROW, actor: ACTOR_ROW });
    completeNarrative.mockResolvedValue("Fixing the login redirect.");
    await narratePrOpened(ENV(db), 1);
    const insert = db._calls.runs.find((r) => r.sql.includes("INSERT INTO events"));
    expect(insert).toBeDefined();
    const [source, type, , , , , summary, technicalSummary, payloadJson] = insert.binds;
    expect(source).toBe("pr-opened-narrator");
    expect(type).toBe("pr_narrative");
    expect(summary).toBe("Fixing the login redirect.");
    expect(technicalSummary).toContain("What it does: do thing");
    const payload = JSON.parse(payloadJson);
    expect(payload.pr_number).toBe(42);
    expect(payload.trigger_type).toBe("github:pr:opened");
    expect(payload.model).toBe("claude-haiku-4-5-20251001");
  });

  it("keeps opened PR narration in-app and does not send it to Slack", async () => {
    const db = makeDb({ event: EVENT_ROW_OPENED, project: PROJECT_ROW, actor: ACTOR_ROW });
    resolveSlackChannels.mockResolvedValue({ postsChannelId: "C1", releaseNotesChannelId: "" });
    completeNarrative.mockResolvedValue("Fixing the login redirect.");
    await narratePrOpened(ENV(db), 1);
    expect(stageSlackDelivery).not.toHaveBeenCalled();
  });

  it("dedups by PR identity — skips when pr_narrative row already exists", async () => {
    const db = makeDb({
      event: EVENT_ROW_OPENED,
      project: PROJECT_ROW,
      actor: ACTOR_ROW,
      existingPrNarrative: { id: 99 },
    });
    await narratePrOpened(ENV(db), 1);
    expect(completeNarrative).not.toHaveBeenCalled();
    expect(db._calls.runs).toHaveLength(0);
  });

  it("falls back to row.summary with model=fallback when LLM returns null", async () => {
    const db = makeDb({ event: EVENT_ROW_OPENED, project: PROJECT_ROW, actor: ACTOR_ROW });
    completeNarrative.mockResolvedValue(null);
    await narratePrOpened(ENV(db), 1);
    const insert = db._calls.runs.find((r) => r.sql.includes("INSERT INTO events"));
    expect(insert.binds[6]).toBe("PR #42: do thing");
    expect(JSON.parse(insert.binds[8]).model).toBe("fallback");
    expect(recordFailure).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ op: "narratePrOpened" }),
    );
  });
});

// -------- Reuse-text branch --------
// The load-bearing invariant of the "Opened feed" feature. When a PR opens,
// narratePrOpened writes text. When it merges, the merge-time narrators
// find that text and reuse it verbatim — no fresh LLM call. This drops the
// per-PR-lifecycle LLM cost from 2 → 1.

describe("narrateEvent — reuse text from pr_narrative row", () => {
  it("uses the existing pr_narrative text and does NOT call the LLM", async () => {
    const db = makeDb({
      event: EVENT_ROW,
      project: PROJECT_ROW,
      actor: ACTOR_ROW,
      reusablePrNarrative: { summary: "Fixing the login redirect.", model: "glm-5" },
    });
    await narrateEvent(ENV(db), 1);
    expect(completeNarrative).not.toHaveBeenCalled();
    const insert = db._calls.runs.find((r) => r.sql.includes("INSERT INTO events"));
    expect(insert).toBeDefined();
    const [source, type, , , , , summary, technicalSummary, payloadJson] = insert.binds;
    expect(source).toBe("narrator-reused");
    expect(type).toBe("narrative");
    expect(summary).toBe("Fixing the login redirect.");
    expect(technicalSummary).toContain("What it does:");
    const payload = JSON.parse(payloadJson);
    expect(payload.model).toBe("reused:glm-5");
  });

  it("falls through to the LLM when the pr_narrative row is a 'fallback' model", async () => {
    // Reusing a fallback (raw title) row would leave the merged feed stuck on
    // the PR title — worse than paying for a fresh narration.
    const db = makeDb({
      event: EVENT_ROW,
      project: PROJECT_ROW,
      actor: ACTOR_ROW,
      reusablePrNarrative: { summary: "PR #42: do thing", model: "fallback" },
    });
    completeNarrative.mockResolvedValue("I merged the login button.");
    await narrateEvent(ENV(db), 1);
    expect(completeNarrative).toHaveBeenCalledTimes(1);
    const insert = db._calls.runs.find((r) => r.sql.includes("INSERT INTO events"));
    expect(insert.binds[0]).toBe("narrator");
    expect(insert.binds[6]).toBe("I merged the login button.");
  });

  it("keeps reused Opened-feed copy app-only when the PR merges", async () => {
    const db = makeDb({
      event: EVENT_ROW,
      project: PROJECT_ROW,
      actor: ACTOR_ROW,
      reusablePrNarrative: { summary: "Fixing the login redirect.", model: "glm-5" },
    });
    await narrateEvent(ENV(db), 1);
    expect(stageSlackDelivery).not.toHaveBeenCalled();
  });

  it("keeps fresh merged narration app-only too", async () => {
    const db = makeDb({ event: EVENT_ROW, project: PROJECT_ROW, actor: ACTOR_ROW });
    completeNarrative.mockResolvedValue("I merged it.");
    await narrateEvent(ENV(db), 1);
    expect(stageSlackDelivery).not.toHaveBeenCalled();
  });
});

describe("narrateReleaseNotes — always calls the LLM", () => {
  // Release notes need the structured RELEASE_NOTES_SYSTEM format — the
  // opened-time chat voice we reuse for the Posts feed reads like a Post
  // in the Release-notes feed. So even when a pr_narrative row exists, we
  // do NOT reuse it here.
  it("calls the LLM with the release-notes prompt, ignoring any existing pr_narrative", async () => {
    const db = makeDb({
      event: EVENT_ROW,
      project: PROJECT_ROW,
      actor: ACTOR_ROW,
      reusablePrNarrative: { summary: "Fixing the login redirect.", model: "glm-5" },
    });
    completeNarrative.mockResolvedValue("## Change Summary\nStructured note.");
    await narrateReleaseNotes(ENV(db), 1);
    expect(completeNarrative).toHaveBeenCalledTimes(1);
    const insert = db._calls.runs.find((r) => r.sql.includes("INSERT INTO events"));
    expect(insert).toBeDefined();
    const [source, type, , , , , summary, payloadJson] = insert.binds;
    expect(source).toBe("release-notes");
    expect(type).toBe("release_notes");
    expect(summary).toContain("Repository: noxconnect");
    expect(summary).toContain("Pull Request: #42 - do thing");
    expect(summary).toContain("## Change Summary");
    expect(summary).toContain("Structured note.");
    expect(JSON.parse(payloadJson).model).not.toMatch(/^reused:/);
  });
});
