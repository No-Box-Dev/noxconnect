import { describe, expect, it, vi } from "vitest";
import {
  NOXCUE_APPLE_METRIC_KEYS,
  NOXCUE_USER_METRIC_KEYS,
  loadEnabledNoxCueMetricKeys,
  loadNoxCueProjectMetrics,
  saveNoxCueProjectMetrics,
  selectNoxCueDigestMetrics,
} from "../noxcue-project-metrics.js";

function statement(sql, handlers = {}) {
  return {
    sql,
    binds: [],
    bind(...values) { this.binds = values; return this; },
    all: handlers.all ?? (async () => ({ results: [] })),
    first: handlers.first ?? (async () => null),
  };
}

describe("NoxCue project metric settings", () => {
  it("reports registration and activity metric readiness independently", async () => {
    const db = {
      prepare(sql) {
        if (sql.includes("cue_metric_definitions")) return statement(sql, { all: async () => ({ results: [
          { key: "users.new", label: "New users", unit: "count", description: "New users", enabled: 1 },
          { key: "users.active.daily", label: "DAU", unit: "count", description: "Daily active", enabled: 0 },
        ] }) });
        return statement(sql, { first: async () => ({
          source_count: 1,
          enabled_source_count: 1,
          registration_last_received_at: "2026-08-29T10:00:00Z",
          activity_last_received_at: null,
        }) });
      },
    };
    const result = await loadNoxCueProjectMetrics(db, 2, "playnist");
    expect(result.metrics).toEqual([
      expect.objectContaining({ key: "users.new", enabled: true, active: true, lastEventAt: "2026-08-29T10:00:00Z" }),
      expect.objectContaining({ key: "users.active.daily", enabled: false, active: false, lastEventAt: null }),
    ]);
  });

  it("defaults all standard user metrics on until a project saves a selection", async () => {
    const db = { prepare: () => statement("settings", { all: async () => ({ results: [] }) }) };
    expect([...await loadEnabledNoxCueMetricKeys(db, 2, "playnist")]).toEqual([
      ...NOXCUE_USER_METRIC_KEYS,
      ...NOXCUE_APPLE_METRIC_KEYS,
    ]);
  });

  it("includes both outputs for enabled registered custom activity metrics", async () => {
    let call = 0;
    const db = { prepare: () => statement("settings", { all: async () => ({
      results: call++ === 0 ? [{ metric_key: "custom.journals.added" }] : [],
    }) }) };
    const enabled = await loadEnabledNoxCueMetricKeys(db, 2, "playnist", "source-1");
    expect(enabled).toContain("custom.journals.added");
    expect(enabled).toContain("custom.journals.added.per_user");
  });

  it("writes an explicit row for every supported metric", async () => {
    const captured = [];
    const db = {
      prepare: (sql) => statement(sql),
      batch: vi.fn(async (statements) => { captured.push(...statements); }),
    };
    await saveNoxCueProjectMetrics(db, 2, "playnist", ["users.new", "users.total"], "jasper");
    expect(captured).toHaveLength(NOXCUE_USER_METRIC_KEYS.length);
    expect(captured.find((row) => row.binds[2] === "users.new").binds[3]).toBe(1);
    expect(captured.find((row) => row.binds[2] === "users.active.daily").binds[3]).toBe(0);
  });

  it("filters the Slack report without deleting calculated history", () => {
    const digest = {
      metrics: { "users.new": 3, "users.total": 72, "users.active.daily": 7 },
      comparisons: { "users.new": { yesterday: 2 }, "users.total": { yesterday: 69 }, "users.active.daily": { yesterday: 8 } },
      derivedFromEvents: true,
    };
    const result = selectNoxCueDigestMetrics(digest, new Set(["users.new", "users.total"]));
    expect(result.metrics).toEqual({ "users.new": 3, "users.total": 72 });
    expect(digest.metrics["users.active.daily"]).toBe(7);
  });
});
