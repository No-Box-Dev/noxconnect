import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/slack.js", () => ({
  checkSlackOrgHealth: vi.fn(async () => ({ status: "ok", recovered: false })),
  resolveSlackInstall: vi.fn(async () => ({ id: "conn-2", botToken: "xoxb-test" })),
  postSlackMessage: vi.fn(async () => ({ ok: true, channel: "C-ALERT", ts: "1.2" })),
  actionableSlackError: vi.fn((_error, fallback) => fallback),
}));

import { onRequestPost } from "../slack/test.js";
import { checkSlackOrgHealth, postSlackMessage } from "../../lib/slack.js";

function context(body) {
  const calls = [];
  return {
    request: new Request("https://app.noxhere.com/api/slack/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    data: { orgId: 7, orgLogin: "acme", isAdmin: true },
    env: {
      NOXCUE_RESPONSE: {
        buildTestResponse: vi.fn(async (org) => ({ contract: "noxcue.response", version: 1, message: { text: `NoxCue delivery test for ${org}`, blocks: [{ type: "section" }] } })),
      },
      NOXSPOT_RESPONSE: {
        buildIssueResponse: vi.fn(),
        buildSlackResponse: vi.fn(),
        buildTestResponse: vi.fn(async (org) => ({ contract: "noxspot.response", version: 1, message: { text: `NoxSpot delivery test for ${org}`, blocks: [{ type: "section" }] } })),
        buildDailyDigestResponse: vi.fn(async (name, period, filed, solved, totals) => ({
          contract: "noxspot.response", version: 1,
          message: { text: `${name} ${period}: ${totals.filed} filed, ${totals.solved} solved`, blocks: [{ type: "section" }] },
        })),
      },
      NOXFEED_RESPONSE: {
        buildPrompt: vi.fn(),
        buildSlackResponse: vi.fn(),
        buildTestResponse: vi.fn(async (org, stream) => ({
          contract: "noxfeed.response",
          version: 1,
          message: {
            text: `NoxFeed ${stream === "posts" ? "posts" : stream === "release_notes" ? "release notes" : "delivery"} delivery test for ${org}`.replace("delivery delivery", "delivery"),
            blocks: [{ type: "section" }],
          },
        })),
      },
      DB: {
        batch: async () => [
          { results: [{ count: 0 }] }, { results: [] },
          { results: [{ count: 0 }] }, { results: [] }, { results: [] },
        ],
        prepare: (sql) => ({
          bind: (...binds) => ({
            first: async () => sql.includes("FROM spot_sites site") ? {
              id: "site-playnist", org_id: 7, project_id: "project-1", repo: "playnist", name: "Playnist",
              widget_config: JSON.stringify({ dailySummaryEnabled: true }),
              slack_channel_id: "C-ALERT", slack_connection_id: "conn-2", owner_id: "acme",
            } : null,
            run: async () => { calls.push({ sql, binds }); return { success: true }; },
          }),
        }),
      },
    },
    calls,
  };
}

describe("Slack route tests", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends the NoxCue-specific payload to the selected channel", async () => {
    const response = await onRequestPost(context({ kind: "noxcue", channelId: "C-ALERT" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      connectionId: "conn-2",
      channelId: "C-ALERT",
      messageTs: "1.2",
    });
    expect(postSlackMessage).toHaveBeenCalledWith(
      "xoxb-test",
      "C-ALERT",
      expect.objectContaining({ text: "NoxCue delivery test for acme" }),
    );
  });

  it("sends a dedicated NoxCue alert-route test", async () => {
    const response = await onRequestPost(context({ kind: "noxcue_alerts", channelId: "C-ALERT" }));
    expect(response.status).toBe(200);
    expect(postSlackMessage).toHaveBeenCalledWith(
      "xoxb-test",
      "C-ALERT",
      expect.objectContaining({ text: "NoxCue alert delivery test for acme" }),
    );
  });

  it("sends the real NoxSpot daily-summary format for a selected site", async () => {
    const response = await onRequestPost(context({
      kind: "noxspot", sourceId: "site-playnist", connectionId: "conn-2", channelId: "C-ALERT",
    }));
    expect(response.status).toBe(200);
    expect(postSlackMessage).toHaveBeenCalledWith(
      "xoxb-test",
      "C-ALERT",
      expect.objectContaining({ text: expect.stringMatching(/^Playnist — test \d{4}-\d{2}-\d{2}: 0 filed, 0 solved$/) }),
    );
  });

  it("marks a bad receipt as an issue and the next accepted message as verified", async () => {
    vi.mocked(postSlackMessage)
      .mockResolvedValueOnce({ ok: true, channel: "C-WRONG", ts: "1.1" })
      .mockResolvedValueOnce({ ok: true, channel: "C-ALERT", ts: "1.2" });

    const failed = context({ kind: "noxcue", channelId: "C-ALERT" });
    expect((await onRequestPost(failed)).status).toBe(502);
    expect(failed.calls.some((call) => call.sql.includes("INSERT INTO slack_channel_status")
      && call.sql.includes("'issue'"))).toBe(true);

    const recovered = context({ kind: "noxcue", channelId: "C-ALERT" });
    expect((await onRequestPost(recovered)).status).toBe(200);
    expect(recovered.calls.some((call) => call.sql.includes("INSERT INTO slack_channel_status")
      && call.sql.includes("'verified'"))).toBe(true);
  });

  it("does not silently reinterpret an unknown test as NoxFeed", async () => {
    const response = await onRequestPost(context({ kind: "wrong", channelId: "C-OTHER" }));
    expect(response.status).toBe(400);
    expect(postSlackMessage).not.toHaveBeenCalled();
  });

  it("verifies one workspace connection and posts a real test message", async () => {
    const ctx = context({ kind: "connection", connectionId: "conn-2", channelId: "C-ALERT" });
    const response = await onRequestPost(ctx);
    expect(response.status).toBe(200);
    expect(checkSlackOrgHealth).toHaveBeenCalledWith(expect.anything(), 7, "conn-2");
    expect(postSlackMessage).toHaveBeenCalledWith(
      "xoxb-test",
      "C-ALERT",
      expect.objectContaining({ text: "NoxConnect workspace test for acme" }),
    );
    expect(ctx.calls.some((call) => call.sql.includes("INSERT INTO slack_channel_status")
      && call.binds.includes("C-ALERT"))).toBe(true);
  });

  it.each([
    ["noxfeed_posts", "NoxFeed posts delivery test for acme"],
    ["noxfeed_release_notes", "NoxFeed release notes delivery test for acme"],
  ])("sends a distinct %s test payload", async (kind, text) => {
    vi.mocked(postSlackMessage).mockResolvedValueOnce({ ok: true, channel: "C-FEED", ts: "1.2" });
    const response = await onRequestPost(context({ kind, channelId: "C-FEED" }));
    expect(response.status).toBe(200);
    expect(postSlackMessage).toHaveBeenCalledWith(
      "xoxb-test",
      "C-FEED",
      expect.objectContaining({ text }),
    );
  });

  it("sends a dedicated daily-summary test payload", async () => {
    vi.mocked(postSlackMessage).mockResolvedValueOnce({ ok: true, channel: "C-SUMMARY", ts: "1.3" });
    const response = await onRequestPost(context({ kind: "noxfeed_daily_summary", channelId: "C-SUMMARY" }));
    expect(response.status).toBe(200);
    expect(postSlackMessage).toHaveBeenCalledWith(
      "xoxb-test",
      "C-SUMMARY",
      expect.objectContaining({ text: "NoxFeed daily summary delivery test for acme" }),
    );
  });
});
