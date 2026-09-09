import { describe, expect, it } from "vitest";
import { onRequestGet, onRequestPut } from "../cues/projects/[projectId]/metrics";

function makeDb() {
  const writes: Array<{ sql: string; binds: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      return {
        sql,
        binds: [] as unknown[],
        bind(...values: unknown[]) { this.binds = values; return this; },
        async first() {
          if (sql.includes("FROM projects")) return { id: "playnist", name: "Playnist" };
          return {
            source_count: 1,
            enabled_source_count: 1,
            registration_last_received_at: "2026-08-29T10:00:00Z",
            activity_last_received_at: "2026-08-29T11:00:00Z",
          };
        },
        async all() {
          if (sql.includes("cue_metric_definitions")) return { results: [
            { key: "users.new", label: "New users", unit: "count", description: "New users", enabled: 1 },
          ] };
          return { results: [] };
        },
      };
    },
    async batch(statements: Array<{ sql: string; binds: unknown[] }>) {
      writes.push(...statements);
      return statements.map(() => ({ meta: { changes: 1 } }));
    },
    writes,
  };
  return db;
}

function context(
  db: ReturnType<typeof makeDb>,
  body?: unknown,
  isAdmin = true,
  authType?: string,
) {
  return {
    env: { DB: db },
    data: { orgId: 2, orgLogin: "No-Box-Dev", userLogin: "jasper", isAdmin, auth: authType ? { type: authType } : undefined },
    params: { projectId: "playnist" },
    request: new Request("https://app.noxhere.com/api/cues/projects/playnist/metrics", {
      method: body === undefined ? "GET" : "PUT",
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  };
}

describe("project-scoped NoxCue metric API", () => {
  it("returns active state for the selected project", async () => {
    const response = await onRequestGet(context(makeDb()) as never);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expect.objectContaining({
      project: { id: "playnist", name: "Playnist" },
      metrics: [expect.objectContaining({ key: "users.new", active: true })],
    }));
  });

  it("saves the complete project selection", async () => {
    const db = makeDb();
    const response = await onRequestPut(context(db, { enabledMetricKeys: ["users.new", "users.total"] }) as never);
    expect(response.status).toBe(200);
    expect(db.writes).toHaveLength(6);
    expect(db.writes.every((write) => write.binds[1] === "playnist")).toBe(true);
  });

  it("requires at least one selected metric and an admin", async () => {
    expect((await onRequestPut(context(makeDb(), { enabledMetricKeys: [] }) as never)).status).toBe(400);
    expect((await onRequestPut(context(makeDb(), { enabledMetricKeys: ["users.new", "users.new"] }) as never)).status).toBe(400);
    expect((await onRequestGet(context(makeDb(), undefined, false) as never)).status).toBe(403);
  });

  it("allows a middleware-scoped API token to read without granting mutation access", async () => {
    expect((await onRequestGet(context(makeDb(), undefined, false, "api_token") as never)).status).toBe(200);
    expect((await onRequestPut(context(makeDb(), { enabledMetricKeys: ["users.new"] }, false, "api_token") as never)).status).toBe(403);
  });
});
