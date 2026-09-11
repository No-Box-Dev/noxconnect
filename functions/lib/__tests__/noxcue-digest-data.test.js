import { describe, expect, it } from "vitest";
import { completedPeriodAt, summarizeNoxCueDigestRows } from "../noxcue-digest-data.js";

describe("NoxCue digest history", () => {
  it("selects the previous completed day in the source timezone", () => {
    expect(completedPeriodAt("Asia/Kuala_Lumpur", new Date("2026-08-29T16:30:00Z")))
      .toBe("2026-08-29");
  });
  it("compares the current value to the exact previous day and preceding 30 stored days", () => {
    const summary = summarizeNoxCueDigestRows([
      { period: "2026-07-30", metric_key: "users.new", value: 4, origin: "reported" },
      { period: "2026-08-27", metric_key: "users.new", value: 8, origin: "reported" },
      { period: "2026-08-28", metric_key: "users.new", value: 10, origin: "reported" },
      { period: "2026-08-29", metric_key: "users.new", value: 12, origin: "reported" },
      { period: "2026-08-29", metric_key: "users.stickiness.dau_mau", value: 0.25, origin: "calculated" },
    ], "2026-08-29");

    expect(summary).toEqual({
      metrics: { "users.new": 12, "users.stickiness.dau_mau": 0.25 },
      comparisons: {
        "users.new": {
          yesterday: 10,
          average30d: 22 / 3,
          sampleDays: 3,
          history: [
            { period: "2026-07-30", value: 4 },
            { period: "2026-08-27", value: 8 },
            { period: "2026-08-28", value: 10 },
            { period: "2026-08-29", value: 12 },
          ],
        },
        "users.stickiness.dau_mau": {
          yesterday: null,
          average30d: null,
          sampleDays: 0,
          history: [{ period: "2026-08-29", value: 0.25 }],
        },
      },
      hasData: true,
      hasReportedData: true,
    });
  });

  it("derives the standard user suite from closed registration and activity facts", async () => {
    const periods = [
      { period: "2026-08-27", new_users: 2, total_users: 70, daily_active: 10, weekly_active: 30, monthly_active: 50 },
      { period: "2026-08-28", new_users: 3, total_users: 73, daily_active: 12, weekly_active: 32, monthly_active: 52 },
      { period: "2026-08-29", new_users: 1, total_users: 74, daily_active: 13, weekly_active: 34, monthly_active: 55 },
    ];
    const db = {
      prepare: () => ({
        bind() { return this; },
        async all() { return { results: periods }; },
      }),
    };
    const { loadNoxCueDigestData } = await import("../noxcue-digest-data.js");
    const summary = await loadNoxCueDigestData(db, "source-1", "2026-08-29");
    expect(summary.derivedFromEvents).toBe(true);
    expect(summary.metrics).toMatchObject({
      "users.new": 1,
      "users.total": 74,
      "users.active.daily": 13,
      "users.active.weekly": 34,
      "users.active.monthly": 55,
      "users.stickiness.dau_mau": 13 / 55,
    });
    expect(summary.comparisons["users.new"]).toEqual({
      yesterday: 3,
      average30d: 2.5,
      sampleDays: 2,
      history: [
        { period: "2026-08-27", value: 2 },
        { period: "2026-08-28", value: 3 },
        { period: "2026-08-29", value: 1 },
      ],
    });
  });

  it("derives daily custom activity counts and daily counts per registered user", async () => {
    const db = {
      prepare(sql) {
        return {
          bind() { return this; },
          async all() {
            if (sql.includes("cue_custom_metrics")) return { results: [
              { period: "2026-08-27", metric_key: "custom.journals.added", label: "Journals added", daily_events: 2, total_users: 70 },
              { period: "2026-08-28", metric_key: "custom.journals.added", label: "Journals added", daily_events: 4, total_users: 72 },
              { period: "2026-08-29", metric_key: "custom.journals.added", label: "Journals added", daily_events: 6, total_users: 74 },
            ] };
            return { results: [
              { period: "2026-08-27", new_users: 1, total_users: 70, daily_active: 1, weekly_active: 1, monthly_active: 1 },
              { period: "2026-08-28", new_users: 2, total_users: 72, daily_active: 1, weekly_active: 1, monthly_active: 1 },
              { period: "2026-08-29", new_users: 2, total_users: 74, daily_active: 1, weekly_active: 1, monthly_active: 1 },
            ] };
          },
        };
      },
    };
    const { loadNoxCueDigestData } = await import("../noxcue-digest-data.js");
    const summary = await loadNoxCueDigestData(db, "source-1", "2026-08-29");
    expect(summary.metrics["custom.journals.added"]).toBe(6);
    expect(summary.metrics["custom.journals.added.per_user"]).toBeCloseTo(6 / 74);
    expect(summary.metricLabels).toEqual({
      "custom.journals.added": "Journals added",
      "custom.journals.added.per_user": "Journals added / registered user",
    });
    expect(summary.comparisons["custom.journals.added"]).toMatchObject({ yesterday: 4, average30d: 3 });
  });

  it("merges stored Apple reports with event-derived user metrics", async () => {
    const db = {
      prepare(sql) {
        return {
          bind() { return this; },
          async all() {
            if (sql.includes("FROM cue_daily_metrics")) return { results: [
              { period: "2026-08-29", metric_key: "apple.downloads.first_time", value: 12, origin: "reported" },
              { period: "2026-08-29", metric_key: "apple.sessions", value: 90, origin: "reported" },
            ] };
            if (sql.includes("cue_custom_metrics")) return { results: [] };
            return { results: [{
              period: "2026-08-29", new_users: 3, total_users: 80,
              daily_active: 10, weekly_active: 30, monthly_active: 50,
            }] };
          },
        };
      },
    };
    const { loadNoxCueDigestData } = await import("../noxcue-digest-data.js");
    const summary = await loadNoxCueDigestData(db, "source-1", "2026-08-29");
    expect(summary.metrics).toMatchObject({
      "users.new": 3,
      "apple.downloads.first_time": 12,
      "apple.sessions": 90,
    });
    expect(summary.comparisons["apple.sessions"].history).toEqual([{ period: "2026-08-29", value: 90 }]);
  });

  it("does not overwrite imported Apple provenance when persisting derived metrics", async () => {
    const statements = [];
    const db = {
      prepare(sql) {
        return { sql, bind(...values) { this.values = values; return this; } };
      },
      async batch(items) { statements.push(...items); },
    };
    const { storeNoxCueDerivedMetrics } = await import("../noxcue-digest-data.js");
    await storeNoxCueDerivedMetrics(db, 7, "source-1", "2026-08-29", {
      "users.new": 3,
      "apple.sessions": 90,
    });
    expect(statements).toHaveLength(1);
    expect(statements[0].values).toContain("users.new");
    expect(statements[0].values).not.toContain("apple.sessions");
  });

  it("does not treat missing days as zero", () => {
    const summary = summarizeNoxCueDigestRows([
      { period: "2026-08-20", metric_key: "users.active.daily", value: 20, origin: "reported" },
      { period: "2026-08-29", metric_key: "users.active.daily", value: 30, origin: "reported" },
    ], "2026-08-29");
    expect(summary.comparisons["users.active.daily"]).toEqual({
      yesterday: null,
      average30d: 20,
      sampleDays: 1,
      history: [
        { period: "2026-08-20", value: 20 },
        { period: "2026-08-29", value: 30 },
      ],
    });
  });
});
