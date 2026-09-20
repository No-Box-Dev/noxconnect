import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const html = readFileSync(resolve("public/developers.html"), "utf8");
const script = readFileSync(resolve("public/developers.js"), "utf8");
const guide = readFileSync(resolve("public/docs/ai-setup.md"), "utf8");

describe("developer documentation", () => {
  it("treats project selection as optional request context", () => {
    expect(html).not.toContain("projectScope");
    expect(html).toContain("Omit <code>X-Project-ID</code> for organization-wide data");
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
    expect(guide).toContain("POST /api/v1/cues/public/events");
    expect(guide).toContain("honor `Retry-After`");
    expect(guide).toContain("Raw GitHub bearer tokens are rejected");
    expect(guide).toContain("opaque HttpOnly NoxHere session cookie");
  });

  it("documents the minimal, environment-scoped NoxCue SDK flow", () => {
    expect(html).toContain('id="noxcue-sdk"');
    expect(html).toContain("npm install @noxcue/sdk");
    expect(html).toContain('from <span class="token-string">"@noxcue/sdk/browser"</span>');
    expect(html).toContain('from <span class="token-string">"@noxcue/sdk/server"</span>');
    expect(html).toContain("await noxcue.auth.signup");
    expect(html).toContain("await userCue.user.registered");
    expect(html).toContain("noxcue.identify({ id: user.id");
    expect(html).toContain("noxcue.forUser(user.id)");
    expect(html).toContain("Never ship a <code>nox_secret_…</code> key to a browser");
  });

  it("makes the NoxSpot signed-in identity integration explicit", () => {
    expect(html).toContain('id="noxspot-identity"');
    expect(html).toContain("cannot read a host website's login session");
    expect(html).toContain("NoxSpot.identify({");
    expect(html).toContain("NoxSpot.identify(null)");
    expect(html).toContain("getUser");
    expect(html).toContain("avatarUrl");
    expect(html).toContain("profile-picture URL");
    expect(guide).toContain("anonymous-by-default install snippet");
    expect(guide).toContain("Set `notifyOnResolution: true` only when the host has already obtained consent");
  });
});
