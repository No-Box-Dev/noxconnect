import { describe, expect, it } from "vitest";
import { buildServiceCatalog } from "../../lib/service-capabilities";
import openapiDocument from "../../../public/openapi.json";

type Operation = {
  responses?: Record<string, { $ref?: string; content?: unknown }>;
  "x-authentication"?: string;
  "x-change-safety"?: string;
};

const methods = ["get", "post", "put", "patch", "delete"] as const;
const openapi = openapiDocument as {
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
