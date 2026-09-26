import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import openapi from "../../../public/openapi.json";

const functionsRoot = join(process.cwd(), "functions");
const routeRoot = join(functionsRoot, "api", "v1");
const routes = walkRouteFiles(routeRoot).map((file) => {
  const route = relative(functionsRoot, file)
    .replace(/\.(?:js|ts)$/, "")
    .replace(/\/index$/, "")
    .split("/")
    .map((segment) => /^\[.+\]$/.test(segment) ? "[^/]+" : escapeRegex(segment))
    .join("/");
  const source = readFileSync(file, "utf8");
  const handlers = new Set(source.split("\n")
    .filter((line) => line.trimStart().startsWith("export "))
    .flatMap((line) => [...line.matchAll(/\bonRequest(?:Get|Post|Put|Patch|Delete|Head|Options)?\b/g)])
    .map((match) => match[0]));
  const documentedPath = `/${relative(functionsRoot, file)
    .replace(/\.(?:js|ts)$/, "")
    .replace(/\/index$/, "")
    .split("/")
    .map((segment) => /^\[(.+)\]$/.test(segment) ? `{${segment.slice(1, -1)}}` : segment)
    .join("/")}`;
  return { path: documentedPath, pattern: new RegExp(`^/${route}$`), handlers };
});

describe("canonical OpenAPI routes", () => {
  it("has a connector route for every canonical non-control-plane path", () => {
    for (const [path, operations] of Object.entries(openapi.paths)
      .filter(([candidate]) => candidate.startsWith("/api/v1/") && !isNoxHereControlPath(candidate))) {
      const route = routes.find((candidate) => candidate.pattern.test(path));
      expect(route, `${path} has no matching file under functions/api/v1`).toBeDefined();
      for (const method of ["get", "post", "put", "patch", "delete"]) {
        if (!operations[method]) continue;
        const methodHandler = `onRequest${method[0].toUpperCase()}${method.slice(1)}`;
        expect(
          route.handlers.has("onRequest") || route.handlers.has(methodHandler),
          `${method.toUpperCase()} ${path} is not exported by its v1 route file`,
        ).toBe(true);
      }
    }
  });

  it("documents every canonical v1 connector route and named method handler", () => {
    for (const route of routes) {
      const matches = Object.entries(openapi.paths)
        .filter(([path]) => path.startsWith("/api/v1/") && route.pattern.test(path));
      expect(matches, `${route.path} is implemented but missing from OpenAPI`).toHaveLength(1);
      const [documentedPath, operations] = matches[0] ?? [];
      for (const method of ["get", "post", "put", "patch", "delete"]) {
        const handler = `onRequest${method[0].toUpperCase()}${method.slice(1)}`;
        if (!route.handlers.has(handler)) continue;
        expect(operations?.[method], `${handler} for ${documentedPath ?? route.path} is missing from OpenAPI`).toBeDefined();
      }
    }
  });

  it("does not add state-changing product routes outside the canonical v1 tree", () => {
    const allowedIngress = new Set([
      "postmark/webhook",
      "review/claim",
      "review/complete",
      "review/token",
      "slack/events",
      "slack/interactions",
      "slack/oauth/start",
      "webhook",
    ]);
    const compatibilityMappings = new Set(["projects/routing/[id]"]);
    const unversionedMutations = walkRouteFiles(join(functionsRoot, "api"))
      .filter((file) => !file.startsWith(routeRoot) && !file.includes(`${join("api", "__tests__")}`))
      .flatMap((file) => {
        const source = readFileSync(file, "utf8");
        if (!/\bonRequest(?:Post|Put|Patch|Delete)\b/.test(source)) return [];
        return [relative(join(functionsRoot, "api"), file).replace(/\.(?:js|ts)$/, "").replace(/\/index$/, "")];
      })
      .filter((route) => !route.includes("/v1/") && !allowedIngress.has(route) && !compatibilityMappings.has(route))
      .filter((route) => ![
        join(routeRoot, `${route}.js`),
        join(routeRoot, `${route}.ts`),
        join(routeRoot, route, "index.js"),
        join(routeRoot, route, "index.ts"),
      ].some(existsSync));
    expect(unversionedMutations).toEqual([]);
  });
});

function walkRouteFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walkRouteFiles(path) : /\.(?:js|ts)$/.test(entry.name) ? [path] : [];
  });
}

function isNoxHereControlPath(path) {
  return path === "/api/v1/auth/profile"
    || path === "/api/v1/auth/logout"
    || path.startsWith("/api/v1/auth/native/")
    || path === "/api/v1/api-tokens"
    || path.startsWith("/api/v1/api-tokens/");
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
