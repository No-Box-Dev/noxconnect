import { describe, expect, it, vi } from "vitest";

vi.mock("../slack/test.js", () => ({
  onRequestPost: vi.fn(async (context) => Response.json(await context.request.json())),
}));

import { signOAuthState } from "../../lib/slack.js";
import { onRequestGet as slackHandoff } from "../slack/oauth/handoff.ts";
import { onRequestGet as getRouting, onRequestPatch as patchRouting } from "../integrations/slack/routing.ts";
import { onRequestPost as testRoute } from "../integrations/slack/test.ts";

function dbWithSettings(settings = {}, options = {}) {
  const configRows = [...(options.configRows ?? [{ data: JSON.stringify(settings) }])];
  const db = {
    prepare: vi.fn((sql) => {
      const statement = {
        bind: vi.fn(() => statement),
        first: vi.fn(async () => sql.includes("SELECT data FROM config") ? (configRows.shift() ?? null) : null),
        all: vi.fn(async () => ({ results: [] })),
        run: vi.fn(async () => ({ success: true, meta: { changes: options.changes ?? 1 } })),
      };
      return statement;
    }),
    batch: vi.fn(async (statements) => {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    }),
  };
  return db;
}

describe("agent setup APIs", () => {
  it("turns a signed handoff into a cookie-setting Slack redirect", async () => {
    const payload = `nonce:7:alice:${Date.now()}`;
    const state = `${payload}.${await signOAuthState("secret", payload)}`;
    const response = await slackHandoff({
      request: new Request(`https://app.unticket.ai/api/slack/oauth/handoff?state=${encodeURIComponent(state)}`),
      env: { SLACK_CLIENT_ID: "client", SLACK_CLIENT_SECRET: "secret" },
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toContain("slack.com/oauth/v2/authorize");
    expect(response.headers.get("Set-Cookie")).toContain(`ut_slack_state=${state}`);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("rejects an expired handoff", async () => {
    const payload = `nonce:7:alice:${Date.now() - 600_001}`;
    const state = `${payload}.${await signOAuthState("secret", payload)}`;
    const response = await slackHandoff({
      request: new Request(`https://app.unticket.ai/api/slack/oauth/handoff?state=${encodeURIComponent(state)}`),
      env: { SLACK_CLIENT_ID: "client", SLACK_CLIENT_SECRET: "secret" },
    });
    expect(response.status).toBe(400);
  });

  it("reads canonical Slack routes", async () => {
    const response = await getRouting({
      env: { DB: dbWithSettings({ slack: { fallbackChannelId: "C1", postsChannelId: "C2" } }) },
      data: { orgId: 7, orgLogin: "acme", isAdmin: true },
    });
    expect(await response.json()).toMatchObject({ routes: { fallback: "C1", noxfeed_posts: "C2", noxcue: null } });
  });

  it("rejects unknown route names without mutating config", async () => {
    const DB = dbWithSettings({});
    const response = await patchRouting({
      request: new Request("https://app.unticket.ai/api/integrations/slack/routing", {
        method: "PATCH", body: JSON.stringify({ routes: { surprise: "C1" } }),
      }),
      env: { DB },
      data: { orgId: 7, orgLogin: "acme", isAdmin: true },
      params: {},
    });
    expect(response.status).toBe(400);
    expect(DB.prepare).not.toHaveBeenCalled();
  });

  it("merges a routing patch with compare-and-swap and retires the combined NoxFeed route", async () => {
    const DB = dbWithSettings({ theme: "dark", slack: { noxFeedChannelId: "" } });
    const response = await patchRouting({
      request: new Request("https://app.unticket.ai/api/integrations/slack/routing", {
        method: "PATCH", body: JSON.stringify({ routes: { noxfeed_posts: null } }),
      }),
      env: { DB },
      data: { orgId: 7, orgLogin: "acme", isAdmin: true },
      params: {},
    });
    expect(response.status).toBe(200);
    expect(DB.batch).toHaveBeenCalledOnce();
    expect(DB.batch.mock.calls[0][0]).toHaveLength(7);
    const updateCall = DB.prepare.mock.calls.find(([sql]) => sql.includes("WHERE org_id = ? AND key = ? AND data = ?"));
    expect(updateCall).toBeTruthy();
    const dependentSql = DB.prepare.mock.calls
      .map(([sql]) => sql)
      .filter((sql) => sql.includes("UPDATE delivery_outbox"));
    expect(dependentSql).toHaveLength(6);
    expect(dependentSql.every((sql) => sql.includes("config_guard.key = ?") && sql.includes("config_guard.data = ?"))).toBe(true);
    const updateStatement = DB.prepare.mock.results[DB.prepare.mock.calls.indexOf(updateCall)].value;
    const serialized = updateStatement.bind.mock.calls[0][0];
    expect(JSON.parse(serialized)).toEqual({ theme: "dark", slack: { postsChannelId: "" } });
  });

  it("treats an identical compare-and-swap race as idempotent success", async () => {
    const oldSettings = { theme: "dark", slack: {} };
    const desiredSettings = { theme: "dark", slack: { postsChannelId: "" } };
    const DB = dbWithSettings(oldSettings, {
      changes: 0,
      configRows: [{ data: JSON.stringify(oldSettings) }, { data: JSON.stringify(desiredSettings) }],
    });
    const response = await patchRouting({
      request: new Request("https://app.unticket.ai/api/integrations/slack/routing", {
        method: "PATCH", body: JSON.stringify({ routes: { noxfeed_posts: null } }),
      }),
      env: { DB }, data: { orgId: 7, orgLogin: "acme", isAdmin: true }, params: {},
    });
    expect(response.status).toBe(200);
  });

  it("returns 409 when compare-and-swap loses to a different value", async () => {
    const oldSettings = { theme: "dark", slack: {} };
    const DB = dbWithSettings(oldSettings, {
      changes: 0,
      configRows: [{ data: JSON.stringify(oldSettings) }, { data: JSON.stringify({ theme: "light", slack: {} }) }],
    });
    const response = await patchRouting({
      request: new Request("https://app.unticket.ai/api/integrations/slack/routing", {
        method: "PATCH", body: JSON.stringify({ routes: { noxfeed_posts: null } }),
      }),
      env: { DB }, data: { orgId: 7, orgLogin: "acme", isAdmin: true }, params: {},
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Settings changed concurrently; fetch routing and retry" });
  });

  it.each([
    ["fallback", "fallback"],
    ["noxcue", "noxcue"],
    ["noxticket", "noxticket"],
    ["noxfeed_posts", "noxfeed_posts"],
    ["noxfeed_release_notes", "noxfeed_release_notes"],
    ["noxfeed_daily_summary", "noxfeed_daily_summary"],
  ])("delegates the %s route using the legacy handler's accepted kind", async (route, kind) => {
    const response = await testRoute({
      request: new Request("https://app.unticket.ai/api/integrations/slack/test", {
        method: "POST", body: JSON.stringify({ route, channelId: "C1" }),
      }),
      env: { DB: dbWithSettings({}) },
      data: { orgId: 7, orgLogin: "acme", isAdmin: true },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ channelId: "C1", kind });
  });
});
