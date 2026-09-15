import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  stageSlackDelivery,
  queueOutboxDelivery,
  getActiveRepoNames,
  completeNarrative,
  resolveLlmConfig,
} = vi.hoisted(() => ({
  stageSlackDelivery: vi.fn(),
  queueOutboxDelivery: vi.fn(),
  getActiveRepoNames: vi.fn(),
  completeNarrative: vi.fn(),
  resolveLlmConfig: vi.fn(),
}));

vi.mock("../../../functions/lib/delivery-outbox.js", () => ({ stageSlackDelivery, queueOutboxDelivery }));
vi.mock("../../../functions/lib/inactive-repos.js", () => ({ getActiveRepoNames }));
vi.mock("../../../functions/lib/llm.js", () => ({ completeNarrative }));
vi.mock("../../../functions/lib/llm-config.js", () => ({ resolveLlmConfig }));

import { configuredMinutes, isSummaryDue, runNoxFeedDailySummaries } from "../noxfeed-daily-summaries.js";

describe("NoxFeed daily Slack summaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getActiveRepoNames.mockResolvedValue(["api", "web"]);
    resolveLlmConfig.mockResolvedValue({ status: "ready", model: "same-managed-model" });
    completeNarrative.mockResolvedValue("• Shipped checkout improvements.\n• Review is continuing on account settings.");
    stageSlackDelivery.mockResolvedValue({ id: "delivery-1", status: "pending" });
    queueOutboxDelivery.mockResolvedValue(true);
  });

  it("uses local time and waits until the selected time", () => {
    const now = Date.parse("2026-09-01T09:00:00Z");
    expect(configuredMinutes("17:00")).toBe(1020);
    expect(configuredMinutes("25:00")).toBeNull();
    expect(isSummaryDue(now, "Asia/Kuala_Lumpur", "17:00")).toBe("2026-09-01");
    expect(isSummaryDue(now - 60_000, "Asia/Kuala_Lumpur", "17:00")).toBeNull();
  });

  it("uses tracked-repository activity, the managed AI, and one retry-safe Slack delivery", async () => {
    const statements: Array<{ sql: string; args: unknown[] }> = [];
    const db = {
      prepare(sql: string) {
        const statement = {
          args: [] as unknown[],
          bind(...args: unknown[]) { this.args = args; return this; },
          async all() {
            statements.push({ sql, args: this.args });
            if (sql.includes("FROM projects project")) return { results: [{
              id: 7,
              project_id: "project-1",
              project_name: "Project One",
              github_login: "acme",
              timezone: "Asia/Kuala_Lumpur",
              time_local: "17:00",
              channel_id: "C123",
              connection_id: "connection-1",
            }] };
            if (sql.includes("FROM events")) return { results: [
              { type: "github:pr:merged", actor_id: "ada", repo: "api", summary: "PR #12: Faster checkout", created_at: "2026-09-01 08:30:00" },
              { type: "github:pr:review:changes_requested", actor_id: "lin", repo: "web", summary: "Review on PR #18", created_at: "2026-09-01T08:45:00Z" },
              { type: "github:pr:merged", actor_id: "ada", repo: "api", summary: "PR #12: Faster checkout", created_at: "2026-09-01T08:31:00Z" },
            ] };
            return { results: [] };
          },
          async first() {
            statements.push({ sql, args: this.args });
            return null;
          },
          async run() { return { meta: { changes: 1 } }; },
        };
        return statement;
      },
    };

    const result = await runNoxFeedDailySummaries(
      { DB: db, TASK_QUEUE: {} } as never,
      Date.parse("2026-09-01T09:00:00Z"),
    );

    expect(result).toEqual({ created: 1, skipped: 0, failed: 0 });
    expect(getActiveRepoNames).toHaveBeenCalledWith(db, 7, "acme", "project-1");
    expect(resolveLlmConfig).toHaveBeenCalledWith(expect.anything(), 7, "project-1");
    expect(completeNarrative).toHaveBeenCalledOnce();
    const userPrompt = JSON.parse(completeNarrative.mock.calls[0][2]);
    expect(userPrompt.activity).toHaveLength(2);
    expect(userPrompt.counts).toMatchObject({ pullRequestsMerged: 1, reviews: 1 });
    expect(stageSlackDelivery).toHaveBeenCalledWith(db, expect.objectContaining({
      source: "noxfeed_daily_summary",
      sourceId: "daily-summary:7:project-1:2026-09-01",
      connectionId: "connection-1",
      channelId: "C123",
    }));
    expect(queueOutboxDelivery).toHaveBeenCalledWith(expect.anything(), "delivery-1", "acme");
    expect(statements.find(({ sql }) => sql.includes("FROM events"))?.args).toContain("api");
    const orgQuery = statements.find(({ sql }) => sql.includes("FROM projects project"))?.sql ?? "";
    expect(orgQuery).toContain("dailySummaryChannelId");
    expect(orgQuery).not.toContain("releaseNotesChannelId");
  });

  it("skips days without tracked activity without calling AI", async () => {
    const db = {
      prepare(sql: string) {
        return {
          bind() { return this; },
          async all() {
            if (sql.includes("FROM projects project")) return { results: [{
              id: 7, github_login: "acme", timezone: "UTC", time_local: "09:00",
              project_id: "project-1", project_name: "Project One",
              channel_id: "C123", connection_id: "connection-1",
            }] };
            return { results: [] };
          },
          async first() { return null; },
        };
      },
    };
    const result = await runNoxFeedDailySummaries(
      { DB: db, TASK_QUEUE: {} } as never,
      Date.parse("2026-09-01T09:00:00Z"),
    );
    expect(result).toEqual({ created: 0, skipped: 1, failed: 0 });
    expect(completeNarrative).not.toHaveBeenCalled();
  });
});
