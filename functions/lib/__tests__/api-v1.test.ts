import { describe, expect, it } from "vitest";
import { normalizeLegacyError, requireV1Admin, requireV1Member, v1Error, v1Response } from "../api-v1";

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
});
