import { beforeEach, describe, expect, it, vi } from "vitest";

const { stageSlackDelivery, queueOutboxDelivery, resolveSlackChannels } = vi.hoisted(() => ({
  stageSlackDelivery: vi.fn(),
  queueOutboxDelivery: vi.fn(),
  resolveSlackChannels: vi.fn(),
}));

vi.mock("../../../functions/lib/delivery-outbox.js", () => ({ stageSlackDelivery, queueOutboxDelivery }));
vi.mock("../../../functions/lib/slack.js", () => ({
  resolveSlackChannels,
  resolveSlackRoute: (channels) => channels.fallbackChannelId || "",
  resolveSlackConnectionId: (channels) => channels.fallbackConnectionId || "",
}));

import { runOperationalAlerts } from "../operational-alerts.js";

function database({ failures = [], deliveries = [] } = {}) {
  return {
    prepare(sql) {
      return {
        bind() { return this; },
        async all() {
          return { results: sql.includes("FROM op_failures") ? failures : deliveries };
        },
      };
    },
  };
}

describe("operational Slack alerts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveSlackChannels.mockResolvedValue({ fallbackChannelId: "C-OPS", fallbackConnectionId: "conn-1" });
    stageSlackDelivery.mockResolvedValue({ id: "alert-1", status: "pending" });
    queueOutboxDelivery.mockResolvedValue(true);
  });

  it("stages a retry-safe alert without putting credentials or URLs in Slack", async () => {
    const db = database({ failures: [{
      org_id: 7,
      org_login: "acme",
      kind: "operation_failure",
      source_id: "op_failure:42",
      subject: "task:sync_repo",
      detail: "request failed with ghp_secret at https://api.github.com/repos/acme/private\nstack",
      occurred_at: "2026-09-09 08:00:00",
    }] });

    expect(await runOperationalAlerts({ DB: db, TASK_QUEUE: {} })).toEqual({ candidates: 1, queued: 1, skipped: 0 });
    expect(stageSlackDelivery).toHaveBeenCalledWith(db, expect.objectContaining({
      source: "operations",
      sourceId: "op_failure:42",
      connectionId: "conn-1",
      channelId: "C-OPS",
    }));
    const payload = stageSlackDelivery.mock.calls[0][1].payload;
    expect(JSON.stringify(payload)).toContain("[credential removed]");
    expect(JSON.stringify(payload)).toContain("[url removed]");
    expect(JSON.stringify(payload)).not.toContain("ghp_secret");
    expect(queueOutboxDelivery).toHaveBeenCalledWith(expect.anything(), "alert-1", "acme");
  });

  it("records an unroutable alert in structured logs instead of throwing", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    resolveSlackChannels.mockResolvedValue({});
    const db = database({ deliveries: [{
      org_id: 7,
      org_login: "acme",
      kind: "delivery_failure",
      source_id: "delivery_failure:d-1",
      subject: "noxspot",
      detail: "channel_not_found",
      occurred_at: "2026-09-09T08:00:00Z",
    }] });

    expect(await runOperationalAlerts({ DB: db })).toEqual({ candidates: 1, queued: 0, skipped: 1 });
    expect(stageSlackDelivery).not.toHaveBeenCalled();
    expect(JSON.parse(warning.mock.calls[0][0])).toMatchObject({ event: "operational_alert_unroutable", orgId: 7 });
    warning.mockRestore();
  });
});
