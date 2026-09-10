import { WorkerEntrypoint } from "cloudflare:workers";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { checkRateLimit, RateLimiter } from "./rate-limiter";
import {
  buildDailyDigestResponse,
  buildIssueResponse,
  buildSlackResponse,
  buildTestResponse,
  type CaptureInput,
  type IssueInput,
} from "./response";
import { NOXSPOT_SERVICE_MANIFEST } from "./service-manifest";
import { readBoundedJson, RequestBodyTooLargeError } from "./request-json";
import {
  buildCaptureTask,
  deleteExpiredScreenshots,
  MAX_ERROR_BODY_BYTES,
  MAX_REPORT_BODY_BYTES,
  putScreenshot,
  screenshotTarget,
  validateQueueTask,
  validateReportInput,
  type CaptureTask,
  type ReportParams,
} from "./report";
import {
  environmentForOrigin,
  getCaptureSite,
  legacyWidgetConfig,
  originAllowed,
  parseWidgetConfig,
  publicWidgetConfig,
  requestOrigin,
  type CaptureSite,
} from "./site-config";
import {
  receiveScreenshotFailure,
  receiveScreenshotOutcome,
  receiveWidgetFailure,
  receiveWidgetInstall,
} from "./telemetry";

type AppContext = Context<{ Bindings: Env }>;

const RATE_LIMIT_WINDOW_MS = 60_000;
const REPORT_IP_LIMIT = 10;
const REPORT_SITE_LIMIT = 30;
const ERROR_IP_LIMIT = 5;
const ERROR_SITE_LIMIT = 60;
const MAX_ERROR_TITLE_LENGTH = 200;
// Rich diagnostics remain deliberately bounded and contain only allow-listed,
// redacted metadata. Keep this below the NoxCue event body ceiling (32 KiB).
const MAX_TELEMETRY_BODY_BYTES = 16_384;

export const app = new Hono<{ Bindings: Env }>();

app.use("*", async (context, next) => {
  await next();
  context.header("X-Content-Type-Options", "nosniff");
  context.header("Referrer-Policy", "strict-origin-when-cross-origin");
});

app.use("*", cors({
  origin: "*",
  allowMethods: ["GET", "POST", "OPTIONS"],
  allowHeaders: ["Content-Type", "Idempotency-Key"],
  maxAge: 86_400,
}));

function clientIp(context: AppContext): string {
  return context.req.header("CF-Connecting-IP") || context.req.header("X-Forwarded-For") || "unknown";
}

function jsonError(context: AppContext, error: string, status: 400 | 403 | 404 | 413 | 415 | 429 | 500 | 503) {
  return context.json({ error }, status);
}

function requireJson(context: AppContext) {
  const contentType = context.req.header("Content-Type") || "";
  return contentType.toLowerCase().startsWith("application/json");
}

async function boundedBody(context: AppContext, maxBytes: number): Promise<unknown | Response> {
  if (!requireJson(context)) return jsonError(context, "Content-Type must be application/json", 415);
  try {
    return await readBoundedJson(context.req.raw, maxBytes);
  } catch (error) {
    return error instanceof RequestBodyTooLargeError
      ? jsonError(context, "Request body too large", 413)
      : jsonError(context, "Invalid JSON body", 400);
  }
}

async function siteForPublicRequest(context: AppContext, siteId: string): Promise<CaptureSite | Response> {
  const site = await getCaptureSite(context.env.DB, siteId);
  if (!site || site.noxspot_enabled === 0) return jsonError(context, "Site not found", 404);
  const config = parseWidgetConfig(site.widget_config);
  if (!originAllowed(config, requestOrigin(context.req.raw))) {
    return jsonError(context, "This origin is not enabled for the site", 403);
  }
  return site;
}

async function serveConfig(context: AppContext) {
  const siteId = context.req.param("siteId");
  if (!siteId) return jsonError(context, "Site not found", 404);
  const site = await siteForPublicRequest(context, siteId);
  if (site instanceof Response) return site;
  return context.json(publicWidgetConfig(site, requestOrigin(context.req.raw)));
}

app.get("/api/spots/public/v1/sites/:siteId/config", serveConfig);
app.get("/sites/:siteId/config", serveConfig);

async function submitReport(context: AppContext) {
  if (await checkRateLimit(context.env, `report:ip:${clientIp(context)}`, REPORT_IP_LIMIT, RATE_LIMIT_WINDOW_MS)) {
    return jsonError(context, "Too many reports. Please try again later.", 429);
  }
  const body = await boundedBody(context, MAX_REPORT_BODY_BYTES);
  if (body instanceof Response) return body;
  const validation = validateReportInput(body);
  if (!validation.ok) return context.json({ error: validation.error }, validation.status as 400);
  const params = validation.params;
  const idempotencyKey = context.req.header("Idempotency-Key");
  if (idempotencyKey && idempotencyKey !== params.attemptId) return jsonError(context, "Idempotency key does not match attempt ID", 400);
  if (await checkRateLimit(context.env, `report:site:${params.siteId}`, REPORT_SITE_LIMIT, RATE_LIMIT_WINDOW_MS)) {
    return jsonError(context, "Too many reports for this site. Please try again later.", 429);
  }

  const site = await siteForPublicRequest(context, params.siteId);
  if (site instanceof Response) return site;
  const origin = requestOrigin(context.req.raw);
  const config = parseWidgetConfig(site.widget_config);
  params.environment = environmentForOrigin(config, origin)?.name ?? null;
  const effectiveConfig = publicWidgetConfig(site, origin);

  const captureId = params.attemptId || crypto.randomUUID();
  const target = screenshotTarget(params.siteId, captureId, params.screenshot, context.env.PUBLIC_ASSET_BASE_URL);
  let screenshotStored = false;
  try {
    if (target && params.screenshot) {
      await putScreenshot(context.env.ASSETS, target, params.screenshot);
      screenshotStored = true;
    }
    const task = validateQueueTask(buildCaptureTask({
      site,
      params,
      captureId,
      screenshotUrl: target?.url ?? null,
    }));
    await context.env.TASK_QUEUE.send(task);
  } catch (error) {
    // A client retry reuses the same object key. If queueing this retry fails,
    // the first attempt may already reference that object, so never delete it.
    // Generated one-shot IDs remain safe to clean up immediately.
    if (screenshotStored && target && !params.attemptId) {
      try { await context.env.ASSETS.delete(target.key); }
      catch (cleanupError) {
        console.error(JSON.stringify({ event: "noxspot.screenshot.cleanup_failed", key: target.key, error: message(cleanupError) }));
      }
    }
    console.error(JSON.stringify({ event: "noxspot.report.queue_failed", siteId: site.id, captureId, error: message(error) }));
    return jsonError(context, "Issue delivery is temporarily unavailable", 503);
  }

  console.log(JSON.stringify({ event: "noxspot.report.queued", siteId: site.id, captureId }));
  return context.json({ success: true, issueId: captureId, queued: true, mode: effectiveConfig.widgetMode });
}

app.post("/api/spots/public/v1/reports", submitReport);
app.post("/report", submitReport);

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringField(value: unknown, max: number): string | null {
  return typeof value === "string" ? value.slice(0, max) : null;
}

async function submitErrors(context: AppContext) {
  if (await checkRateLimit(context.env, `errors:ip:${clientIp(context)}`, ERROR_IP_LIMIT, RATE_LIMIT_WINDOW_MS)) {
    return jsonError(context, "Too many requests", 429);
  }
  const body = await boundedBody(context, MAX_ERROR_BODY_BYTES);
  if (body instanceof Response) return body;
  if (!plainObject(body) || typeof body.siteId !== "string" || !body.siteId || body.siteId.length > 120 ||
      !Array.isArray(body.errors) || body.errors.length === 0 || body.errors.length > 10) {
    return jsonError(context, "Invalid siteId or errors array", 400);
  }
  if (await checkRateLimit(context.env, `errors:site:${body.siteId}`, ERROR_SITE_LIMIT, RATE_LIMIT_WINDOW_MS)) {
    return jsonError(context, "Too many error reports for this site", 429);
  }

  const site = await siteForPublicRequest(context, body.siteId);
  if (site instanceof Response) return site;
  if (site.noxalert_enabled === 0) return jsonError(context, "Automatic error logging is not enabled", 404);
  const config = parseWidgetConfig(site.widget_config);
  if (config.autoErrorLogging !== true) return jsonError(context, "Automatic error logging is not enabled", 404);
  const environment = environmentForOrigin(config, requestOrigin(context.req.raw))?.name ?? null;

  const queued: Array<{ task: CaptureTask; result: { fingerprint: string; action: "queued"; issueId: string } }> = [];
  for (const candidate of body.errors) {
    if (!plainObject(candidate) || typeof candidate.message !== "string" || !candidate.message.trim()) continue;
    const errorMessage = candidate.message.slice(0, 10_000);
    const source = stringField(candidate.source, 1_000);
    const normalized = errorMessage
      .replace(/0x[0-9a-fA-F]+/g, "0x#")
      .replace(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g, "#uuid")
      .replace(/\b\d+\b/g, "#");
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${normalized}|${source || ""}`));
    const fingerprint = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const captureId = crypto.randomUUID();
    const params: ReportParams = {
      attemptId: null,
      siteId: site.id,
      title: `[Auto] ${errorMessage.slice(0, MAX_ERROR_TITLE_LENGTH)}`,
      description: errorMessage,
      reporter: null,
      reporterEmail: null,
      environment,
      screenshot: null,
      metadata: {
        fingerprint,
        url: stringField(candidate.url, 2_048),
        browser: stringField(candidate.browser, 200),
        os: stringField(candidate.os, 200),
        source,
        line: Number.isInteger(candidate.lineno) ? candidate.lineno : null,
        column: Number.isInteger(candidate.colno) ? candidate.colno : null,
        stack: stringField(candidate.stack, 4_000),
      },
      elements: null,
      context: null,
      type: "bug",
      rating: null,
      blockValues: null,
    };
    const task = validateQueueTask(buildCaptureTask({ site, params, captureId, screenshotUrl: null, issueType: "error" }));
    queued.push({ task, result: { fingerprint, action: "queued", issueId: captureId } });
  }
  if (!queued.length) return jsonError(context, "No valid errors supplied", 400);

  try {
    await context.env.TASK_QUEUE.sendBatch(queued.map(({ task }) => ({ body: task })));
  } catch (error) {
    console.error(JSON.stringify({ event: "noxspot.errors.queue_failed", siteId: site.id, count: queued.length, error: message(error) }));
    return jsonError(context, "Error delivery is temporarily unavailable", 503);
  }
  console.log(JSON.stringify({ event: "noxspot.errors.queued", siteId: site.id, count: queued.length }));
  return context.json({ ok: true, results: queued.map(({ result }) => result) });
}

app.post("/api/spots/public/v1/errors", submitErrors);
app.post("/errors", submitErrors);

async function telemetryBody(context: AppContext): Promise<unknown | Response> {
  const contentType = context.req.header("Content-Type")?.toLowerCase() || "";
  // sendBeacon with a string uses text/plain, avoiding a CORS preflight during
  // page teardown. Telemetry is still parsed by the same bounded JSON reader.
  if (!contentType.startsWith("application/json") && !contentType.startsWith("text/plain")) {
    return jsonError(context, "Content-Type must be application/json or text/plain", 415);
  }
  try {
    return await readBoundedJson(context.req.raw, MAX_TELEMETRY_BODY_BYTES);
  } catch (error) {
    return error instanceof RequestBodyTooLargeError
      ? jsonError(context, "Request body too large", 413)
      : jsonError(context, "Invalid JSON body", 400);
  }
}

app.post("/telemetry/screenshot-failures", async (context) => {
  const body = await telemetryBody(context);
  return body instanceof Response ? body : receiveScreenshotFailure(context, body);
});
app.post("/telemetry/widget-failures", async (context) => {
  const body = await telemetryBody(context);
  return body instanceof Response ? body : receiveWidgetFailure(context, body);
});
app.post("/telemetry/screenshot-outcomes", async (context) => {
  const body = await telemetryBody(context);
  return body instanceof Response ? body : receiveScreenshotOutcome(context, body);
});
app.post("/telemetry/widget-installs", async (context) => {
  const body = await telemetryBody(context);
  return body instanceof Response ? body : receiveWidgetInstall(context, body);
});

const EXPIRED_SCREENSHOT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450" viewBox="0 0 800 450" role="img" aria-label="Screenshot expired"><rect width="800" height="450" fill="#f4f4f5"/><g fill="#a1a1aa" font-family="sans-serif" text-anchor="middle"><text x="400" y="212" font-size="26" font-weight="600">Screenshot expired</text><text x="400" y="248" font-size="16">Removed after 90 days</text></g></svg>`;

async function serveObject(context: AppContext, key: string) {
  const object = await context.env.ASSETS.get(key);
  if (!object) {
    if (key.startsWith("screenshots/")) {
      return new Response(EXPIRED_SCREENSHOT_SVG, { status: 200, headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=3600", "Access-Control-Allow-Origin": "*" } });
    }
    return context.notFound();
  }
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("ETag", object.httpEtag);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Cache-Control", key.startsWith("widget/") ? "public, max-age=31536000, immutable" : "public, max-age=3600");
  return new Response(object.body, { headers });
}

async function serveSiteScreenshot(context: AppContext, siteId: string, key: string) {
  const site = await getCaptureSite(context.env.DB, siteId);
  if (!site || site.noxspot_enabled === 0) return context.notFound();
  return serveObject(context, key);
}

app.get("/r2/:key{.+}", async (context) => {
  const key = context.req.param("key");
  const screenshot = key.match(/^screenshots\/([^/]+)\//);
  return screenshot ? serveSiteScreenshot(context, screenshot[1], key) : serveObject(context, key);
});
app.get("/api/spots/public/v1/screenshots/:siteId/:objectId", (context) => {
  const siteId = context.req.param("siteId");
  return serveSiteScreenshot(context, siteId, `screenshots/${siteId}/${context.req.param("objectId")}`);
});

app.get("/widget/:siteId{.+\\.js$}", async (context) => {
  const siteId = context.req.param("siteId").replace(/\.js$/, "");
  const [site, loader] = await Promise.all([
    getCaptureSite(context.env.DB, siteId),
    context.env.ASSETS.get("noxspot.min.js"),
  ]);
  if (!site || site.noxspot_enabled === 0) return new Response("/* NoxSpot: site not found */", { status: 404, headers: { "Content-Type": "application/javascript" } });
  if (!loader) return new Response("/* NoxSpot: loader unavailable */", { status: 503, headers: { "Content-Type": "application/javascript" } });
  const config = legacyWidgetConfig(site);
  return new Response(`var __NoxSpotSiteConfig=${JSON.stringify(config)};\n${await loader.text()}`, {
    headers: { "Content-Type": "application/javascript", "Cache-Control": "public, max-age=0, must-revalidate", "Access-Control-Allow-Origin": "*" },
  });
});

app.get("/health", (context) => {
  context.header("Cache-Control", "no-store");
  return context.json({
    status: "ok",
    service: "noxspot-api",
    owner: "noxconnect",
    plane: "public-capture",
    contractVersion: 1,
  });
});

// Compatibility only: Slack may still have the historical api.noxspot.dev
// redirect allowlisted while installations move to the canonical NoxConnect
// callback. Forward only Slack's known response fields; the destination can
// never be supplied by the request.
app.get("/slack/callback", (context) => {
  const source = new URL(context.req.url);
  const target = new URL("https://app.noxhere.com/api/slack/oauth/callback");
  for (const key of ["code", "state", "error"]) {
    const value = source.searchParams.get(key);
    if (value) target.searchParams.set(key, value);
  }
  context.header("Cache-Control", "no-store");
  return context.redirect(target.toString(), 302);
});

app.get("/", (context) => context.json({ name: "NoxConnect NoxSpot capture API", contractVersion: 1 }));

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export { RateLimiter };

export default class NoxSpotService extends WorkerEntrypoint<Env> {
  describe() {
    return NOXSPOT_SERVICE_MANIFEST;
  }

  fetch(request: Request) {
    return app.fetch(request, this.env, this.ctx);
  }

  scheduled() {
    this.ctx.waitUntil(deleteExpiredScreenshots(this.env.ASSETS).then((deleted) => {
      console.log(JSON.stringify({ event: "noxspot.retention.complete", deleted }));
    }).catch((error) => {
      console.error(JSON.stringify({ event: "noxspot.retention.failed", error: message(error) }));
      throw error;
    }));
  }

  buildIssueResponse(capture: CaptureInput) {
    return buildIssueResponse(capture);
  }

  buildSlackResponse(capture: CaptureInput, issue: IssueInput) {
    return buildSlackResponse(capture, issue);
  }

  buildTestResponse(orgLogin: string) {
    return buildTestResponse(orgLogin);
  }

  buildDailyDigestResponse(siteName: string, period: string, filed: IssueInput[], solved: IssueInput[], totals: Record<string, unknown>, portalUrl: string | null = null) {
    return buildDailyDigestResponse(siteName, period, filed, solved, totals, portalUrl);
  }
}
