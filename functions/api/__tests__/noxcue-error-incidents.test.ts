import { describe, expect, it } from "vitest";
import { onRequestPut } from "../cues/errors/[sourceId]/[fingerprint]";

function context(status: string, isAdmin = true) {
  const writes: Array<{ sql: string; binds: unknown[] }> = [];
  const db = { prepare(sql: string) { const statement = {
    bind(...binds: unknown[]) { writes.push({ sql, binds }); return statement; },
    async run() { return { meta: { changes: 1 } }; },
  }; return statement; } };
  return {
    context: {
      env: { DB: db }, data: { orgId: 7, userLogin: "jasper", isAdmin },
      params: { sourceId: "source-1", fingerprint: "browser:signup:auth_503" },
      request: new Request("https://app.noxhere.com/api/v1/cues/errors/source-1/fingerprint", {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }),
      }),
    },
    writes,
  };
}

describe("NoxCue explicit error incident state", () => {
  it("records a human acknowledgement without changing the detection", async () => {
    const fixture = context("acknowledged");
    const response = await onRequestPut(fixture.context as never);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "acknowledged" });
    expect(fixture.writes[0]?.binds).toContain("jasper");
    expect(fixture.writes[0]?.binds).toContain("browser:signup:auth_503");
  });

  it("rejects invalid state and non-admin mutation", async () => {
    expect((await onRequestPut(context("fixed").context as never)).status).toBe(400);
    expect((await onRequestPut(context("resolved", false).context as never)).status).toBe(403);
  });
});
