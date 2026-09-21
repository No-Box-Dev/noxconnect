import { describe, expect, it } from "vitest";
import { onRequestGet } from "../cues/metrics";

describe("NoxCue daily custom metric history", () => {
  it("uses per-day activity and returns explicit error incident state", async () => {
    const queries: string[] = [];
    const db = { prepare(sql: string) { queries.push(sql); const statement = {
      bind() { return statement; },
      async first() { return { id: "11111111-1111-4111-8111-111111111111" }; },
      async all() {
        if (sql.includes("WITH RECURSIVE periods")) return { results: [{
          period: "2026-09-09", metric_key: "custom.journals.added", label: "Journals added",
          total_events: 4, total_users: 2, updated_at: "2026-09-09T20:00:00Z",
        }] };
        if (sql.includes("FROM cue_error_groups")) return { results: [{
          fingerprint: "server:signup:auth_503", title: "Signup failed", occurrence_count: 2,
          first_seen_at: "2026-09-09T18:00:00Z", last_seen_at: "2026-09-09T19:00:00Z",
          affected_user_count: 2, grouping_kind: "inferred", first_release: "release-a", last_release: "release-b",
          sample_json: JSON.stringify({ error: { message: "Provider unavailable", stack: "at signup" } }),
          status: "acknowledged", acknowledged_at: "2026-09-09T19:30:00Z", acknowledged_by: "jasper",
        }] };
        return { results: [] };
      },
    }; return statement; } };
    const response = await onRequestGet({
      env: { DB: db }, data: { orgId: 7, isAdmin: true },
      request: new Request("https://app.noxhere.com/api/cues/metrics?sourceId=11111111-1111-4111-8111-111111111111&days=1"),
    } as never);
    const body = await response.json() as { days: Array<{ metrics: Record<string, { value: number }> }>; errorGroups: Array<Record<string, unknown>> };
    const activitySql = queries.find((sql) => sql.includes("WITH RECURSIVE periods")) ?? "";
    expect(activitySql).toContain("activity.period = periods.period");
    expect(activitySql).not.toContain("activity.period <= periods.period");
    expect(body.days[0]?.metrics["custom.journals.added"].value).toBe(4);
    expect(body.days[0]?.metrics["custom.journals.added.per_user"].value).toBe(2);
    expect(body.errorGroups[0]).toMatchObject({
      status: "acknowledged", acknowledgedBy: "jasper", affectedUserCount: 2,
      groupingKind: "inferred", firstRelease: "release-a", lastRelease: "release-b",
      sample: { error: { message: "Provider unavailable", stack: "at signup" } },
    });
    expect(queries.find((sql) => sql.includes("FROM cue_error_groups"))).toContain("cue_error_group_users");
  });

  it("returns null for a corrupt legacy error sample instead of failing the dashboard", async () => {
    const db = { prepare(sql: string) { const statement = {
      bind() { return statement; },
      async first() { return { id: "11111111-1111-4111-8111-111111111111" }; },
      async all() { return sql.includes("FROM cue_error_groups")
        ? { results: [{ fingerprint: "legacy", title: "Legacy", occurrence_count: 1, sample_json: "{" }] }
        : { results: [] }; },
    }; return statement; } };
    const response = await onRequestGet({
      env: { DB: db }, data: { orgId: 7, isAdmin: true },
      request: new Request("https://app.noxhere.com/api/cues/metrics?sourceId=11111111-1111-4111-8111-111111111111&days=1"),
    } as never);
    const body = await response.json() as { errorGroups: Array<{ sample: unknown }> };
    expect(body.errorGroups[0]?.sample).toBeNull();
  });
});
