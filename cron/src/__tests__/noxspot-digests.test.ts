import { describe, expect, it, vi } from "vitest";
import { closingIssueNumbers, dailyDigestPeriod, runNoxSpotDailyDigests } from "../noxspot-digests.js";

describe("NoxSpot daily Slack summaries", () => {
  it("selects the previous 24-hour UTC window only at midnight UTC", () => {
    expect(dailyDigestPeriod(Date.parse("2026-08-31T23:59:00Z"))).toBeNull();
    expect(dailyDigestPeriod(Date.parse("2026-09-01T00:00:00Z"))).toBe("2026-08-31");
    expect(dailyDigestPeriod(Date.parse("2026-09-01T00:30:00Z"))).toBeNull();
    expect(dailyDigestPeriod(Date.parse("2026-09-01T09:00:00Z"))).toBeNull();
  });

  it("finds only issue references that a pull request closes in this repository", () => {
    const payload = JSON.stringify({ pr: { body: "Fixes #12. Closes acme/web#13. Resolves other/web#14. Mentions #15." } });
    expect(closingIssueNumbers(payload, "acme", "web")).toEqual([12, 13]);
  });

  it("stages one retry-safe site summary and uses the captured submitter", async () => {
    const statements: Array<{ sql: string; statement: { args: unknown[] } }> = [];
    const prepare = (sql: string) => {
      const statement = {
        args: [] as unknown[],
        bind(...args: unknown[]) { this.args = args; return this; },
        async all() {
          if (sql.includes("FROM spot_sites site")) return { results: [{
            id: "site-1", org_id: 7, project_id: "project-1", repo: "web", name: "Storefront",
            widget_config: JSON.stringify({ dailySummaryEnabled: true }),
            owner_id: "acme", slack_channel_id: "C123", slack_connection_id: "connection-1",
          }] };
          return { results: [] };
        },
        async first() {
          if (sql.includes("SELECT data FROM config")) return { data: JSON.stringify({
            apps: { noxspot: true }, slack: { fallbackChannelId: "CFALL", fallbackConnectionId: "fallback-1" },
          }) };
          if (sql.includes("SELECT id FROM delivery_outbox")) return null;
          if (sql.includes("INSERT INTO delivery_outbox")) return { id: "delivery-1", status: "pending" };
          return null;
        },
        async run() { return { success: true, meta: { changes: 1 } }; },
      };
      statements.push({ sql, statement });
      return statement;
    };
    const db = {
      prepare,
      async batch() {
        return [
          { results: [{ count: 1 }] },
          { results: [{
            number: 31, title: "Save button fails", html_url: "https://github.com/acme/web/issues/31",
            capture_payload: JSON.stringify({ reporter: "Ada" }),
          }] },
          { results: [{ count: 1 }] },
          { results: [{
            number: 30, title: "Image is blank", html_url: "https://github.com/acme/web/issues/30",
            capture_payload: JSON.stringify({ reporter: "Lin" }),
          }] },
          { results: [{
            number: 55, title: "Serve images through the proxy", html_url: "https://github.com/acme/web/pull/55",
            payload_json: JSON.stringify({ pr: { body: "Fixes #30" } }),
          }] },
        ];
      },
    };
    const service = { buildDailyDigestResponse: vi.fn(async () => ({
      contract: "noxspot.response", version: 1,
      message: { text: "Daily NoxSpot summary", blocks: [{ type: "section", text: { type: "mrkdwn", text: "Summary" } }] },
    })) };
    const queue = { send: vi.fn(async () => undefined) };

    const result = await runNoxSpotDailyDigests(
      { DB: db, TASK_QUEUE: queue, NOXSPOT_RESPONSE: service } as never,
      Date.parse("2026-09-01T00:00:00Z"),
    );

    expect(result).toEqual({ created: 1, skipped: 0, failed: 0 });
    expect(service.buildDailyDigestResponse).toHaveBeenCalledWith(
      "Storefront",
      "2026-08-31",
      [expect.objectContaining({ number: 31, submittedBy: "Ada" })],
      [expect.objectContaining({ number: 30, submittedBy: "Lin", resolution: expect.objectContaining({ number: 55 }) })],
      { filed: 1, solved: 1 },
    );
    expect(queue.send).toHaveBeenCalledWith(expect.objectContaining({ outboxId: "delivery-1" }));
    expect(statements.some(({ sql }) => sql.includes("source_id = ?"))).toBe(true);
    const filedQuery = statements.find(({ sql }) => sql.includes("COUNT(DISTINCT"));
    expect(filedQuery?.statement.args).toEqual([
      "site-1", "2026-08-31T00:00:00.000Z", "2026-09-01T00:00:00.000Z",
    ]);
    const issueQueries = statements.filter(({ sql }) => sql.includes("SELECT issue.number"));
    expect(issueQueries).toHaveLength(2);
    expect(issueQueries[0].statement.args).toEqual([
      7, "web", "site-1", "2026-08-31T00:00:00.000Z", "2026-09-01T00:00:00.000Z",
    ]);
    expect(issueQueries[1].statement.args).toEqual([
      "site-1", 7, "web", "2026-08-31T00:00:00.000Z", "2026-09-01T00:00:00.000Z", "site-1",
    ]);
  });
});
