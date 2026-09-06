import { describe, expect, it, vi } from "vitest";
import {
  localDateTime,
  previousPeriod,
  resolveDigestSlackDestination,
  runNoxCueDigests,
} from "../noxcue-digests.js";

describe("NoxCue daily digest periods", () => {
  it("uses the source timezone and the previous completed local day", () => {
    const instant = Date.parse("2026-08-29T16:45:00Z");
    expect(localDateTime(instant, "Asia/Kuala_Lumpur")).toEqual({
      period: "2026-08-30",
      minutes: 45,
    });
    expect(previousPeriod("2026-08-30")).toBe("2026-08-29");
  });

  it("handles month boundaries", () => {
    expect(previousPeriod("2026-03-01")).toBe("2026-02-28");
  });

  it("keeps each Slack channel paired with its own connection", () => {
    expect(resolveDigestSlackDestination({
      source_channel_id: "C-source",
      source_connection_id: null,
      project_channel_id: "C-project",
      project_connection_id: "connection-project",
      organization_channel_id: "C-org",
      organization_connection_id: "connection-org",
      fallback_channel_id: "C-fallback",
      fallback_connection_id: "connection-fallback",
    })).toEqual({ channelId: "C-project", connectionId: "connection-project" });
  });

  it("stages a digest containing only metrics selected for the source project", async () => {
    const statements = [];
    const prepare = (sql) => {
      const statement = {
        args: [],
        bind(...args) { this.args = args; return this; },
        async all() {
          if (sql.includes("FROM cue_sources source")) return { results: [{
            id: "source-1", org_id: 7, owner_id: "acme", project_id: "playnist", name: "Checkout",
            environment: "production",
            timezone: "Asia/Kuala_Lumpur", digest_time_local: "00:30",
            source_channel_id: "C123", source_connection_id: "connection-1",
            project_channel_id: null, project_connection_id: null,
            organization_channel_id: null, organization_connection_id: null,
            fallback_channel_id: null, fallback_connection_id: null,
          }] };
          if (sql.includes("FROM cue_daily_metrics")) return { results: [
            { period: "2026-07-30", metric_key: "users.new", value: 70, origin: "reported" },
            { period: "2026-08-28", metric_key: "users.new", value: 80, origin: "reported" },
            { period: "2026-08-29", metric_key: "users.new", value: 86, origin: "reported" },
            { period: "2026-08-29", metric_key: "users.total", value: 4210, origin: "reported" },
          ] };
          if (sql.includes("FROM cue_project_metric_settings")) return { results: [
            { metric_key: "users.new", enabled: 1 },
            { metric_key: "users.total", enabled: 0 },
          ] };
          return { results: [] };
        },
        async first() {
          if (sql.includes("FROM cue_digest_runs")) return null;
          if (sql.includes("INSERT INTO delivery_outbox")) return { id: "delivery-1", status: "pending" };
          return null;
        },
        async run() { return { success: true, meta: { changes: 1 } }; },
      };
      statements.push({ sql, statement });
      return statement;
    };
    const queue = { send: vi.fn(async () => undefined) };
    const service = { buildDigestResponse: vi.fn(async () => ({
      contract: "noxcue.response", version: 1, kind: "daily_digest",
      message: { text: "Daily health", blocks: [{ type: "section" }] },
    })) };
    const env = { DB: { prepare, batch: async () => [] }, TASK_QUEUE: queue, NOXCUE_RESPONSE: service };
    const result = await runNoxCueDigests(env, Date.parse("2026-08-29T16:45:00Z"));
    expect(result).toEqual({ created: 1, skipped: 0, failed: 0 });
    expect(service.buildDigestResponse).toHaveBeenCalledWith(
      "Checkout · Production",
      "2026-08-29",
      { "users.new": 86 },
      {
        "users.new": {
          yesterday: 80,
          average30d: 75,
          sampleDays: 2,
          history: [
            { period: "2026-07-30", value: 70 },
            { period: "2026-08-28", value: 80 },
            { period: "2026-08-29", value: 86 },
          ],
        },
      },
      {},
      { organizationId: 7, projectId: "playnist", sourceId: "source-1" },
    );
    expect(queue.send).toHaveBeenCalledWith(expect.objectContaining({ type: "deliver_slack", outboxId: "delivery-1" }));
    expect(statements.find(({ sql }) => sql.includes("FROM cue_sources source"))?.sql).toContain("project_slack_routes");
    expect(statements.find(({ sql }) => sql.includes("FROM cue_sources source"))?.sql).toContain("project_routing_settings");
    expect(statements.some(({ sql }) => sql.includes("INSERT OR IGNORE INTO cue_digest_runs"))).toBe(true);
  });
});
