import { describe, expect, it, vi } from "vitest";
import { onRequest } from "../../_middleware.js";

describe("v1 middleware errors", () => {
  async function signedRequest(pathname, authOverrides = {}, requestHeaders = {}, method = "GET") {
    const secret = "test-internal-secret";
    const now = Math.floor(Date.now() / 1000);
    const assertion = {
      version: 1, issuer: "noxhere", audience: "noxconnect",
      issuedAt: now, expiresAt: now + 30, method, path: pathname,
      auth: {
        credentialType: "session", credentialId: "session-hash", principalId: "github:42",
        userLogin: "octocat", userId: 42, orgId: 7, orgLogin: "acme", isAdmin: true,
        projectId: null, scopes: [], connectionId: null, ...authOverrides,
      },
    };
    const payload = Buffer.from(JSON.stringify(assertion)).toString("base64url");
    const key = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
    );
    const signature = Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)))
      .toString("base64url");
    return {
      request: new Request(`https://app.noxhere.com${pathname}`, { method, headers: {
        "X-NoxHere-Internal-Assertion": payload,
        "X-NoxHere-Internal-Signature": signature,
        ...requestHeaders,
      } }),
      secret,
    };
  }

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
      error: {
        code: "missing_internal_assertion",
        message: "NoxConnect accepts authenticated requests only from NoxHere",
      },
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
        code: "missing_internal_assertion",
        message: "NoxConnect accepts authenticated requests only from NoxHere",
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
    expect(await response.json()).toEqual({
      error: "NoxConnect accepts authenticated requests only from NoxHere",
    });
  });

  it("rejects a cross-project selector on a project-scoped token", async () => {
    const signed = await signedRequest("/api/v1/feed", {
      credentialType: "api_token",
      credentialId: "project-token",
      projectId: "project-a",
      scopes: ["noxfeed:read"],
    }, { "X-Project-ID": "project-b" });
    const response = await onRequest({
      request: signed.request,
      env: {
        NOXHERE_INTERNAL_SECRET: signed.secret,
        DB: { prepare: () => ({ bind: () => ({ first: async () => ({ id: 7, github_login: "acme", suspended_at: null }) }) }) },
      },
      data: {},
      next() { throw new Error("handler should not run"); },
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      apiVersion: 1,
      error: { code: "resource_not_found", message: "The requested resource was not found" },
    });
  });

  it("lets native onboarding read integration status before selecting a project", async () => {
    const signed = await signedRequest("/api/v1/integrations/status");
    let handlerProjectId = "not-called";
    const middlewareContext = {
      request: signed.request,
      env: {
        NOXHERE_INTERNAL_SECRET: signed.secret,
        DB: { prepare: () => ({ bind: () => ({ first: async () => ({ id: 7, github_login: "acme", suspended_at: null }) }) }) },
      },
      data: {},
      next() {
        handlerProjectId = middlewareContext.data.projectId;
        return new Response(null, { status: 204 });
      },
    };
    const response = await onRequest(middlewareContext);
    expect(response.status).toBe(204);
    expect(handlerProjectId).toBeNull();
  });

  it("honors an optional project selector for integration status", async () => {
    const signed = await signedRequest(
      "/api/v1/integrations/status",
      {},
      { "X-Project-ID": "project-1" },
    );
    let handlerProjectId = "not-called";
    const middlewareContext = {
      request: signed.request,
      env: {
        NOXHERE_INTERNAL_SECRET: signed.secret,
        DB: {
          prepare(sql) {
            return { bind: () => ({ first: async () => sql.includes("FROM orgs")
              ? { id: 7, github_login: "acme", suspended_at: null }
              : { id: "project-1", archived: 0, enabled: 1 } }) };
          },
        },
      },
      data: {},
      next() {
        handlerProjectId = middlewareContext.data.projectId;
        return new Response(null, { status: 204 });
      },
    };
    const response = await onRequest(middlewareContext);
    expect(response.status).toBe(204);
    expect(handlerProjectId).toBe("project-1");
  });

  it("lets NoxTicket resolve project-owned feature numbers in its own database", async () => {
    const signed = await signedRequest(
      "/api/v1/features/3",
      {},
      { "X-Project-ID": "project-1" },
      "PATCH",
    );
    const statements = [];
    let handlerProjectId = "not-called";
    const middlewareContext = {
      request: signed.request,
      env: {
        NOXHERE_INTERNAL_SECRET: signed.secret,
        DB: {
          prepare(sql) {
            statements.push(sql);
            return { bind: () => ({ first: async () => {
              if (sql.includes("FROM orgs")) return { id: 7, github_login: "acme", suspended_at: null };
              if (sql.includes("FROM projects project")) return { id: "project-1", archived: 0, enabled: 1 };
              return null;
            } }) };
          },
        },
      },
      data: {},
      next() {
        handlerProjectId = middlewareContext.data.projectId;
        return new Response(null, { status: 204 });
      },
    };

    const response = await onRequest(middlewareContext);

    expect(response.status).toBe(204);
    expect(handlerProjectId).toBe("project-1");
    expect(statements.some((sql) => sql.includes("FROM features"))).toBe(false);
  });

  for (const pathname of [
    "/api/v1/events",
    "/api/v1/features",
    "/api/v1/services/noxfeed/config",
    "/api/v1/services/noxticket/config",
    "/api/v1/services/noxconnect/config",
    "/api/v1/services/noxspot/config",
    "/api/v1/services/noxcue/config",
    "/api/v1/integrations/slack/routing",
    "/api/v1/integrations/setup",
    "/api/v1/spots/sites",
    "/api/v1/cues/sources",
  ]) {
    it(`allows organization-wide ${pathname} requests`, async () => {
      const signed = await signedRequest(pathname);
      let handlerProjectId = "not-called";
      const middlewareContext = {
        request: signed.request,
        env: {
          NOXHERE_INTERNAL_SECRET: signed.secret,
          DB: { prepare: () => ({ bind: () => ({ first: async () => ({ id: 7, github_login: "acme", suspended_at: null }) }) }) },
        },
        data: {},
        next() {
          handlerProjectId = middlewareContext.data.projectId;
          return new Response(null, { status: 204 });
        },
      };
      const response = await onRequest(middlewareContext);
      expect(response.status).toBe(204);
      expect(handlerProjectId).toBeNull();
    });
  }

  it("uses a project identifier in the URL without requiring a duplicate header", async () => {
    const signed = await signedRequest("/api/v1/cues/projects/project-1/metrics");
    let handlerProjectId = "not-called";
    const middlewareContext = {
      request: signed.request,
      env: {
        NOXHERE_INTERNAL_SECRET: signed.secret,
        DB: {
          prepare(sql) {
            return { bind: () => ({ first: async () => sql.includes("FROM orgs")
              ? { id: 7, github_login: "acme", suspended_at: null }
              : { id: "project-1", archived: 0, enabled: 1 } }) };
          },
        },
      },
      data: {},
      next() {
        handlerProjectId = middlewareContext.data.projectId;
        return new Response(null, { status: 204 });
      },
    };
    const response = await onRequest(middlewareContext);
    expect(response.status).toBe(204);
    expect(handlerProjectId).toBe("project-1");
  });

  it("rejects conflicting optional project selectors", async () => {
    const signed = await signedRequest(
      "/api/v1/events?project_id=project-2",
      {},
      { "X-Project-ID": "project-1" },
    );
    const response = await onRequest({
      request: signed.request,
      env: {
        NOXHERE_INTERNAL_SECRET: signed.secret,
        DB: { prepare: () => ({ bind: () => ({ first: async () => ({ id: 7, github_login: "acme", suspended_at: null }) }) }) },
      },
      data: {},
      next() { throw new Error("handler should not run"); },
    });
    expect(response.status).toBe(404);
  });

  it("validates NoxFeed's legacy project_id selection as project scope", async () => {
    const signed = await signedRequest("/api/v1/events?project_id=project-1");
    let handlerProjectId = "not-called";
    const middlewareContext = {
      request: signed.request,
      env: {
        NOXHERE_INTERNAL_SECRET: signed.secret,
        DB: {
          prepare(sql) {
            return { bind: () => ({ first: async () => sql.includes("FROM orgs")
              ? { id: 7, github_login: "acme", suspended_at: null }
              : { id: "project-1", archived: 0, enabled: 1 } }) };
          },
        },
      },
      data: {},
      next() {
        handlerProjectId = middlewareContext.data.projectId;
        return new Response(null, { status: 204 });
      },
    };
    const response = await onRequest(middlewareContext);
    expect(response.status).toBe(204);
    expect(handlerProjectId).toBe("project-1");
  });

  it("blocks guest writes before a handler runs", async () => {
    const signed = await signedRequest("/api/v1/spots/project-overview", {
      accessLevel: "guest",
      guestAccess: { organizationWide: false, projects: { "project-1": ["noxspot"] } },
    }, { "X-Project-ID": "project-1" }, "POST");
    const response = await onRequest({
      request: signed.request,
      env: { NOXHERE_INTERNAL_SECRET: signed.secret },
      data: {},
      next() { throw new Error("handler should not run"); },
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "guest_read_only" } });
  });

  it("hides a project tool that was not granted to the guest", async () => {
    const signed = await signedRequest("/api/v1/cues/project-overview", {
      accessLevel: "guest",
      guestAccess: { organizationWide: false, projects: { "project-1": ["noxspot"] } },
    }, { "X-Project-ID": "project-1" });
    const response = await onRequest({
      request: signed.request,
      env: { NOXHERE_INTERNAL_SECRET: signed.secret },
      data: {},
      next() { throw new Error("handler should not run"); },
    });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "resource_not_found" } });
  });

  it("does not expose organization configuration to a guest", async () => {
    const signed = await signedRequest("/api/v1/config/apps", {
      accessLevel: "guest",
      guestAccess: { organizationWide: true, projects: {} },
    }, { "X-Project-ID": "project-1" });
    const response = await onRequest({
      request: signed.request,
      env: { NOXHERE_INTERNAL_SECRET: signed.secret },
      data: {},
      next() { throw new Error("handler should not run"); },
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "guest_scope_forbidden" } });
  });

  it("blocks a disabled product before its handler runs", async () => {
    const signed = await signedRequest("/api/v1/spots/sites", {}, { "X-Project-ID": "project-1" });
    const response = await onRequest({
      request: signed.request,
      env: {
        NOXHERE_INTERNAL_SECRET: signed.secret,
        DB: {
          prepare(sql) {
            return { bind: () => ({ first: async () => {
              if (sql.includes("FROM orgs")) return { id: 7, github_login: "acme", suspended_at: null };
              if (sql.includes("FROM projects project")) return { id: "project-1", archived: 0, enabled: 1 };
              return { data: JSON.stringify({ apps: { noxspot: false } }) };
            } }) };
          },
        },
      },
      data: {},
      next() { throw new Error("handler should not run"); },
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      apiVersion: 1,
      error: {
        code: "service_not_enabled",
        message: "NoxSpot is not enabled. Enable it in NoxConnect before trying again.",
        details: {
          service: "noxspot",
          remediation: { action: "enable_service", href: "/api/v1/services/noxspot/config" },
        },
      },
    });
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

  it("marks supported unversioned product routes as deprecated without setting a sunset", async () => {
    const response = await onRequest({
      request: new Request("https://app.noxhere.com/api/cues/public/v1/events", { method: "POST" }),
      env: {}, data: {}, next: () => Response.json({ accepted: true }, { status: 202 }),
    });
    expect(response.status).toBe(202);
    expect(response.headers.get("Deprecation")).toBe("true");
    expect(response.headers.get("Sunset")).toBeNull();
    expect(response.headers.get("Link")).toContain('rel="deprecation"');
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
    const signed = await signedRequest("/api/v1/events", {}, { "X-Project-ID": "project-1" });
    const response = await onRequest({
      request: signed.request,
      env: {
        ...noxCueEnv(requests),
        NOXHERE_INTERNAL_SECRET: signed.secret,
        DB: { prepare: (sql) => ({ bind: () => ({ first: async () => sql.includes("FROM orgs")
          ? { id: 7, github_login: "acme", suspended_at: null }
          : sql.includes("FROM projects project")
            ? { id: "project-1", archived: 0, enabled: 1 }
            : { data: JSON.stringify({}) } }) }) },
      },
      data: {},
      waitUntil(promise) { pending.push(promise); },
      next() { return new Response("failed", { status: 500 }); },
    });
    await Promise.all(pending);
    expect(response.status).toBe(500);
    expect(requests).toHaveLength(1);
    expect(await requests[0].json()).toMatchObject({
      type: "error.occurred",
      title: "NoxConnect GET /api/v1/events failed",
      message: "A NoxConnect API request returned an unexpected server error.",
      error: { name: "HTTPResponseError", code: "HTTP_500", status: 500 },
      data: {
        component: "noxconnect.pages-api",
        fingerprint: "noxconnect.http|GET|/api/v1/events|500",
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
