import { describe, expect, it } from "vitest";
import { onRequestGet } from "../spots/sites";

function context(projectId: string | null) {
  const calls: Array<{ sql: string; binds: unknown[] }> = [];
  const DB = {
    prepare(sql: string) {
      const statement = {
        binds: [] as unknown[],
        bind(...binds: unknown[]) { statement.binds = binds; return statement; },
        async all() { calls.push({ sql, binds: statement.binds }); return { results: [] }; },
      };
      return statement;
    },
  };
  return {
    calls,
    ctx: { env: { DB }, data: { orgId: 7, projectId } },
  };
}

describe("NoxSpot optional project scope", () => {
  it("uses organization scope when no project is selected", async () => {
    const { calls, ctx } = context(null);
    expect((await onRequestGet(ctx as never)).status).toBe(200);
    expect(calls[0].sql).not.toContain("site.project_id = ?");
    expect(calls[0].binds).toEqual([7]);
  });

  it("narrows the same collection when a project is selected", async () => {
    const { calls, ctx } = context("project-1");
    expect((await onRequestGet(ctx as never)).status).toBe(200);
    expect(calls[0].sql).toContain("site.project_id = ?");
    expect(calls[0].binds).toEqual([7, "project-1"]);
  });
});
