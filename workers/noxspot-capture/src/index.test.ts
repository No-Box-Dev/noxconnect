import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { app } from "./index";

async function tokenHash(token: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

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
    env.DB.prepare(`CREATE TABLE spot_report_response_tokens (
      token_hash TEXT PRIMARY KEY, token_encrypted TEXT NOT NULL, resolution_key TEXT NOT NULL UNIQUE,
      report_id TEXT, org_id INTEGER NOT NULL, project_id TEXT NOT NULL, site_id TEXT NOT NULL,
      repo TEXT NOT NULL, issue_number INTEGER NOT NULL, report_title TEXT NOT NULL, reporter_name TEXT,
      expires_at TEXT NOT NULL, claimed_at TEXT, used_at TEXT, response_id TEXT, response_text TEXT,
      screenshot_url TEXT, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
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

  it("opens a valid reporter response page without mutating the issue", async () => {
    const token = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
    const hash = await tokenHash(token);
    const now = new Date().toISOString();
    await env.DB.prepare(`INSERT INTO spot_report_response_tokens
      (token_hash, token_encrypted, resolution_key, org_id, project_id, site_id, repo,
       issue_number, report_title, expires_at, created_at, updated_at)
      VALUES (?, 'encrypted', 'report:resolved', 1, 'project-1', 'site-1', 'web', 42,
              'Checkout is stuck', ?, ?, ?)`)
      .bind(hash, new Date(Date.now() + 86_400_000).toISOString(), now, now).run();

    const response = await app.request(`/resolution/${token}`, {}, env as never);
    expect(response.status).toBe(200);
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    const html = await response.text();
    expect(html).toContain("Tell us what is still happening");
    expect(html).toContain("Reopen issue");
  });

  it("adds the reporter response and reopens the existing issue", async () => {
    const token = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefg";
    const hash = await tokenHash(token);
    const now = new Date().toISOString();
    await env.DB.prepare(`INSERT INTO spot_report_response_tokens
      (token_hash, token_encrypted, resolution_key, org_id, project_id, site_id, repo,
       issue_number, report_title, expires_at, created_at, updated_at)
      VALUES (?, 'encrypted', 'report:resolved:second', 1, 'project-1', 'site-1', 'web', 43,
              'Drag position is wrong', ?, ?, ?)`)
      .bind(hash, new Date(Date.now() + 86_400_000).toISOString(), now, now).run();
    const execute = vi.fn(async () => ({ status: "completed" }));
    const form = new FormData();
    form.set("message", "The card still lands one place too far right.");
    form.set("screenshot", new File([new Uint8Array([137, 80, 78, 71])], "proof.png", { type: "image/png" }));

    const response = await app.request(`/api/spots/public/v1/resolution-responses/${token}`, {
      method: "POST",
      body: form,
    }, { ...env, NOXCONNECT: { execute } } as never);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Issue reopened");
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[0][0]).toMatchObject({
      capability: "github.issue.comment",
      input: { repository: "web", issueNumber: 43 },
    });
    expect(execute.mock.calls[1][0]).toMatchObject({
      capability: "github.issue.update",
      input: { repository: "web", issueNumber: 43, issue: { state: "open" } },
    });
    const stored = await env.DB.prepare(
      "SELECT used_at, response_text, screenshot_url FROM spot_report_response_tokens WHERE token_hash = ?",
    ).bind(hash).first<{ used_at: string; response_text: string; screenshot_url: string }>();
    expect(stored?.used_at).toBeTruthy();
    expect(stored?.response_text).toContain("too far right");
    expect(stored?.screenshot_url).toContain("responses/site-1/");
    const screenshotPath = new URL(stored!.screenshot_url).pathname;
    const screenshotResponse = await app.request(screenshotPath, {}, { ...env, NOXCONNECT: { execute } } as never);
    expect(screenshotResponse.status).toBe(200);
    expect(screenshotResponse.headers.get("Content-Type")).toBe("image/png");
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
