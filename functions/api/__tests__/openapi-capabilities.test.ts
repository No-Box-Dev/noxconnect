import { describe, expect, it } from "vitest";
import { buildServiceCatalog } from "../../lib/service-capabilities";
import openapiDocument from "../../../public/openapi.json";

type Operation = {
  parameters?: Array<{ $ref?: string }>;
  responses?: Record<string, { $ref?: string; content?: unknown }>;
  security?: Array<Record<string, unknown>>;
  "x-authentication"?: string;
  "x-automation-scope"?: string;
  "x-change-safety"?: string;
  "x-project-scope"?: string;
};

const methods = ["get", "post", "put", "patch", "delete"] as const;
const openapi = openapiDocument as unknown as {
  components: { parameters: { projectContext: { required: boolean } }; schemas: Record<string, { properties?: Record<string, unknown> }> };
  paths: Record<string, Partial<Record<(typeof methods)[number], Operation>>>;
};

const services = buildServiceCatalog({
  enabledApps: { noxticket: true, noxfeed: true, noxspot: true, noxcue: true },
  runtimeStates: {
    noxconnect: { state: "ready", source: "binding" },
    noxticket: { state: "ready", source: "binding" },
    noxfeed: { state: "ready", source: "binding" },
    noxspot: { state: "ready", source: "binding" },
    noxcue: { state: "ready", source: "binding" },
  },
  integrations: {
    github: { configured: true, connected: true, bootstrapping: false, health: "ok" },
    slack: { configured: true, connected: true, needsReconnect: false, health: "ok" },
  },
});

describe("capability discovery and OpenAPI stay aligned", () => {
  it("publishes every first-party operation under the canonical v1 namespace", () => {
    const nonCanonicalPaths = Object.keys(openapi.paths).filter((path) =>
      !path.startsWith("/api/v1/") && !path.startsWith("/api/spots/public/v1/"),
    );
    expect(nonCanonicalPaths).toEqual([]);
  });

  it("documents every operation advertised by every capability", () => {
    for (const service of services) {
      for (const capability of service.capabilities) {
        for (const operation of capability.operations) {
          const rawPath = operation.path.startsWith("http")
            ? decodeURIComponent(new URL(operation.path).pathname)
            : operation.path;
          const path = rawPath.replace(
            /^\/api\/v1\/services\/(?:noxconnect|noxticket|noxfeed|noxspot|noxcue)\//,
            "/api/v1/services/{service}/",
          );
          expect(
            openapi.paths[path]?.[operation.method.toLowerCase() as (typeof methods)[number]],
            `${service.id}.${capability.id}.${operation.id} is missing ${operation.method} ${path}`,
          ).toBeDefined();
        }
      }
    }
  });

  it("keeps operation identifiers unique", () => {
    const ids = services.flatMap((service) => service.capabilities)
      .flatMap((capability) => capability.operations)
      .map((operation) => operation.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("classifies authentication and retry safety for every operation", () => {
    for (const [path, pathItem] of Object.entries(openapi.paths)) {
      for (const method of methods) {
        const operation = pathItem[method];
        if (!operation) continue;
        expect(operation["x-authentication"], `${method.toUpperCase()} ${path}`).toBeTruthy();
        expect(operation["x-change-safety"], `${method.toUpperCase()} ${path}`).toBeTruthy();
      }
    }
  });

  it("documents optional project context and exact automation support", () => {
    expect(openapi.components.parameters.projectContext.required).toBe(false);
    expect(openapi.components.schemas.NoxFeedConfigPatch.properties).not.toHaveProperty("projectScope");
    for (const [path, pathItem] of Object.entries(openapi.paths)) {
      for (const method of methods) {
        const operation = pathItem[method];
        if (!operation) continue;
        expect(operation["x-project-scope"], `${method.toUpperCase()} ${path}`).not.toBe("required");
        const acceptsAutomation = operation.security?.some((requirement) => "noxApiToken" in requirement) ?? false;
        expect(Boolean(operation["x-automation-scope"]), `${method.toUpperCase()} ${path}`).toBe(acceptsAutomation);
        if (operation["x-project-scope"] === "optional") {
          expect(operation.parameters).toContainEqual({ $ref: "#/components/parameters/projectContext" });
        }
      }
    }
  });

  it("gives every non-empty response a machine-readable body", () => {
    for (const [path, pathItem] of Object.entries(openapi.paths)) {
      for (const method of methods) {
        const operation = pathItem[method];
        if (!operation) continue;
        for (const [status, response] of Object.entries(operation.responses ?? {})) {
          if (status === "204") continue;
          expect(
            Boolean(response.$ref || response.content),
            `${method.toUpperCase()} ${path} response ${status}`,
          ).toBe(true);
        }
      }
    }
  });

  it("publishes NoxCue ingest through the stable application gateway", () => {
    expect(openapi.paths["/api/v1/cues/public/events"]?.post).toBeDefined();
    expect(JSON.stringify(openapi)).not.toContain("workers.dev");
  });

  it("advertises NoxCue GitHub incidents only behind the GitHub connection", () => {
    const noxCue = services.find((service) => service.id === "noxcue");
    expect(noxCue?.setup.connections).toContainEqual(expect.objectContaining({
      provider: "github",
      requirement: "optional",
    }));
    expect(noxCue?.capabilities).toContainEqual(expect.objectContaining({
      id: "github_incidents",
      requires: ["github"],
      operations: expect.arrayContaining([
        expect.objectContaining({ method: "GET", path: "/api/v1/cues/github-issues" }),
        expect.objectContaining({ method: "PUT", path: "/api/v1/cues/github-issues" }),
      ]),
    }));

    const withoutGitHub = buildServiceCatalog({
      enabledApps: { noxticket: true, noxfeed: true, noxspot: true, noxcue: true },
      runtimeStates: { noxcue: { state: "ready", source: "binding" } },
      integrations: {
        github: { configured: false, connected: false, bootstrapping: false, health: "unavailable" },
        slack: { configured: true, connected: true, needsReconnect: false, health: "ok" },
      },
    }).find((service) => service.id === "noxcue");
    expect(withoutGitHub?.setup.state).toBe("ready");
    expect(withoutGitHub?.capabilities.find((capability) => capability.id === "github_incidents"))
      .toMatchObject({ state: "blocked", blockers: ["github"] });
  });
});
