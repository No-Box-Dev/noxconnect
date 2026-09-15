import { describe, expect, it, vi } from "vitest";
import { onRequestGet } from "../integrations/status";

function statementFor(sql: string) {
  const statement = {
    bind: vi.fn(() => statement),
    first: vi.fn(async () => {
      if (sql.includes("FROM orgs")) return { installation_id: 42, bootstrapped_at: "2026-01-01", last_event_at: "2026-01-02" };
      if (sql.includes("FROM installations")) return { installation_id: 42, account_login: "acme", account_type: "Organization", health_status: null };
      if (sql.includes("FROM slack_settings")) return null;
      if (sql.includes("FROM config")) return null;
      return null;
    }),
  };
  return statement;
}

describe("GET /api/integrations/status", () => {
  it("returns centralized GitHub and Slack state without credentials", async () => {
    const context = {
      env: {
        DB: { prepare: vi.fn((sql: string) => statementFor(sql)) },
        GITHUB_APP_ID: "1",
        GITHUB_APP_PRIVATE_KEY: "private",
        SLACK_APP_ID: "A123",
        SLACK_CLIENT_ID: "client",
        SLACK_CLIENT_SECRET: "secret",
        SLACK_SIGNING_SECRET: "signing-secret",
      },
      data: { orgId: 7, orgLogin: "acme", projectId: "project-1", isAdmin: true },
    };

    const response = await onRequestGet(context as never);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.json() as {
      setup: Record<string, unknown>;
      features: Record<string, Record<string, unknown>>;
      github: Record<string, unknown>;
      slack: Record<string, unknown>;
    };
    expect(body.setup).toEqual({ ready: true, needsOnboarding: false, requiredConnection: "github" });
    expect(body.features.feed).toMatchObject({ state: "ready", requirements: ["github"] });
    expect(body.features.noxSpot).toMatchObject({ state: "ready", optionalConnections: ["slack"] });
    expect(body.features.noxCue).toMatchObject({ state: "blocked", prerequisitesReady: false });
    expect(body.github).toMatchObject({ connected: true, accountLogin: "acme", installationId: 42 });
    expect(body.slack).toMatchObject({ connected: false, configured: true });
    expect(JSON.stringify(body)).not.toContain("private");
    expect(JSON.stringify(body)).not.toContain("secret");
  });

  it("supports native onboarding before a project is selected", async () => {
    const prepare = vi.fn((sql: string) => statementFor(sql));
    const context = {
      env: {
        DB: { prepare },
        GITHUB_APP_ID: "1",
        GITHUB_APP_PRIVATE_KEY: "private",
      },
      data: { orgId: 7, orgLogin: "acme", isAdmin: true },
    };

    const response = await onRequestGet(context as never);
    expect(response.status).toBe(200);
    const body = await response.json() as { github: { connected: boolean } };
    expect(body.github.connected).toBe(true);

    const deliveryQuery = prepare.mock.calls
      .map(([sql]) => sql)
      .find((sql) => sql.includes("FROM delivery_outbox"));
    expect(deliveryQuery).not.toContain("project_id = ?");
  });
});
