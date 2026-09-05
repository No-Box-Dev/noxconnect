import { describe, expect, it, vi } from "vitest";
import { onRequestGet as listServices } from "../v1/services/index";
import { onRequestGet as getService } from "../v1/services/[service]";
import { onRequestGet as getSetup } from "../v1/services/[service]/setup";
import { onRequestGet as getHealth } from "../v1/services/[service]/health";

interface CapabilityBody {
  apiVersion: number;
  organization: { login: string };
  services: Array<{
    id: string;
    kind: string;
    focus: string;
    enabled: boolean;
    setup: {
      state: string;
      blockers: Array<{ type: string; provider: string; state: string }>;
      sections: Array<{ id: string }>;
    };
    capabilities: Array<{
      id: string;
      state: string;
      operations: Array<{ id: string; method: string; path: string; authentication: string }>;
    }>;
  }>;
}

function statementFor(sql: string) {
  const statement = {
    bind: vi.fn(() => statement),
    first: vi.fn(async () => {
      if (sql.includes("FROM orgs")) {
        return { installation_id: 42, bootstrapped_at: "2026-01-01", last_event_at: "2026-01-02" };
      }
      if (sql.includes("FROM installations")) {
        return { installation_id: 42, account_login: "acme", account_type: "Organization", health_status: null };
      }
      if (sql.includes("FROM slack_connections")) return null;
      if (sql.includes("FROM slack_settings")) return null;
      if (sql.includes("FROM config")) {
        return { data: JSON.stringify({ apps: { noxspot: false } }) };
      }
      return null;
    }),
  };
  return statement;
}

function context(service = "noxconnect") {
  return {
    request: new Request(`https://app.unticket.ai/api/v1/services/${service}`),
    params: { service },
    env: {
      DB: { prepare: vi.fn((sql: string) => statementFor(sql)) },
      GITHUB_APP_ID: "1",
      GITHUB_APP_PRIVATE_KEY: "private",
      SLACK_CLIENT_ID: "client",
      SLACK_CLIENT_SECRET: "secret",
      SLACK_SIGNING_SECRET: "signing-secret",
    },
    data: { orgId: 7, orgLogin: "acme", userLogin: "alice", isAdmin: true },
  };
}

describe("Nox service capabilities API", () => {
  it("describes the foundation and every product service without credentials", async () => {
    const response = await listServices(context() as never);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");

    const body = await response.json() as CapabilityBody;
    expect(body.apiVersion).toBe(1);
    expect(body.organization).toEqual({ login: "acme" });
    expect(body.services.map((service: { id: string }) => service.id)).toEqual([
      "noxconnect", "noxticket", "noxfeed", "noxspot", "noxcue",
    ]);

    const noxconnect = body.services[0];
    expect(noxconnect).toMatchObject({
      kind: "foundation",
      focus: "Connections and shared workspace control",
      enabled: true,
      setup: { state: "ready" },
    });
    expect(noxconnect.capabilities.map((capability: { id: string }) => capability.id)).toContain("connections");

    const noxspot = body.services.find((service: { id: string }) => service.id === "noxspot");
    expect(noxspot).toBeDefined();
    if (!noxspot) throw new Error("NoxSpot missing from service catalog");
    expect(noxspot.setup.state).toBe("disabled");
    expect(noxspot.capabilities.every((capability: { state: string }) => capability.state === "disabled")).toBe(true);

    const noxcue = body.services.find((service: { id: string }) => service.id === "noxcue");
    expect(noxcue).toBeDefined();
    if (!noxcue) throw new Error("NoxCue missing from service catalog");
    expect(noxcue.setup).toMatchObject({
      state: "needs_setup",
      blockers: [{ type: "connection", provider: "slack", state: "disconnected" }],
    });
    expect(JSON.stringify(body)).not.toContain("private");
    expect(JSON.stringify(body)).not.toContain("signing-secret");
    for (const service of body.services) {
      for (const capability of service.capabilities) {
        expect(capability.operations.length).toBeGreaterThan(0);
        expect(capability.operations.every((operation) => operation.id && operation.method && operation.path && operation.authentication)).toBe(true);
      }
    }
  });

  it("returns one service with its focus, setup sections, and capabilities", async () => {
    const response = await getService(context("noxticket") as never);
    expect(response.status).toBe(200);
    const body = await response.json() as { service: CapabilityBody["services"][number] };
    expect(body.service).toMatchObject({
      id: "noxticket",
      focus: "Plan and organize delivery work",
      setup: { state: "ready" },
    });
    expect(body.service.setup.sections.map((section: { id: string }) => section.id)).toEqual([
      "workflow", "storage", "delivery",
    ]);
    expect(body.service.capabilities.map((capability: { id: string }) => capability.id)).toEqual([
      "features", "workflow", "specs", "ticket_delivery",
    ]);
  });

  it("returns 404 for an unknown service without touching storage", async () => {
    const ctx = context("unknown");
    const response = await getService(ctx as never);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      apiVersion: 1,
      error: { code: "service_not_found", message: "Unknown Nox service" },
    });
    expect(ctx.env.DB.prepare).not.toHaveBeenCalled();
  });

  it("returns standardized setup sections with computed state", async () => {
    const response = await getSetup(context("noxticket") as never);
    const body = await response.json() as any;
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ service: "noxticket", state: "ready" });
    expect(body.sections).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "workflow", state: "ready" }),
      expect.objectContaining({ id: "delivery", state: "blocked" }),
    ]));
  });

  it("reports required failures separately from optional connection failures", async () => {
    const response = await getHealth(context("noxticket") as never);
    const body = await response.json() as any;
    expect(response.status).toBe(200);
    expect(body.state).toBe("healthy");
    expect(body.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "github_connection", state: "pass", required: true }),
      expect.objectContaining({ id: "slack_connection", state: "fail", required: false }),
    ]));
  });
});
