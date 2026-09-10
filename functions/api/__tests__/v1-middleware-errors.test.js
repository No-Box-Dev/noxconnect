import { describe, expect, it, vi } from "vitest";
import { onRequest } from "../../_middleware.js";

describe("v1 middleware errors", () => {
  function noxCueEnv(requests) {
    return {
      NOXCUE_INGEST_KEY: `nox_secret_${"a".repeat(40)}`,
      NOXCUE_INGEST: {
        async fetch(request) {
          requests.push(request);
          return new Response(JSON.stringify({ accepted: true }), { status: 202 });
        },
      },
    };
  }

  it("uses the coded v1 envelope before a handler runs", async () => {
    const response = await onRequest({
      request: new Request("https://app.noxhere.com/api/v1/services"),
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

  it("rejects provider bearer tokens before calling GitHub or a handler", async () => {
    const request = new Request("https://app.noxhere.com/api/v1/services", {
      headers: { Authorization: "Bearer github_pat_not-a-noxconnect-credential" },
    });
    const response = await onRequest({
      request,
      env: {},
      data: {},
      next() { throw new Error("handler should not run"); },
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      apiVersion: 1,
      error: {
        code: "unsupported_credential",
        message: "Use a NoxConnect native access token or a project-scoped API token",
      },
    });
  });

  it("preserves the legacy error shape outside v1", async () => {
    const response = await onRequest({
      request: new Request("https://app.noxhere.com/api/projects"),
      env: {},
      data: {},
      next() { throw new Error("handler should not run"); },
    });
    expect(await response.json()).toEqual({ error: "Authentication required" });
  });

  it("lets the source-key-authenticated NoxCue gateway bypass GitHub auth", async () => {
    let continued = false;
    const response = await onRequest({
      request: new Request("https://app.noxhere.com/api/cues/public/v1/events", { method: "POST" }),
      env: {},
      data: {},
      next() { continued = true; return new Response(null, { status: 204 }); },
    });
    expect(continued).toBe(true);
    expect(response.status).toBe(204);
  });

  it("applies the v1 response contract after a canonical public handler runs", async () => {
    const response = await onRequest({
      request: new Request("https://app.noxhere.com/api/v1/cues/public/events", { method: "POST" }),
      env: {},
      data: {},
      next() {
        return new Response(JSON.stringify({ error: "Unknown source" }), {
          status: 404,
          headers: { "Content-Type": "application/json", "X-Trace-ID": "trace-1" },
        });
      },
    });
    expect(response.status).toBe(404);
    expect(response.headers.get("X-Trace-ID")).toBe("trace-1");
    expect(response.headers.get("Link")).toContain("/openapi.json");
    expect(await response.json()).toEqual({
      apiVersion: 1,
      error: { code: "not_found", message: "Unknown source" },
    });
  });

  it("does not expose an exception thrown by a canonical handler", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await onRequest({
        request: new Request("https://app.noxhere.com/api/v1/cues/public/events", { method: "POST" }),
        env: {},
        data: {},
        next() { throw new Error("database password was secret"); },
      });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        apiVersion: 1,
        error: { code: "internal_error", message: "Request failed" },
      });
    } finally {
      errorLog.mockRestore();
    }
  });

  it("reports a server response without changing it", async () => {
    const requests = [];
    const pending = [];
    const response = await onRequest({
      request: new Request("https://app.noxhere.com/api/v1/auth/profile"),
      env: noxCueEnv(requests),
      data: {},
      waitUntil(promise) { pending.push(promise); },
      next() { return new Response("failed", { status: 500 }); },
    });
    await Promise.all(pending);
    expect(response.status).toBe(500);
    expect(requests).toHaveLength(1);
    expect(await requests[0].json()).toMatchObject({
      type: "error.occurred",
      title: "NoxConnect GET /api/v1/auth/profile failed",
      message: "A NoxConnect API request returned an unexpected server error.",
      error: { name: "HTTPResponseError", code: "HTTP_500", status: 500 },
      data: {
        component: "noxconnect.pages-api",
        fingerprint: "noxconnect.http|GET|/api/v1/auth/profile|500",
      },
    });
  });

  it("does not recursively report a NoxCue ingest failure", async () => {
    const requests = [];
    const response = await onRequest({
      request: new Request("https://app.noxhere.com/api/v1/cues/public/events", { method: "POST" }),
      env: noxCueEnv(requests),
      data: {},
      next() { return new Response("failed", { status: 500 }); },
    });
    expect(response.status).toBe(500);
    expect(requests).toHaveLength(0);
  });
});
