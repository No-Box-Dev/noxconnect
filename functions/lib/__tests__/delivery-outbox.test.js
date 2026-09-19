import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../slack.js", () => ({
  resolveSlackInstall: vi.fn(),
  postSlackMessage: vi.fn(),
  actionableSlackError: vi.fn((error, fallback = "Check Slack, then try again.") => {
    const code = String(error?.code ?? error ?? "");
    return code.includes("not_in_channel") ? "Invite @NoxConnect to the channel, then try again." : fallback;
  }),
}));

import {
  deliverSlackOutbox,
  queueOutboxDelivery,
  recoverOutboxDeliveries,
  requeueBlockedForSite,
  stageSlackDelivery,
} from "../delivery-outbox.js";
import { postSlackMessage, resolveSlackInstall } from "../slack.js";

function db({ first = null, all = [] } = {}) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      const statement = {
        bind(...binds) { statement.binds = binds; return statement; },
        async first() { calls.push({ kind: "first", sql, binds: statement.binds }); return first; },
        async all() { calls.push({ kind: "all", sql, binds: statement.binds }); return { results: all }; },
        async run() { calls.push({ kind: "run", sql, binds: statement.binds }); return { success: true }; },
      };
      return statement;
    },
  };
}

describe("delivery outbox", () => {
  beforeEach(() => vi.clearAllMocks());

  it("stages an idempotent source/destination row", async () => {
    const database = db({ first: { id: "delivery-1", status: "pending" } });
    const result = await stageSlackDelivery(database, {
      orgId: 7, projectId: "project-1", source: "noxspot", sourceId: "capture-1", siteId: "site-1",
      connectionId: "conn-2", channelId: "C123", payload: { title: "Broken" },
    });
    expect(result).toEqual({ id: "delivery-1", status: "pending" });
    expect(database.calls[0].sql).toContain("ON CONFLICT(source, destination, source_id)");
    expect(database.calls[0].binds.slice(1, 5)).toEqual([7, "project-1", "noxspot", "capture-1"]);
    expect(database.calls[0].binds).toContain("conn-2");
  });

  it("normalizes an empty connection id so legacy routes use the default workspace", async () => {
    const database = db({ first: { id: "delivery-1", status: "pending" } });
    await stageSlackDelivery(database, {
      orgId: 7, projectId: "project-1", source: "noxspot", sourceId: "capture-2", siteId: "site-1",
      connectionId: "", channelId: "C123", payload: { title: "Broken" },
    });
    expect(database.calls[0].binds[6]).toBeNull();
  });

  it("blocks visibly instead of silently succeeding when Slack is disconnected", async () => {
    vi.mocked(resolveSlackInstall).mockResolvedValue(null);
    const outbox = {
      id: "delivery-1", org_id: 7, destination: "slack", channel_id: "C123",
      payload_json: JSON.stringify({ message: { text: "hello" } }),
    };
    let firstCall = 0;
    const database = db();
    database.prepare = (sql) => {
      const statement = {
        binds: [],
        bind(...binds) { statement.binds = binds; return statement; },
        async first() { firstCall += 1; return firstCall === 1 ? outbox : null; },
        async run() { database.calls.push({ kind: "run", sql, binds: statement.binds }); return { success: true }; },
      };
      return statement;
    };
    const result = await deliverSlackOutbox({ DB: database }, "delivery-1");
    expect(result).toEqual({ blocked: "slack_not_connected" });
    expect(database.calls.some((call) => call.binds?.[0] === "blocked_configuration")).toBe(true);
  });

  it("delivers a generic Slack payload exactly once", async () => {
    vi.mocked(resolveSlackInstall).mockResolvedValue({ botToken: "xoxb-test" });
    vi.mocked(postSlackMessage).mockResolvedValue({ ok: true, channel: "C123", ts: "1723456789.123456" });
    const outbox = {
      id: "delivery-1", org_id: 7, destination: "slack", channel_id: "C123",
      payload_json: JSON.stringify({ message: { text: "hello", client_msg_id: "stable-1" } }),
    };
    const database = db({ first: outbox });
    const result = await deliverSlackOutbox({ DB: database }, "delivery-1");
    expect(result).toEqual({ delivered: true, slackMessageTs: "1723456789.123456" });
    expect(postSlackMessage).toHaveBeenCalledWith("xoxb-test", "C123", { text: "hello", client_msg_id: "stable-1" });
    expect(database.calls.some((call) => call.sql.includes("status = 'delivered'"))).toBe(true);
    expect(database.calls.some((call) => call.binds?.[0] === "1723456789.123456")).toBe(true);
  });

  it("blocks a queued legacy NoxFeed social post instead of duplicating the release note", async () => {
    const outbox = {
      id: "delivery-post", org_id: 7, source: "posts", destination: "slack", channel_id: "C123",
      payload_json: JSON.stringify({ message: { text: "social post" } }),
    };
    const database = db({ first: outbox });

    const result = await deliverSlackOutbox({ DB: database }, "delivery-post");

    expect(result).toEqual({ blocked: "stream_consolidated" });
    expect(postSlackMessage).not.toHaveBeenCalled();
    expect(database.calls.some((call) => call.binds?.[0] === "delivery-post"
      && call.sql.includes("stream_consolidated"))).toBe(true);
  });

  it("does not mark a delivery complete without a matching Slack receipt", async () => {
    vi.mocked(resolveSlackInstall).mockResolvedValue({ botToken: "xoxb-test" });
    const outbox = {
      id: "delivery-1", org_id: 7, destination: "slack", channel_id: "C123",
      payload_json: JSON.stringify({ message: { text: "hello" } }),
    };
    const database = db({ first: outbox });
    vi.mocked(postSlackMessage).mockResolvedValueOnce({ ok: true, channel: "C999", ts: "1723456789.123456" });

    await expect(deliverSlackOutbox({ DB: database }, "delivery-1"))
      .rejects.toThrow("invalid or mismatched delivery receipt");
    expect(database.calls.some((call) => call.binds?.[0] === "retrying"
      && call.binds?.[1] === "invalid_slack_receipt")).toBe(true);
    expect(database.calls.some((call) => call.sql.includes("status = 'delivered'"))).toBe(false);
  });

  it("records transient failures for retry and blocks permanent configuration failures", async () => {
    vi.mocked(resolveSlackInstall).mockResolvedValue({ botToken: "xoxb-test" });
    const outbox = {
      id: "delivery-1", org_id: 7, destination: "slack", channel_id: "C123",
      payload_json: JSON.stringify({ message: { text: "hello" } }),
    };
    const transientDb = db({ first: outbox });
    vi.mocked(postSlackMessage).mockRejectedValueOnce(Object.assign(new Error("rate limited"), { code: "rate_limited" }));
    await expect(deliverSlackOutbox({ DB: transientDb }, "delivery-1")).rejects.toThrow("rate limited");
    expect(transientDb.calls.some((call) => call.sql.includes("status = ?") && call.binds?.[0] === "retrying")).toBe(true);

    const permanentDb = db({ first: outbox });
    vi.mocked(postSlackMessage).mockRejectedValueOnce(Object.assign(new Error("not in channel"), { code: "not_in_channel" }));
    expect(await deliverSlackOutbox({ DB: permanentDb }, "delivery-1")).toEqual({ blocked: "not_in_channel" });
    expect(permanentDb.calls.some((call) => call.binds?.[0] === "blocked_configuration")).toBe(true);
  });

  it("keeps a durable pending row when the queue binding is missing", async () => {
    const database = db();
    expect(await queueOutboxDelivery({ DB: database }, "delivery-1", "acme")).toBe(false);
    expect(database.calls[0].sql).toContain("status = 'pending'");
    expect(database.calls[0].binds).toContain("queue_binding_missing");
  });

  it("recovers stale and pending rows onto the queue", async () => {
    const send = vi.fn(async () => undefined);
    const database = db({ all: [{ id: "delivery-1", owner_id: "acme" }] });
    const result = await recoverOutboxDeliveries({ DB: database, TASK_QUEUE: { send } });
    expect(result).toEqual({ queued: 1 });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "deliver_slack", outboxId: "delivery-1" }));
    expect(database.calls.some((call) => call.sql.includes("'-15 minutes'"))).toBe(true);
  });

  it("requeues blocked site deliveries explicitly", async () => {
    const send = vi.fn(async () => undefined);
    const database = db({ all: [{ id: "delivery-1" }] });
    const result = await requeueBlockedForSite({ DB: database, TASK_QUEUE: { send } }, 7, "site-1");
    expect(result).toEqual({ queued: 1 });
    expect(database.calls[0].sql).toContain("blocked_configuration");
    expect(database.calls[0].sql).toContain("source = 'noxspot'");
    expect(send).toHaveBeenCalledOnce();
  });
});
