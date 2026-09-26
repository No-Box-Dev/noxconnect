import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import openapi from "../../../public/openapi.json";

const wrapperMethods = {
  apiGet: "get", apiPost: "post", apiPut: "put", apiPatch: "patch",
  apiPatchWithHeaders: "patch", apiDelete: "delete", apiFetch: "get",
};

describe("first-party client API parity", () => {
  it("uses only versioned, documented API operations", () => {
    const calls = clientApiCalls(join(process.cwd(), "src"));
    expect(calls.length).toBeGreaterThan(50);
    for (const call of calls) {
      expect(call.path, `${call.file} uses an unversioned API path`).toMatch(/^\/api\/v1\//);
      const match = Object.entries(openapi.paths).find(([documentedPath]) => pathsMatch(call.path, documentedPath));
      expect(match, `${call.method.toUpperCase()} ${call.path} from ${call.file} is absent from OpenAPI`).toBeDefined();
      expect(match?.[1][call.method], `${call.method.toUpperCase()} ${call.path} from ${call.file} is not documented`).toBeDefined();
    }
  });
});

function clientApiCalls(root) {
  const calls = [];
  for (const file of walk(root).filter((candidate) => !candidate.includes(".test."))) {
    const source = readFileSync(file, "utf8");
    for (const [wrapper, defaultMethod] of Object.entries(wrapperMethods)) {
      const expression = new RegExp(`\\b${wrapper}(?:<[^;]*?>)?\\s*\\(\\s*([\\\"'\\\`])([\\s\\S]*?)\\1(?:\\s*,\\s*\\{([\\s\\S]{0,500}?)\\})?`, "g");
      for (const match of source.matchAll(expression)) {
        if (!match[2].startsWith("/api/")) continue;
        const explicit = match[3]?.match(/method\s*:\s*["'](GET|POST|PUT|PATCH|DELETE)["']/i)?.[1]?.toLowerCase();
        calls.push({ method: explicit ?? defaultMethod, path: match[2], file });
      }
    }
    const fetchExpression = /\bfetch\(\s*(["'`])(\/api\/[\s\S]*?)\1\s*(?:,\s*\{([\s\S]{0,500}?)\}\s*)?\)/g;
    for (const match of source.matchAll(fetchExpression)) {
      const method = match[3]?.match(/method\s*:\s*["'](GET|POST|PUT|PATCH|DELETE)["']/i)?.[1]?.toLowerCase() ?? "get";
      calls.push({ method, path: match[2], file });
    }
  }
  return calls;
}

function walk(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? walk(path) : /\.(?:ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

function pathsMatch(clientPath, documentedPath) {
  const client = clientPath.split("?", 1)[0].split("/").filter(Boolean);
  const documented = documentedPath.split("/").filter(Boolean);
  return client.length === documented.length && client.every((segment, index) => {
    const staticPart = segment.split("${", 1)[0];
    return (!staticPart && segment.includes("${")) || /^\{[^}]+\}$/.test(documented[index]) || staticPart === documented[index];
  });
}
