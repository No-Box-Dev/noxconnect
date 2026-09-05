import { describe, expect, it } from "vitest";
import { onRequest } from "../../_middleware.js";

describe("v1 middleware errors", () => {
  it("uses the coded v1 envelope before a handler runs", async () => {
    const response = await onRequest({
      request: new Request("https://app.unticket.ai/api/v1/services"),
      env: {},
      data: {},
      next() { throw new Error("handler should not run"); },
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({
      apiVersion: 1,
      error: { code: "unauthorized", message: "Authentication required" },
    });
  });

  it("preserves the legacy error shape outside v1", async () => {
    const response = await onRequest({
      request: new Request("https://app.unticket.ai/api/projects"),
      env: {},
      data: {},
      next() { throw new Error("handler should not run"); },
    });
    expect(await response.json()).toEqual({ error: "Authentication required" });
  });

  it("lets the source-key-authenticated NoxCue gateway bypass GitHub auth", async () => {
    let continued = false;
    const response = await onRequest({
      request: new Request("https://app.unticket.ai/api/cues/public/v1/events", { method: "POST" }),
      env: {},
      data: {},
      next() { continued = true; return new Response(null, { status: 204 }); },
    });
    expect(continued).toBe(true);
    expect(response.status).toBe(204);
  });
});
