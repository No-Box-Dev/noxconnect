import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE orgs (id INTEGER PRIMARY KEY, github_login TEXT NOT NULL)"),
    env.DB.prepare("CREATE TABLE config (org_id INTEGER NOT NULL, key TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (org_id, key))"),
    env.DB.prepare(`CREATE TABLE spot_sites (
      id TEXT PRIMARY KEY,
      org_id INTEGER NOT NULL,
      project_id TEXT,
      repo TEXT NOT NULL,
      name TEXT NOT NULL,
      widget_config TEXT NOT NULL,
      slack_channel_id TEXT,
      slack_connection_id TEXT
    )`),
    env.DB.prepare("INSERT INTO orgs (id, github_login) VALUES (1, 'acme')"),
    env.DB.prepare(`INSERT INTO spot_sites
      (id, org_id, project_id, repo, name, widget_config, slack_channel_id, slack_connection_id)
    VALUES
      ('site-1', 1, 'project-1', 'web', 'Web',
       '{"buttonColor":"#123456","autoErrorLogging":true,"environments":[{"name":"Production","url":"app.example.com","enabled":true}]}',
       NULL, NULL)`),
  ]);
});

describe("public capture Worker", () => {
  it("identifies NoxConnect as the sole production owner", async () => {
    const response = await SELF.fetch("https://capture.test/health");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({
      status: "ok",
      service: "noxspot-api",
      owner: "noxconnect",
      plane: "public-capture",
      contractVersion: 1,
    });
  });

  it("serves effective config only to an allowed origin", async () => {
    const allowed = await SELF.fetch("https://capture.test/api/spots/public/v1/sites/site-1/config", {
      headers: { Origin: "https://app.example.com" },
    });
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toMatchObject({ version: 1, siteId: "site-1", buttonColor: "#123456", environment: "Production" });

    const denied = await SELF.fetch("https://capture.test/api/spots/public/v1/sites/site-1/config", {
      headers: { Origin: "https://evil.example" },
    });
    expect(denied.status).toBe(403);
  });

  it("accepts diagnostic screenshot failures and keeps successful telemetry origin-scoped", async () => {
    const failure = await SELF.fetch("https://capture.test/telemetry/screenshot-failures", {
      method: "POST",
      headers: { Origin: "https://unexpected.example", "Content-Type": "application/json" },
      body: JSON.stringify({
        version: 1,
        eventId: crypto.randomUUID(),
        siteId: "site-1",
        environment: "Production",
        widgetVersion: "build-1",
        captureMode: "click",
        stage: "rasterize",
        errorType: "SecurityError",
        errorMessage: "Canvas is tainted",
        viewport: { width: 1440, height: 900, devicePixelRatio: 2 },
        page: { nodeCount: 4200, imageCount: 12, fontStatus: "loaded", visibilityState: "visible" },
        cspViolations: [{ effectiveDirective: "connect-src", blockedResource: "https://i.ytimg.com", disposition: "enforce" }],
        occurredAt: new Date().toISOString(),
      }),
    });
    expect(failure.status).toBe(202);

    const success = await SELF.fetch("https://capture.test/telemetry/screenshot-outcomes", {
      method: "POST",
      headers: { Origin: "https://unexpected.example", "Content-Type": "application/json" },
      body: JSON.stringify({
        eventId: crypto.randomUUID(), siteId: "site-1", environment: "Production",
        widgetVersion: "build-1", captureMode: "click", outcome: "success",
      }),
    });
    expect(success.status).toBe(403);
  });

  it("forwards only bounded and redacted structured widget diagnostics", async () => {
    const response = await SELF.fetch("https://capture.test/telemetry/screenshot-failures", {
      method: "POST",
      headers: { Origin: "https://app.example.com", "Content-Type": "application/json" },
      body: JSON.stringify({
        eventId: crypto.randomUUID(), siteId: "site-1", environment: "Production",
        widgetVersion: "build-1", captureMode: "click", stage: "rasterize",
        errorType: "Error", errorMessage: "SAFE_DIAGNOSTIC_TEST for private-user@example.com token=top-secret",
        page: { readyState: "complete", pathDepth: 3, hasQuery: true, unsafeText: "private-user" },
        resources: { brokenImages: [{ origin: "https://images.example", path: "/*.png", sameOrigin: false, rawUrl: "top-secret" }] },
        renderer: {
          phase: "rasterize", svgCharacters: 2_400_000,
          phaseMs: { "pin+scroll": 42 },
          attempts: [{ kind: "blob", outcome: "image_error", rawHtml: "private-user" }],
          rawHtml: "top-secret",
        },
      }),
    });
    expect(response.status).toBe(202);
  });

  it("accepts catch-all widget failures sent through the beacon-safe content type", async () => {
    const response = await SELF.fetch("https://capture.test/telemetry/widget-failures", {
      method: "POST",
      headers: { Origin: "https://app.example.com", "Content-Type": "text/plain;charset=UTF-8" },
      body: JSON.stringify({
        version: 1,
        eventId: crypto.randomUUID(),
        siteId: "site-1",
        environment: "Production",
        widgetVersion: "build-1",
        captureMode: "click",
        stage: "submit",
        errorType: "TypeError",
        errorMessage: "Failed to fetch",
        viewport: { width: 1440, height: 900, devicePixelRatio: 2 },
        page: { nodeCount: 4200, imageCount: 12, fontStatus: "loaded", visibilityState: "visible" },
        occurredAt: new Date().toISOString(),
      }),
    });
    expect(response.status).toBe(202);
  });

  it("keeps screenshot failures retryable until NoxCue confirms diagnostic storage", async () => {
    const response = await SELF.fetch("https://capture.test/telemetry/screenshot-failures", {
      method: "POST",
      headers: { Origin: "https://app.example.com", "Content-Type": "application/json" },
      body: JSON.stringify({
        version: 1,
        eventId: crypto.randomUUID(),
        siteId: "site-1",
        environment: "Production",
        widgetVersion: "build-1",
        captureMode: "click",
        stage: "rasterize",
        errorType: "Error",
        errorMessage: "FORCE_NOXCUE_FAILURE",
        viewport: { width: 1440, height: 900, devicePixelRatio: 2 },
        page: { nodeCount: 4200, imageCount: 12, fontStatus: "loaded", visibilityState: "visible" },
        occurredAt: new Date().toISOString(),
      }),
    });

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("5");
    expect(await response.json()).toEqual({ error: "Telemetry storage unavailable" });
  });

  it("keeps catch-all widget failures retryable until NoxCue confirms diagnostic storage", async () => {
    const response = await SELF.fetch("https://capture.test/telemetry/widget-failures", {
      method: "POST",
      headers: { Origin: "https://app.example.com", "Content-Type": "application/json" },
      body: JSON.stringify({
        version: 1,
        eventId: crypto.randomUUID(),
        siteId: "site-1",
        environment: "Production",
        widgetVersion: "build-1",
        captureMode: "click",
        stage: "submit",
        errorType: "Error",
        errorMessage: "FORCE_NOXCUE_FAILURE",
        viewport: { width: 1440, height: 900, devicePixelRatio: 2 },
        page: { nodeCount: 4200, imageCount: 12, fontStatus: "loaded", visibilityState: "visible" },
        occurredAt: new Date().toISOString(),
      }),
    });

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("5");
  });

  it("rejects oversized reports before reading their body", async () => {
    const response = await SELF.fetch("https://capture.test/api/spots/public/v1/reports", {
      method: "POST",
      headers: {
        Origin: "https://app.example.com",
        "Content-Type": "application/json",
        "Content-Length": "8000000",
      },
      body: "{}",
    });
    expect(response.status).toBe(413);
  });

  it("rejects mismatched idempotency headers before delivery", async () => {
    const response = await SELF.fetch("https://capture.test/report", {
      method: "POST",
      headers: {
        Origin: "https://app.example.com",
        "Content-Type": "application/json",
        "Idempotency-Key": "attempt-other",
      },
      body: JSON.stringify({ siteId: "site-1", title: "Broken button", attemptId: "attempt-1" }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Idempotency key does not match attempt ID" });
  });

  it("does not expose retired generic widget routes", async () => {
    expect((await SELF.fetch("https://capture.test/v1/widget.js")).status).toBe(404);
    expect((await SELF.fetch("https://capture.test/v1.0.0/widget.js")).status).toBe(404);
    expect((await SELF.fetch("https://capture.test/api/spots/public/v1/assets/widget.js")).status).toBe(404);
  });

  it("enforces rate limits in a sharded Durable Object", async () => {
    const stub = env.RATE_LIMITER.getByName("test-shard");
    const key = "a".repeat(64);
    expect((await stub.check(key, 1, 60_000)).limited).toBe(false);
    expect((await stub.check(key, 1, 60_000)).limited).toBe(true);
  });

  it("forwards only known Slack callback parameters to NoxConnect", async () => {
    const response = await SELF.fetch("https://capture.test/slack/callback?code=abc&state=signed&next=https://evil.test", { redirect: "manual" });
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("https://app.noxhere.com/api/slack/oauth/callback?code=abc&state=signed");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("stops site config and widget delivery while NoxSpot is off", async () => {
    await env.DB.prepare(
      "INSERT INTO config (org_id, key, data) VALUES (1, 'settings', ?) ON CONFLICT(org_id, key) DO UPDATE SET data = excluded.data",
    ).bind('{"apps":{"noxspot":false}}').run();
    try {
      const config = await SELF.fetch("https://capture.test/sites/site-1/config", {
        headers: { Origin: "https://app.example.com" },
      });
      const widget = await SELF.fetch("https://capture.test/widget/site-1.js");
      expect(config.status).toBe(404);
      expect(widget.status).toBe(404);
    } finally {
      await env.DB.prepare("DELETE FROM config WHERE org_id = 1 AND key = 'settings'").run();
    }
  });

  it("stops automatic error intake while NoxAlert is off", async () => {
    await env.DB.prepare(
      "INSERT INTO config (org_id, key, data) VALUES (1, 'settings', ?) ON CONFLICT(org_id, key) DO UPDATE SET data = excluded.data",
    ).bind('{"apps":{"noxalert":false}}').run();
    try {
      const response = await SELF.fetch("https://capture.test/errors", {
        method: "POST",
        headers: { Origin: "https://app.example.com", "Content-Type": "application/json" },
        body: JSON.stringify({ siteId: "site-1", errors: [{ message: "boom" }] }),
      });
      expect(response.status).toBe(404);
    } finally {
      await env.DB.prepare("DELETE FROM config WHERE org_id = 1 AND key = 'settings'").run();
    }
  });
});
