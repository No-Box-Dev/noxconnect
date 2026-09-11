import { describe, expect, it } from "vitest";
import {
  normalizeLegacyError,
  normalizeV1Response,
  requireV1Admin,
  requireV1Member,
  v1Error,
  v1Response,
} from "../api-v1";

describe("API v1 response contract", () => {
  it("applies safe, non-cacheable JSON headers to success responses", async () => {
    const response = v1Response({ apiVersion: 1, ok: true });
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Link")).toContain("/openapi.json");
    expect(await response.json()).toEqual({ apiVersion: 1, ok: true });
  });

  it("uses one coded error envelope", async () => {
    const response = v1Error("validation_failed", "Invalid input", 422, { field: "name" });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      apiVersion: 1,
      error: { code: "validation_failed", message: "Invalid input", details: { field: "name" } },
    });
  });

  it("enforces complete member context and admin access", async () => {
    expect(requireV1Member({ data: { orgId: 7 } })).toBeInstanceOf(Response);
    expect(requireV1Member({ data: { orgId: 7, orgLogin: "acme" } })).toBeNull();
    const denied = requireV1Admin({ data: { orgId: 7, orgLogin: "acme", isAdmin: false } });
    expect(denied?.status).toBe(403);
    expect(requireV1Admin({ data: { orgId: 7, orgLogin: "acme", isAdmin: true } })).toBeNull();
  });

  it("normalizes legacy errors at the v1 boundary", async () => {
    const response = await normalizeLegacyError(new Response(JSON.stringify({ error: "Bad route", route: "noxfeed" }), {
      status: 409,
      headers: { "Content-Type": "application/json" },
    }));
    expect(await response.json()).toEqual({
      apiVersion: 1,
      error: { code: "conflict", message: "Bad route", details: { route: "noxfeed" } },
    });
  });

  it("preserves an explicit stable dependency error code", async () => {
    const response = await normalizeLegacyError(new Response(JSON.stringify({
      error: "NoxFeed generation service is unavailable",
      code: "dependency_unavailable",
    }), { status: 503, headers: { "Content-Type": "application/json" } }));

    expect(await response.json()).toEqual({
      apiVersion: 1,
      error: {
        code: "dependency_unavailable",
        message: "NoxFeed generation service is unavailable",
      },
    });
  });

  it("preserves response metadata while normalizing legacy errors", async () => {
    const response = await normalizeLegacyError(new Response(JSON.stringify({ error: "Try later" }), {
      status: 429,
      headers: { "Content-Type": "application/json", "Retry-After": "30" },
    }));
    expect(response.headers.get("Retry-After")).toBe("30");
    expect(response.headers.get("Link")).toContain("/openapi.json");
    expect(await response.json()).toEqual({
      apiVersion: 1,
      error: { code: "rate_limited", message: "Try later" },
    });
  });

  it("does not double-wrap native v1 errors", async () => {
    const original = v1Error("invalid_scope", "Invalid scope", 400, { scope: "admin" });
    const response = await normalizeLegacyError(original);
    expect(await response.json()).toEqual({
      apiVersion: 1,
      error: { code: "invalid_scope", message: "Invalid scope", details: { scope: "admin" } },
    });
  });

  it("adds transport headers without changing a non-JSON response", async () => {
    const response = normalizeV1Response(new Response("export-data", {
      headers: { "Content-Type": "text/plain", "Content-Disposition": "attachment; filename=export.txt" },
    }));
    expect(response.headers.get("Content-Type")).toContain("text/plain");
    expect(response.headers.get("Content-Disposition")).toContain("export.txt");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.text()).toBe("export-data");
  });

  it("does not buffer oversized legacy error bodies", async () => {
    const response = await normalizeLegacyError(new Response(JSON.stringify({
      error: "must not be copied",
      payload: "x".repeat(70 * 1024),
    }), { status: 502, headers: { "Content-Type": "application/json" } }));
    expect(await response.json()).toEqual({
      apiVersion: 1,
      error: { code: "internal_error", message: "Request failed" },
    });
  });
});
