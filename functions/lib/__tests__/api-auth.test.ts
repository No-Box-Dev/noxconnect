import { describe, expect, it } from "vitest";
import {
  canReadProjectResource,
  projectScopedApiTokenPathSupported,
} from "../api-auth.js";

describe("API authentication primitives", () => {
  it("allows only resource-safe project token routes", () => {
    expect(projectScopedApiTokenPathSupported("/api/v1/feed", "GET")).toBe(true);
    expect(projectScopedApiTokenPathSupported("/api/spots/sites/site-1", "PATCH")).toBe(true);
    expect(projectScopedApiTokenPathSupported("/api/v1/spots/sites/site-1", "PATCH")).toBe(true);
    expect(projectScopedApiTokenPathSupported("/api/cues/sources/source-1/keys", "POST")).toBe(true);
    expect(projectScopedApiTokenPathSupported("/api/v1/cues/sources/source-1/keys", "POST")).toBe(true);
    expect(projectScopedApiTokenPathSupported("/api/v1/services/noxfeed/config", "GET")).toBe(false);
    expect(projectScopedApiTokenPathSupported("/api/llm-settings", "GET")).toBe(false);
    expect(projectScopedApiTokenPathSupported("/api/features", "GET")).toBe(false);
    expect(projectScopedApiTokenPathSupported("/api/v1/features", "GET")).toBe(false);
  });

  it("admits pre-scoped API tokens to project reads without promoting human members", () => {
    expect(canReadProjectResource({ isAdmin: true, auth: { type: "session" } })).toBe(true);
    expect(canReadProjectResource({ isAdmin: false, auth: { type: "api_token" } })).toBe(true);
    expect(canReadProjectResource({ isAdmin: false, auth: { type: "session" } })).toBe(false);
    expect(canReadProjectResource({ isAdmin: false })).toBe(false);
  });

});
