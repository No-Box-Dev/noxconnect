import { describe, expect, it } from "vitest";
import { onRequestGet, onRequestPost } from "../cues/sources";
import { onRequestPut } from "../cues/sources/[id]";

const sourceInput = {
  name: "Playnist",
  environment: "production",
  enabled: true,
  alertsEnabled: true,
  projectId: "playnist",
  timezone: "UTC",
  digestEnabled: true,
  digestTimeLocal: "03:30",
  slackChannelId: null,
  slackConnectionId: null,
};

function makeDb(projects = [{ id: "playnist", name: "Playnist", repo: "playnist" }]) {
  const writes: Array<{ sql: string; binds: unknown[] }> = [];
  return {
    writes,
    prepare(sql: string) {
      const statement = {
        binds: [] as unknown[],
        bind(...values: unknown[]) { this.binds = values; return this; },
        async all() {
          if (sql.includes("FROM cue_sources source")) return { results: [{
            id: "source-1", name: "Playnist", environment: "production", project_id: "playnist", project_name: "Playnist",
            enabled: 1, alerts_enabled: 1, timezone: "UTC", digest_enabled: 1, digest_time_local: "03:30",
            slack_channel_id: null, slack_connection_id: null,
            effective_slack_channel_id: "C123", effective_slack_connection_id: "conn-1",
            slack_route_level: "project", last_registration_at: "2026-08-30T01:00:00Z",
            last_activity_at: "2026-08-30T01:00:00Z", created_at: "2026-08-29T00:00:00Z",
          }] };
          if (sql.includes("FROM cue_source_keys")) return { results: [] };
          if (sql.includes("FROM projects project")) return { results: projects };
          return { results: [] };
        },
        async first() {
          if (sql.includes("SELECT source.environment")) return { environment: "production", project_id: "playnist", has_events: 0 };
          return null;
        },
        async run() { writes.push({ sql, binds: this.binds }); return { success: true, meta: { changes: 1 } }; },
      };
      return statement;
    },
  };
}

function context(db: ReturnType<typeof makeDb>, method: "GET" | "POST" | "PUT", body?: unknown, projectId: string | null = "playnist") {
  return {
    env: { DB: db },
    data: { orgId: 7, orgLogin: "No-Box-Dev", projectId, userLogin: "jasper", isAdmin: true },
    params: { id: "source-1" },
    request: new Request("https://app.noxhere.com/api/cues/sources", {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  };
}

describe("NoxCue source onboarding API", () => {
  it("returns the effective Slack route and real user-event confirmation", async () => {
    const response = await onRequestGet(context(makeDb(), "GET") as never);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      sources: [{
        id: "source-1",
        effectiveSlackChannelId: "C123",
        slackRouteLevel: "project",
        lastRegistrationAt: "2026-08-30T01:00:00Z",
        lastActivityAt: "2026-08-30T01:00:00Z",
      }],
    });
  });

  it("lists all organization sources when project scope is omitted", async () => {
    const response = await onRequestGet(context(makeDb(), "GET", undefined, null) as never);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ sources: [{ id: "source-1", projectId: "playnist" }] });
  });

  it("links the authenticated project", async () => {
    const db = makeDb();
    const response = await onRequestPost(context(db, "POST", sourceInput) as never);
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ projectId: "playnist" });
    expect(db.writes.find(({ sql }) => sql.includes("INSERT INTO cue_sources"))?.binds[3]).toBe("playnist");
  });

  it("accepts the resource project in the body for an organization-wide create", async () => {
    const db = makeDb();
    const response = await onRequestPost(context(db, "POST", sourceInput, null) as never);
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ projectId: "playnist" });
  });

  it("uses the authenticated project when several are available", async () => {
    const db = makeDb([
      { id: "playnist", name: "Playnist", repo: "playnist" },
      { id: "noxconnect", name: "NoxConnect", repo: "noxconnect" },
    ]);
    const response = await onRequestPost(context(db, "POST", sourceInput) as never);
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ projectId: "playnist" });
  });

  it("keeps the authenticated project attached when source settings are edited", async () => {
    const db = makeDb();
    const response = await onRequestPut(context(db, "PUT", sourceInput) as never);
    expect(response.status).toBe(200);
    expect(db.writes.find(({ sql }) => sql.includes("UPDATE cue_sources"))?.binds[2]).toBe("playnist");
  });
});
