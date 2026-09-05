import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const html = readFileSync(resolve("public/developers.html"), "utf8");
const script = readFileSync(resolve("public/developers.js"), "utf8");
const guide = readFileSync(resolve("public/docs/ai-setup.md"), "utf8");

describe("developer documentation", () => {
  it("uses a valid NoxFeed project scope example and the real conflict code", () => {
    expect(html).toContain('{"projectScope":null}');
    expect(html).not.toContain('{"projectScope":"all"}');
    expect(html).toContain("revision_conflict");
  });

  it("loads behavior from an external CSP-compatible script", () => {
    expect(html).toContain('<script src="/developers.js" defer></script>');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
    expect(script).not.toContain("innerHTML");
  });

  it("derives the displayed operation count from the OpenAPI document", () => {
    expect(html).toContain('id="operation-total">Loading…</strong>');
    expect(script).toContain('operationTotal.textContent = `${operations.length} operations`');
  });

  it("documents the supported auth boundary and stable NoxCue gateway", () => {
    expect(guide).toContain("does not issue third-party OAuth client credentials");
    expect(guide).toContain("POST /api/cues/public/v1/events");
    expect(guide).toContain("honor `Retry-After`");
  });
});
