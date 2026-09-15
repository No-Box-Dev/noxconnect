import { describe, expect, it } from "vitest";
import { onRequestGet, onRequestPut } from "../cues/github-issues";

function makeDb(repo: string | null = "playnist") {
  const writes: Array<{ sql: string; binds: unknown[] }> = [];
  return {
    writes,
    prepare(sql: string) {
      return {
        binds: [] as unknown[],
        bind(...values: unknown[]) { this.binds = values; return this; },
        async all() { return { results: [{
          id: "playnist", name: "Playnist", repo, enabled: 1,
          environments_json: '["production"]', comment_on_repeat: 0,
          repeat_interval_minutes: 360, open_incidents: 2,
        }] }; },
        async first() {
          if (sql.includes("SELECT installation_id")) return { installation_id: 42 };
          if (sql.includes("FROM projects project JOIN project_routing_settings")) return { id: "playnist", name: "Playnist", repo };
          if (sql.includes("JOIN cue_github_issue_settings")) return {
            id: "playnist", name: "Playnist", repo, enabled: 1,
            environments_json: '["production","staging"]', comment_on_repeat: 0,
            repeat_interval_minutes: 360, open_incidents: 0,
          };
          return null;
        },
        async run() { writes.push({ sql, binds: this.binds }); return { meta: { changes: 1 } }; },
      };
    },
  };
}

function context(db: ReturnType<typeof makeDb>, body?: unknown, isAdmin = true) {
  return {
    env: { DB: db }, data: { orgId: 7, orgLogin: "No-Box-Dev", projectId: "playnist", userLogin: "jasper", isAdmin },
    request: new Request("https://app.noxhere.com/api/cues/github-issues", {
      method: body === undefined ? "GET" : "PUT", headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  };
}

describe("project-scoped NoxCue GitHub routing API", () => {
  it("returns repository, environment, and incident state", async () => {
    const response = await onRequestGet(context(makeDb()) as never);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ githubConnected: true, projects: [{
      projectId: "playnist", repo: "playnist", environments: ["production"], openIncidents: 2,
    }] });
  });

  it("saves a bounded project configuration", async () => {
    const db = makeDb();
    const response = await onRequestPut(context(db, {
      projectId: "playnist", enabled: true, environments: ["production", "staging"],
      commentOnRepeat: false, repeatIntervalMinutes: 360,
    }) as never);
    expect(response.status).toBe(200);
    expect(db.writes).toHaveLength(1);
    expect(db.writes[0].binds).toContain('["production","staging"]');
  });

  it("rejects enabling a project without a repository and requires an admin", async () => {
    const input = { projectId: "playnist", enabled: true, environments: ["production"], commentOnRepeat: false, repeatIntervalMinutes: 360 };
    expect((await onRequestPut(context(makeDb(null), input) as never)).status).toBe(409);
    expect((await onRequestGet(context(makeDb(), undefined, false) as never)).status).toBe(403);
  });
});
