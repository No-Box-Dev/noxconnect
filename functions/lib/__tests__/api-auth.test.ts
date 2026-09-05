import { describe, expect, it } from "vitest";
import {
  createApiTokenValue,
  normalizeApiTokenScopes,
  projectScopedApiTokenPathSupported,
  requiredApiTokenScope,
  sessionCookies,
  sha256,
  validateSessionCsrf,
} from "../api-auth.js";

describe("API authentication primitives", () => {
  it("creates environment-labelled API secrets without persisting derivable material", () => {
    const first = createApiTokenValue("test");
    const second = createApiTokenValue("test");
    expect(first.token).toMatch(/^nox_sk_test_[a-f0-9]{12}_[A-Za-z0-9_-]{40,}$/);
    expect(first.id).toMatch(/^noxkey_[a-f0-9]{32}$/);
    expect(first.token).not.toBe(second.token);
    expect(first.prefix).toHaveLength(24);
  });

  it("normalizes only the published least-privilege scopes", () => {
    expect(normalizeApiTokenScopes(["noxfeed:read", "services:read", "noxfeed:read"]))
      .toEqual(["noxfeed:read", "services:read"]);
    expect(normalizeApiTokenScopes(["admin:*", "noxfeed:read"])).toBeNull();
    expect(normalizeApiTokenScopes(["noxconnect:write"])).toBeNull();
    expect(normalizeApiTokenScopes(["noxticket:read"])).toBeNull();
    expect(normalizeApiTokenScopes([])).toBeNull();
  });

  it("maps advertised service routes to their service scope", () => {
    expect(requiredApiTokenScope("/api/v1/services", "GET")).toBe("services:read");
    expect(requiredApiTokenScope("/api/v1/services/noxspot/config", "PATCH")).toBe("noxspot:write");
    expect(requiredApiTokenScope("/api/features/12", "DELETE")).toBeNull();
    expect(requiredApiTokenScope("/api/prs", "GET")).toBe("noxfeed:read");
    expect(requiredApiTokenScope("/api/projects/proj_1/backfill-prs", "POST")).toBe("noxfeed:write");
    expect(requiredApiTokenScope("/api/cues/sources", "POST")).toBe("noxcue:write");
  });

  it("allows only resource-safe project token routes", () => {
    expect(projectScopedApiTokenPathSupported("/api/v1/feed", "GET")).toBe(true);
    expect(projectScopedApiTokenPathSupported("/api/spots/sites/site-1", "PATCH")).toBe(true);
    expect(projectScopedApiTokenPathSupported("/api/cues/sources/source-1/keys", "POST")).toBe(true);
    expect(projectScopedApiTokenPathSupported("/api/v1/services/noxfeed/config", "GET")).toBe(false);
    expect(projectScopedApiTokenPathSupported("/api/llm-settings", "GET")).toBe(false);
    expect(projectScopedApiTokenPathSupported("/api/features", "GET")).toBe(false);
  });

  it("issues a hardened opaque session cookie and separate CSRF cookie", () => {
    const [session, csrf] = sessionCookies("opaque", "proof");
    expect(session).toContain("__Host-nox_session=opaque");
    expect(session).toContain("HttpOnly");
    expect(session).toContain("Secure");
    expect(session).toContain("SameSite=Lax");
    expect(csrf).not.toContain("HttpOnly");
    expect(csrf).toContain("Secure");
  });

  it("requires same-origin double-submit CSRF proof on mutations", async () => {
    const csrfHash = await sha256("proof");
    const session = { csrf_hash: csrfHash };
    const valid = new Request("https://app.unticket.ai/api/v1/services/noxfeed/config", {
      method: "PATCH",
      headers: { Cookie: "nox_csrf=proof", "X-CSRF-Token": "proof", Origin: "https://app.unticket.ai" },
    });
    const crossOrigin = new Request(valid.url, {
      method: "PATCH",
      headers: { Cookie: "nox_csrf=proof", "X-CSRF-Token": "proof", Origin: "https://evil.example" },
    });
    expect(await validateSessionCsrf(session, valid)).toBe(true);
    expect(await validateSessionCsrf(session, crossOrigin)).toBe(false);
  });
});
