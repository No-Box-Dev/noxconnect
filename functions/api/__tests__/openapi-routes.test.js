import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import openapi from "../../../public/openapi.json";

describe("canonical OpenAPI routes", () => {
  it("has a connector route for every canonical non-control-plane path", () => {
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
      return { pattern: new RegExp(`^/${route}$`), handlers };
    });

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
});

function walkRouteFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walkRouteFiles(path) : /\.(?:js|ts)$/.test(entry.name) ? [path] : [];
  });
}

function isNoxHereControlPath(path) {
  return path === "/api/v1/auth/profile"
    || path.startsWith("/api/v1/auth/native/")
    || path === "/api/v1/api-tokens"
    || path.startsWith("/api/v1/api-tokens/");
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
