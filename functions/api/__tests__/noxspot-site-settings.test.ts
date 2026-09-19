import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/slack.js", () => ({
  resolveSlackInstall: vi.fn(),
  resolveSlackChannels: vi.fn(async () => ({ fallbackChannelId: "" })),
  getSlackChannel: vi.fn(),
}));
vi.mock("../../lib/delivery-outbox.js", () => ({ requeueBlockedForSite: vi.fn(async () => ({ queued: 1 })) }));

import { onRequestPatch } from "../spots/sites/[id]/index";
import { getSlackChannel, resolveSlackChannels, resolveSlackInstall } from "../../lib/slack.js";
import { requeueBlockedForSite } from "../../lib/delivery-outbox.js";

function database() {
  const runs: Array<{ sql: string; binds: unknown[] }> = [];
  return {
    runs,
    async batch(statements: Array<{ run: () => Promise<unknown> }>) {
      return Promise.all(statements.map((statement) => statement.run()));
    },
    prepare(sql: string) {
      const statement = {
        binds: [] as unknown[],
        bind(...binds: unknown[]) { statement.binds = binds; return statement; },
        async first() {
          if (sql.includes("FROM spot_sites")) return { id: "site-1", project_id: "playnist", slack_channel_id: null, widget_config: "{}" };
          return null;
        },
        async run() { runs.push({ sql, binds: statement.binds }); return { success: true }; },
      };
      return statement;
    },
  };
}

function context(db: ReturnType<typeof database>, body: unknown) {
  return {
    env: { DB: db, ENCRYPTION_KEY: "key", TASK_QUEUE: { send: vi.fn() } },
    data: { orgId: 7, userLogin: "admin", isAdmin: true },
    params: { id: "site-1" },
    request: new Request("https://app.noxhere.com/api/spots/sites/site-1", {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }),
  };
}

describe("NoxSpot Slack site settings", () => {
  beforeEach(() => vi.clearAllMocks());

  it("refuses a channel when the central Slack install is unavailable", async () => {
    vi.mocked(resolveSlackInstall).mockResolvedValue(null);
    const response = await onRequestPatch(context(database(), { slackChannelId: "C123" }) as never);
    expect(response.status).toBe(409);
    expect(getSlackChannel).not.toHaveBeenCalled();
  });

  it("validates the channel and releases blocked deliveries after saving", async () => {
    vi.mocked(resolveSlackInstall).mockResolvedValue({ botToken: "xoxb-test" } as never);
    vi.mocked(getSlackChannel).mockResolvedValue({ id: "C123", is_archived: false, is_private: false } as never);
    const db = database();
    const ctx = context(db, { slackChannelId: "C123" });
    const response = await onRequestPatch(ctx as never);
    expect(response.status).toBe(200);
    expect(getSlackChannel).toHaveBeenCalledWith("xoxb-test", "C123");
    expect(db.runs.some((run) => run.binds[0] === "C123" && run.sql.includes("source = 'noxspot'"))).toBe(true);
    expect(requeueBlockedForSite).toHaveBeenCalledWith(expect.objectContaining({ DB: db }), 7, "site-1");
  });

  it("rejects a private channel until the bot is invited", async () => {
    vi.mocked(resolveSlackInstall).mockResolvedValue({ botToken: "xoxb-test" } as never);
    vi.mocked(getSlackChannel).mockResolvedValue({ id: "C123", is_archived: false, is_private: true, is_member: false } as never);
    const response = await onRequestPatch(context(database(), { slackChannelId: "C123" }) as never);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("Invite") });
  });

  it("uses the organization fallback when a site override is cleared", async () => {
    vi.mocked(resolveSlackChannels).mockResolvedValue({ fallbackChannelId: "C-FALLBACK" } as never);
    const db = database();
    const response = await onRequestPatch(context(db, { slackChannelId: null }) as never);
    expect(response.status).toBe(200);
    expect(db.runs.some((run) => run.binds[0] === "C-FALLBACK" && run.sql.includes("source = 'noxspot'"))).toBe(true);
    expect(requeueBlockedForSite).toHaveBeenCalledWith(expect.objectContaining({ DB: db }), 7, "site-1");
  });
});

describe("NoxSpot widget configuration", () => {
  it("rejects duplicate environment names", async () => {
    const response = await onRequestPatch(context(database(), {
      environments: [
        { name: "Production", url: "app.example.com" },
        { name: "production", url: "staging.example.com" },
      ],
    }) as never);
    expect(response.status).toBe(400);
  });

  it("rejects blocks that reference an unknown environment", async () => {
    const response = await onRequestPatch(context(database(), {
      environments: [{ name: "Production", url: "app.example.com" }],
      blocks: [
        { id: "title", type: "title", required: true },
        { id: "impact", type: "custom_text", environments: ["Staging"] },
      ],
    }) as never);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("unknown environment") });
  });

  it("stores a validated environment and form configuration together", async () => {
    const db = database();
    const response = await onRequestPatch(context(db, {
      environments: [{ name: "Production", url: "app.example.com", enabled: true }],
      blocks: [
        { id: "title", type: "title", required: true },
        { id: "impact", type: "custom_select", label: "Impact", options: ["Low", "High"], environments: ["Production"] },
      ],
    }) as never);
    expect(response.status).toBe(200);
    const update = db.runs.find((run) => run.sql.includes("UPDATE spot_sites SET"));
    expect(JSON.parse(String(update?.binds[2]))).toMatchObject({
      environments: [{ name: "Production" }],
      blocks: [{ id: "title" }, { id: "impact", options: ["Low", "High"] }],
    });
  });
});

describe("NoxSpot daily summary settings", () => {
  it("stores whether the fixed midnight UTC summary is enabled", async () => {
    const db = database();
    const response = await onRequestPatch(context(db, {
      dailySummaryEnabled: true,
    }) as never);
    expect(response.status).toBe(200);
    const update = db.runs.find((run) => run.sql.includes("UPDATE spot_sites SET"));
    expect(JSON.parse(String(update?.binds[2]))).toMatchObject({
      dailySummaryEnabled: true,
    });
  });

  it("rejects the removed custom schedule fields", async () => {
    const response = await onRequestPatch(context(database(), {
      dailySummaryTime: "14:30",
      dailySummaryTimezone: "Asia/Kuala_Lumpur",
    }) as never);
    expect(response.status).toBe(400);
  });
});
