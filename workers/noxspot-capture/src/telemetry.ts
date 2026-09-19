import type { Context } from "hono";
import { checkRateLimit } from "./rate-limiter";
import { getCaptureSite, originAllowed, parseWidgetConfig, requestOrigin } from "./site-config";
import type { NoxSpotEnv } from "./resolution-response";

type TelemetryContext = Context<{ Bindings: NoxSpotEnv }>;

const NOXCUE_EVENT_URL = "https://noxcue.internal/v1/events";
const RATE_LIMIT_WINDOW_MS = 60_000;
const IP_RATE_LIMIT = 30;
const SITE_RATE_LIMIT = 120;
const CAPTURE_MODES = new Set(["click", "shortcut"]);
const SCREENSHOT_FAILURE_STAGES = new Set(["rasterize", "preview_decode", "preview_timeout", "compose", "upload"]);
const WIDGET_FAILURE_STAGES = new Set([
  "config_load",
  "core_load",
  "core_open",
  "runtime",
  "submit",
  "delivery",
  "retry",
]);
const METRICS = Object.freeze({
  screenshotCaptured: "custom.screenshots.captured",
  screenshotFailed: "custom.screenshots.failed",
  widgetInstalled: "custom.widget.installs",
});

interface BaseEvent {
  eventId: string;
  siteId: string;
  environment: string | null;
  widgetVersion: string;
  occurredAt: string | null;
}

interface CspViolation {
  effectiveDirective: string;
  blockedResource: string;
  sourceFile: string | null;
  disposition: string;
}

interface ScreenshotFailure extends BaseEvent {
  stage: string;
  errorType: string;
  errorMessage: string;
  errorStack: string | null;
  captureMode: string;
  viewportWidth: number;
  viewportHeight: number;
  devicePixelRatio: number;
  pageNodeCount: number;
  pageImageCount: number;
  pageIframeCount: number;
  pageCanvasCount: number;
  pageSvgCount: number;
  fontStatus: string;
  visibilityState: string;
  cspViolations: CspViolation[];
  attributes: Record<string, string | number | boolean>;
}

interface RequestIdentity {
  originHost: string;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function boundedNumber(value: unknown, max: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(Math.min(max, Math.max(0, number))) : 0;
}

function safeDiagnosticString(value: unknown, maxLength = 200): string {
  if (typeof value !== "string") return "";
  return value.trim()
    .replace(/file:\/\/\/[^\s)'"<>]+/gi, "[file]")
    .replace(/\s\/(?:Users|home|var|tmp)\/[^\s):]+(?::\d+:\d+)?/g, " [file]")
    .replace(/https?:\/\/[^\s)'"<>]+/gi, (raw) => {
      try {
        const url = new URL(raw);
        const path = url.pathname === "/" ? "" : /(^|\.)noxspot\.dev$/i.test(url.hostname) ? url.pathname : "/*";
        return `${url.origin}${path}`;
      } catch { return "[url]"; }
    })
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email]")
    .replace(/\b(bearer|token|api[_-]?key|secret|password)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]{10,}){1,2}\b/g, "[token]")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[token]")
    .slice(0, maxLength);
}

function safeOrigin(value: unknown): string {
  if (typeof value !== "string") return "";
  try { return new URL(value).origin.slice(0, 200); }
  catch { return safeDiagnosticString(value, 80); }
}

function safeResourcePath(value: unknown, origin = ""): string {
  if (typeof value !== "string") return "";
  if (/^\/\*(?:\.[a-z0-9]{1,8})?$/i.test(value)) return value;
  try {
    const host = new URL(origin).hostname;
    if (/(^|\.)noxspot\.dev$/i.test(host) && value.startsWith("/") && !value.includes("?") && !value.includes("#")) {
      return value.slice(0, 200);
    }
  } catch { /* Invalid origins never qualify for full paths. */ }
  const extension = /\.([a-z0-9]{1,8})$/i.exec(value)?.[1];
  return extension ? `/*.${extension.toLowerCase()}` : "/*";
}

const DIAGNOSTIC_ROOT_KEYS: Record<string, Set<string>> = {
  page: new Set(["readyState", "pathDepth", "hasQuery", "scrollWidth", "scrollHeight", "scrollX", "scrollY", "online"]),
  runtime: new Set(["browser", "browserMajor", "platform"]),
  visualViewport: new Set(["width", "height", "offsetLeft", "offsetTop", "scale"]),
};
const RESOURCE_KEYS = new Set(["origin", "path", "sameOrigin", "complete", "initiatorType", "durationMs", "transferBytes", "decodedBytes"]);
const RENDERER_KEYS = new Set([
  "phase", "phaseMs", "pairCount", "pseudoCount", "resources", "unique", "inlined", "dropped", "failed",
  "stripped", "count", "examples", "fontRules", "svgCharacters", "width", "height", "effectiveDpr",
  "sourceOrder", "attempts", "kind", "outcome", "errorType", "errorMessage", "tagCounts", "style", "script",
  "use", "image", "iframe", "foreignObject", "crossOriginCount", "origins", "origin", "path", "sameOrigin",
  "tag", "attribute", "property", "clone", "flatten", "pin+scroll", "inline", "serialize", "rasterize",
]);

function addDiagnostic(attributes: Record<string, string | number | boolean>, key: string, value: unknown): void {
  const safeKey = key.replace(/[^a-z0-9_.[\]-]/gi, "-").slice(0, 120);
  if (!/^[a-z]/i.test(safeKey) || Object.keys(attributes).length >= 96) return;
  if (typeof value === "boolean") attributes[safeKey] = value;
  else if (typeof value === "number" && Number.isFinite(value)) attributes[safeKey] = Math.round(value * 100) / 100;
  else if (typeof value === "string") {
    const safe = safeDiagnosticString(value, 300);
    if (safe) attributes[safeKey] = safe;
  }
}

function flattenRenderer(value: unknown, path: string, attributes: Record<string, string | number | boolean>, depth = 0): void {
  if (depth > 5 || Object.keys(attributes).length >= 96) return;
  if (Array.isArray(value)) {
    value.slice(0, 5).forEach((item, index) => flattenRenderer(item, `${path}[${index}]`, attributes, depth + 1));
    return;
  }
  if (!plainObject(value)) {
    const safeValue = /\.origins?\[?\d*\]?$/.test(path) ? safeOrigin(value)
      : path.endsWith(".path") ? safeResourcePath(value)
        : value;
    addDiagnostic(attributes, path, safeValue);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (!RENDERER_KEYS.has(key)) continue;
    flattenRenderer(item, `${path}.${key}`, attributes, depth + 1);
  }
}

function diagnosticAttributes(body: Record<string, unknown>): Record<string, string | number | boolean> {
  const attributes: Record<string, string | number | boolean> = {};
  for (const [root, keys] of Object.entries(DIAGNOSTIC_ROOT_KEYS)) {
    const value = plainObject(body[root]) ? body[root] : {};
    for (const key of keys) addDiagnostic(attributes, `${root}.${key}`, value[key]);
  }
  const resources = plainObject(body.resources) ? body.resources : {};
  for (const collection of ["brokenImages", "recent"] as const) {
    const entries = Array.isArray(resources[collection]) ? resources[collection].slice(0, 5) : [];
    entries.filter(plainObject).forEach((entry, index) => {
      const origin = safeOrigin(entry.origin);
      for (const key of RESOURCE_KEYS) {
        const value = key === "origin" ? origin : key === "path" ? safeResourcePath(entry.path, origin) : entry[key];
        addDiagnostic(attributes, `resources.${collection}[${index}].${key}`, value);
      }
    });
  }
  if (plainObject(body.renderer)) flattenRenderer(body.renderer, "renderer", attributes);
  return attributes;
}

function baseEvent(body: unknown): BaseEvent | null {
  if (!plainObject(body)) return null;
  const eventId = boundedString(body.eventId, 100);
  const siteId = boundedString(body.siteId, 100);
  if (!eventId || !siteId) return null;
  const occurredAt = boundedString(body.occurredAt, 40);
  return {
    eventId,
    siteId,
    environment: boundedString(body.environment, 60) || null,
    widgetVersion: boundedString(body.widgetVersion, 100) || "unknown",
    occurredAt: Number.isFinite(Date.parse(occurredAt)) ? new Date(occurredAt).toISOString() : null,
  };
}

function validateFailure(body: unknown, stages = SCREENSHOT_FAILURE_STAGES): ScreenshotFailure | null {
  const base = baseEvent(body);
  if (!base || !plainObject(body)) return null;
  const stage = boundedString(body.stage, 40);
  if (!stages.has(stage)) return null;
  const viewport = plainObject(body.viewport) ? body.viewport : {};
  const page = plainObject(body.page) ? body.page : {};
  const cspViolations = Array.isArray(body.cspViolations)
    ? body.cspViolations.slice(0, 3).filter(plainObject).map((violation) => ({
        effectiveDirective: boundedString(violation.effectiveDirective, 80).replace(/[^a-z0-9_-]/gi, "") || "unknown",
        blockedResource: safeOrigin(violation.blockedResource) || "unknown",
        sourceFile: safeDiagnosticString(violation.sourceFile, 200) || null,
        disposition: ["enforce", "report"].includes(String(violation.disposition)) ? String(violation.disposition) : "enforce",
      }))
    : [];
  return {
    ...base,
    stage,
    errorType: boundedString(body.errorType, 100) || "Error",
    errorMessage: safeDiagnosticString(body.errorMessage, 500) || "Screenshot failure",
    errorStack: safeDiagnosticString(body.errorStack, 600) || null,
    captureMode: CAPTURE_MODES.has(String(body.captureMode)) ? String(body.captureMode) : "unknown",
    viewportWidth: boundedNumber(viewport.width, 20_000),
    viewportHeight: boundedNumber(viewport.height, 20_000),
    devicePixelRatio: boundedNumber(viewport.devicePixelRatio, 10),
    pageNodeCount: boundedNumber(page.nodeCount, 1_000_000),
    pageImageCount: boundedNumber(page.imageCount, 100_000),
    pageIframeCount: boundedNumber(page.iframeCount, 10_000),
    pageCanvasCount: boundedNumber(page.canvasCount, 10_000),
    pageSvgCount: boundedNumber(page.svgCount, 100_000),
    fontStatus: boundedString(page.fontStatus, 30) || "unknown",
    visibilityState: boundedString(page.visibilityState, 30) || "unknown",
    cspViolations,
    attributes: diagnosticAttributes(body),
  };
}

async function requestIdentity(context: TelemetryContext, event: BaseEvent, allowAnyOrigin: boolean): Promise<RequestIdentity | Response> {
  const site = await getCaptureSite(context.env.DB, event.siteId);
  if (!site || site.noxspot_enabled === 0) return context.json({ error: "Site not found" }, 404);
  const origin = requestOrigin(context.req.raw);
  if (!origin) return context.json({ error: "Origin required" }, 403);
  if (!allowAnyOrigin && !originAllowed(parseWidgetConfig(site.widget_config), origin)) {
    return context.json({ error: "This origin is not enabled for the site" }, 403);
  }
  try { return { originHost: new URL(origin).hostname.toLowerCase() }; }
  catch { return context.json({ error: "Invalid origin" }, 403); }
}

function clientIp(context: TelemetryContext): string {
  return context.req.header("CF-Connecting-IP") || context.req.header("X-Forwarded-For") || "unknown";
}

async function rateLimited(context: TelemetryContext, kind: string, siteId: string): Promise<boolean> {
  if (await checkRateLimit(context.env, `${kind}:ip:${clientIp(context)}`, IP_RATE_LIMIT, RATE_LIMIT_WINDOW_MS)) return true;
  return checkRateLimit(context.env, `${kind}:site:${siteId}`, SITE_RATE_LIMIT, RATE_LIMIT_WINDOW_MS);
}

function uuidFromBytes(bytes: Uint8Array): string {
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes.slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function eventUuid(kind: string, siteId: string, sourceEventId: string): Promise<string> {
  const input = new TextEncoder().encode(`noxspot\u0000${kind}\u0000${siteId}\u0000${sourceEventId}`);
  return uuidFromBytes(new Uint8Array(await crypto.subtle.digest("SHA-1", input)));
}

async function sendNoxCue(context: TelemetryContext, payload: Record<string, unknown>): Promise<void> {
  const ingestKey = Reflect.get(context.env, "NOXCUE_INGEST_KEY");
  if (typeof ingestKey !== "string" || !ingestKey) throw new Error("NoxCue ingest key is unavailable");
  const response = await context.env.NOXCUE_INGEST.fetch(NOXCUE_EVENT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Nox-Ingest-Key": ingestKey },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`NoxCue rejected telemetry with status ${response.status}`);
}

function schedule(context: TelemetryContext, promise: Promise<void>, event: BaseEvent): void {
  context.executionCtx.waitUntil(promise.catch((error) => {
    console.error(JSON.stringify({
      event: "noxspot.noxcue.delivery_failed",
      siteId: event.siteId,
      sourceEventId: event.eventId,
      error: error instanceof Error ? error.message : String(error),
    }));
  }));
}

async function confirmNoxCueError(
  context: TelemetryContext,
  event: BaseEvent,
  delivery: Promise<void>,
): Promise<Response | null> {
  try {
    await delivery;
    return null;
  } catch (error) {
    console.error(JSON.stringify({
      event: "noxspot.noxcue.delivery_failed",
      siteId: event.siteId,
      sourceEventId: event.eventId,
      error: error instanceof Error ? error.message : String(error),
    }));
    const response = context.json({ error: "Telemetry storage unavailable" }, 503);
    response.headers.set("Retry-After", "5");
    return response;
  }
}

async function sendActivity(context: TelemetryContext, metric: string, event: BaseEvent): Promise<void> {
  await sendNoxCue(context, {
    version: 1,
    type: "activity.occurred",
    metric,
    eventId: await eventUuid(metric, event.siteId, event.eventId),
    userId: event.siteId,
    ...(event.occurredAt ? { occurredAt: event.occurredAt } : {}),
  });
}

function screenshotErrorCode(event: ScreenshotFailure): string {
  if (event.cspViolations.length) return "SCREENSHOT_CSP_OBSERVED";
  if (/securityerror|taint/i.test(`${event.errorType} ${event.errorMessage}`)) return "SCREENSHOT_CANVAS_TAINTED";
  if (/timeout|timed out/i.test(event.errorMessage)) return "SCREENSHOT_TIMEOUT";
  return `SCREENSHOT_${event.stage.toUpperCase()}`;
}

function screenshotErrorMessage(event: ScreenshotFailure, identity: RequestIdentity): string {
  const lines = [
    `Stage: ${event.stage}; ${event.errorType}: ${event.errorMessage}`,
    `Origin: ${identity.originHost}; environment: ${event.environment || "unknown"}; widget: ${event.widgetVersion}; mode: ${event.captureMode}`,
    `Viewport: ${event.viewportWidth}x${event.viewportHeight} @ ${event.devicePixelRatio}x; page nodes: ${event.pageNodeCount}; images: ${event.pageImageCount}; iframes: ${event.pageIframeCount}; canvases: ${event.pageCanvasCount}; SVGs: ${event.pageSvgCount}; fonts: ${event.fontStatus}; visibility: ${event.visibilityState}`,
  ];
  for (const violation of event.cspViolations) {
    lines.push(`CSP observed: ${violation.effectiveDirective} blocked ${violation.blockedResource} (${violation.disposition})`);
  }
  const phase = event.attributes["renderer.phase"];
  const svgCharacters = event.attributes["renderer.svgCharacters"];
  const sourceOrder = Object.entries(event.attributes)
    .filter(([key]) => key.startsWith("renderer.sourceOrder["))
    .map(([, value]) => value).join(" → ");
  if (phase || svgCharacters || sourceOrder) {
    lines.push(`Renderer: phase ${phase || "unknown"}; SVG chars ${svgCharacters || "unknown"}; sources ${sourceOrder || "unknown"}`);
  }
  if (event.errorStack) lines.push(`Stack: ${event.errorStack}`);
  return lines.join("\n").slice(0, 2_000);
}

async function sendFailureError(context: TelemetryContext, event: ScreenshotFailure, identity: RequestIdentity): Promise<void> {
  const errorCode = screenshotErrorCode(event);
  await sendNoxCue(context, {
    version: 1,
    type: "error.occurred",
    eventId: await eventUuid("error.screenshot.failure", event.siteId, event.eventId),
    title: "NoxSpot screenshot capture failed",
    level: "error",
    message: screenshotErrorMessage(event, identity),
    occurredAt: event.occurredAt || new Date().toISOString(),
    url: `https://${identity.originHost}`,
    data: {
      errorCode,
      fingerprint: `screenshot:${event.stage}:${event.errorType}:${errorCode}`.slice(0, 200),
      component: `screenshot.${event.stage}`,
      // NoxCue owns its canonical environment. The site's human-readable
      // environment remains in the message without overriding source routing.
      fatal: false,
      unhandled: false,
      attributes: event.attributes,
    },
  });
}

async function sendWidgetFailureError(context: TelemetryContext, event: ScreenshotFailure, identity: RequestIdentity): Promise<void> {
  const errorCode = `WIDGET_${event.stage.toUpperCase()}`;
  await sendNoxCue(context, {
    version: 1,
    type: "error.occurred",
    eventId: await eventUuid("error.widget.failure", event.siteId, event.eventId),
    title: "NoxSpot widget operation failed",
    level: "error",
    message: screenshotErrorMessage(event, identity),
    occurredAt: event.occurredAt || new Date().toISOString(),
    url: `https://${identity.originHost}`,
    data: {
      errorCode,
      fingerprint: `widget:${event.stage}:${event.errorType}:${errorCode}`.slice(0, 200),
      component: `widget.${event.stage}`,
      // NoxCue owns its canonical environment. The site's human-readable
      // environment remains in the message without overriding source routing.
      fatal: false,
      unhandled: event.stage === "runtime",
      attributes: event.attributes,
    },
  });
}

export async function receiveScreenshotFailure(context: TelemetryContext, body: unknown): Promise<Response> {
  const event = validateFailure(body);
  if (!event) return context.json({ error: "Invalid screenshot failure event" }, 400);
  if (await rateLimited(context, "screenshot-failure-telemetry", event.siteId)) return context.json({ error: "Too many telemetry events" }, 429);
  const identity = await requestIdentity(context, event, true);
  if (identity instanceof Response) return identity;
  console.error(JSON.stringify({ event: "noxspot.screenshot.failure", ...event, originHost: identity.originHost }));
  const storageFailure = await confirmNoxCueError(context, event, sendFailureError(context, event, identity));
  if (storageFailure) return storageFailure;
  schedule(context, sendActivity(context, METRICS.screenshotFailed, event), event);
  return context.body(null, 202);
}

export async function receiveWidgetFailure(context: TelemetryContext, body: unknown): Promise<Response> {
  const event = validateFailure(body, WIDGET_FAILURE_STAGES);
  if (!event) return context.json({ error: "Invalid widget failure event" }, 400);
  if (await rateLimited(context, "widget-failure-telemetry", event.siteId)) return context.json({ error: "Too many telemetry events" }, 429);
  const identity = await requestIdentity(context, event, true);
  if (identity instanceof Response) return identity;
  console.error(JSON.stringify({ event: "noxspot.widget.failure", ...event, originHost: identity.originHost }));
  const storageFailure = await confirmNoxCueError(context, event, sendWidgetFailureError(context, event, identity));
  if (storageFailure) return storageFailure;
  return context.body(null, 202);
}

export async function receiveScreenshotOutcome(context: TelemetryContext, body: unknown): Promise<Response> {
  const event = baseEvent(body);
  if (!event || !plainObject(body) || event.widgetVersion === "unknown" || !CAPTURE_MODES.has(String(body.captureMode)) || !["success", "failed"].includes(String(body.outcome))) {
    return context.json({ error: "Invalid screenshot outcome event" }, 400);
  }
  if (await rateLimited(context, "screenshot-outcome-telemetry", event.siteId)) return context.json({ error: "Too many telemetry events" }, 429);
  const failed = body.outcome === "failed";
  const identity = await requestIdentity(context, event, failed);
  if (identity instanceof Response) return identity;
  console.log(JSON.stringify({ event: "noxspot.screenshot.capture", ...event, outcome: body.outcome, originHost: identity.originHost }));
  if (failed || event.environment?.toLowerCase() === "production") {
    schedule(context, sendActivity(context, failed ? METRICS.screenshotFailed : METRICS.screenshotCaptured, event), event);
  }
  return context.body(null, 202);
}

export async function receiveWidgetInstall(context: TelemetryContext, body: unknown): Promise<Response> {
  const event = baseEvent(body);
  if (!event || event.widgetVersion === "unknown") return context.json({ error: "Invalid widget install event" }, 400);
  if (await rateLimited(context, "widget-install-telemetry", event.siteId)) return context.json({ error: "Too many telemetry events" }, 429);
  const identity = await requestIdentity(context, event, false);
  if (identity instanceof Response) return identity;
  console.log(JSON.stringify({ event: "noxspot.widget.install.detected", ...event, originHost: identity.originHost }));
  if (event.environment?.toLowerCase() === "production") {
    schedule(context, sendActivity(context, METRICS.widgetInstalled, event), event);
  }
  return context.body(null, 202);
}
