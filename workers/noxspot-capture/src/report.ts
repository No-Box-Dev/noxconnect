import type { CaptureSite } from "./site-config";

export const MAX_REPORT_BODY_BYTES = 7_500_000;
export const MAX_ERROR_BODY_BYTES = 128_000;
const MAX_QUEUE_MESSAGE_BYTES = 120_000;
const MAX_METADATA_BYTES = 32_000;
const MAX_CONTEXT_BYTES = 24_000;
const MAX_ELEMENTS_BYTES = 40_000;
const MAX_BLOCK_VALUES_BYTES = 32_000;

export interface ReportParams {
  attemptId: string | null;
  siteId: string;
  title: string;
  description: string | null;
  reporter: string | null;
  reporterEmail: string | null;
  environment: string | null;
  screenshot: string | null;
  metadata: Record<string, unknown> | null;
  elements: Record<string, unknown>[] | null;
  context: Record<string, unknown> | null;
  type: "bug" | "feature" | "feedback";
  rating: number | null;
  blockValues: Record<string, string> | null;
}

export interface CaptureTask {
  version: 1;
  type: "spot_create_github_issue";
  captureId: string;
  orgId: number;
  ownerId: string;
  projectId: string | null;
  repo: string;
  siteId: string;
  siteName: string;
  slackChannelId: string | null;
  slackConnectionId: string | null;
  issueType: "bug" | "feature" | "feedback" | "error";
  title: string;
  description: string | null;
  reporter: string | null;
  reporterEmail: string | null;
  environment: string | null;
  screenshotUrl: string | null;
  metadata: Record<string, unknown> | null;
  elements: Record<string, unknown>[] | null;
  context: Record<string, unknown> | null;
  blockValues: Record<string, string> | null;
  rating: number | null;
  deliveryId: string;
}

interface ValidationError { ok: false; error: string; status: number }
interface ValidationSuccess { ok: true; params: ReportParams }

const encoder = new TextEncoder();

function serializedBytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).byteLength;
}

function exceedsBytes(value: unknown, limit: number): boolean {
  try { return value != null && serializedBytes(value) > limit; }
  catch { return true; }
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function validateReportInput(body: unknown): ValidationError | ValidationSuccess {
  if (!plainObject(body)) return { ok: false, error: "Invalid JSON object", status: 400 };
  const { attemptId, siteId, title, description, reporter, reporterEmail, environment, screenshot, metadata, elements, context, type, rating, blockValues } = body;

  if (typeof siteId !== "string" || !siteId || typeof title !== "string" || !title) {
    return { ok: false, error: "Missing required fields: siteId, title", status: 400 };
  }
  if (siteId.length > 120 || title.length > 256) return { ok: false, error: "Site ID or title is too long", status: 400 };
  if (attemptId != null && (typeof attemptId !== "string" || !/^[A-Za-z0-9:_-]{1,100}$/.test(attemptId))) {
    return { ok: false, error: "Invalid attempt ID", status: 400 };
  }
  if (description != null && typeof description !== "string") return { ok: false, error: "Invalid description", status: 400 };
  if (typeof description === "string" && description.length > 10_000) return { ok: false, error: "Description too long", status: 400 };
  if (screenshot != null && typeof screenshot !== "string") return { ok: false, error: "Invalid screenshot", status: 400 };
  if (typeof screenshot === "string" && (screenshot.length > 7_000_000 || !/^data:image\/(png|jpeg|webp);base64,/.test(screenshot))) {
    return { ok: false, error: "Invalid or oversized screenshot", status: 400 };
  }
  if (metadata != null && !plainObject(metadata)) return { ok: false, error: "Invalid metadata", status: 400 };
  if (context != null && !plainObject(context)) return { ok: false, error: "Invalid context", status: 400 };
  if (elements != null && (!Array.isArray(elements) || elements.some((element) => !plainObject(element)))) {
    return { ok: false, error: "Invalid elements", status: 400 };
  }
  if (Array.isArray(elements) && elements.length > 50) return { ok: false, error: "Too many elements", status: 400 };
  if (Array.isArray((metadata as Record<string, unknown> | null)?.consoleErrors) && ((metadata as Record<string, unknown>).consoleErrors as unknown[]).length > 50) {
    return { ok: false, error: "Too many console entries", status: 400 };
  }
  if (exceedsBytes(metadata, MAX_METADATA_BYTES) || exceedsBytes(context, MAX_CONTEXT_BYTES) || exceedsBytes(elements, MAX_ELEMENTS_BYTES)) {
    return { ok: false, error: "Capture evidence is too large", status: 400 };
  }
  if (blockValues != null && (!plainObject(blockValues) || Object.keys(blockValues).length > 30 ||
      Object.entries(blockValues).some(([key, value]) => key.length > 120 || typeof value !== "string" || value.length > 10_000))) {
    return { ok: false, error: "Invalid custom field values", status: 400 };
  }
  if (exceedsBytes(blockValues, MAX_BLOCK_VALUES_BYTES)) return { ok: false, error: "Custom field values are too large", status: 400 };
  if (rating != null && (!Number.isInteger(rating) || Number(rating) < 1 || Number(rating) > 5)) return { ok: false, error: "Invalid rating", status: 400 };
  if (type != null && !["bug", "feature", "feedback"].includes(String(type))) return { ok: false, error: "Invalid report type", status: 400 };
  if (reporter != null && typeof reporter !== "string") return { ok: false, error: "Invalid reporter", status: 400 };
  if (reporterEmail != null && typeof reporterEmail !== "string") return { ok: false, error: "Invalid reporter email", status: 400 };
  if (environment != null && (typeof environment !== "string" || environment.length > 60)) return { ok: false, error: "Invalid environment", status: 400 };

  const reporterValue = typeof reporter === "string" ? reporter.trim() : "";
  const emailValue = typeof reporterEmail === "string" ? reporterEmail.trim() : "";
  if (reporterValue.length > 100) return { ok: false, error: "Reporter is too long", status: 400 };
  if (emailValue.length > 254 || (emailValue && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailValue))) {
    return { ok: false, error: "Invalid reporter email", status: 400 };
  }

  return {
    ok: true,
    params: {
      attemptId: typeof attemptId === "string" ? attemptId : null,
      siteId,
      title,
      description: typeof description === "string" ? description : null,
      reporter: reporterValue || null,
      reporterEmail: emailValue || null,
      environment: typeof environment === "string" ? environment : null,
      screenshot: typeof screenshot === "string" ? screenshot : null,
      metadata: plainObject(metadata) ? metadata : null,
      elements: Array.isArray(elements) ? elements as Record<string, unknown>[] : null,
      context: plainObject(context) ? context : null,
      type: (["bug", "feature", "feedback"].includes(String(type)) ? type : "bug") as ReportParams["type"],
      rating: typeof rating === "number" ? rating : null,
      blockValues: plainObject(blockValues) ? blockValues as Record<string, string> : null,
    },
  };
}

interface ScreenshotTarget {
  key: string;
  url: string;
  contentType: string;
}

export function screenshotTarget(siteId: string, captureId: string, screenshot: string | null, assetBaseUrl: string): ScreenshotTarget | null {
  if (!screenshot) return null;
  const match = screenshot.match(/^data:image\/(png|jpeg|webp);base64,/);
  if (!match) return null;
  const type = match[1] === "jpeg" ? "jpeg" : match[1];
  const extension = type === "jpeg" ? "jpg" : type;
  const key = `screenshots/${siteId}/${captureId}.${extension}`;
  return { key, url: `${assetBaseUrl.replace(/\/$/, "")}/${key}`, contentType: `image/${type}` };
}

export async function putScreenshot(bucket: R2Bucket, target: ScreenshotTarget, screenshot: string): Promise<void> {
  const encoded = screenshot.slice(screenshot.indexOf(",") + 1);
  const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
  await bucket.put(target.key, bytes, { httpMetadata: { contentType: target.contentType } });
}

export function buildCaptureTask(args: {
  site: CaptureSite;
  params: ReportParams;
  captureId: string;
  screenshotUrl: string | null;
  issueType?: CaptureTask["issueType"];
}): CaptureTask {
  const { site, params, captureId, screenshotUrl } = args;
  return {
    version: 1,
    type: "spot_create_github_issue",
    captureId,
    orgId: site.org_id,
    ownerId: site.github_login,
    projectId: site.project_id,
    repo: site.repo,
    siteId: site.id,
    siteName: site.site_name,
    slackChannelId: site.slack_channel_id,
    slackConnectionId: site.slack_connection_id,
    issueType: args.issueType ?? params.type,
    title: params.title,
    description: params.description,
    reporter: params.reporter,
    reporterEmail: params.reporterEmail,
    environment: params.environment,
    screenshotUrl,
    metadata: params.metadata,
    elements: params.elements,
    context: params.context,
    blockValues: params.blockValues,
    rating: params.rating,
    deliveryId: `noxspot:${captureId}`,
  };
}

export function validateQueueTask(task: CaptureTask): CaptureTask {
  if (serializedBytes(task) > MAX_QUEUE_MESSAGE_BYTES) throw new Error("Capture exceeds Queue message size");
  return task;
}

export async function deleteExpiredScreenshots(bucket: R2Bucket, now = Date.now(), retentionDays = 90): Promise<number> {
  const cutoff = now - retentionDays * 86_400_000;
  let cursor: string | undefined;
  let deleted = 0;
  do {
    const listing = await bucket.list({ prefix: "screenshots/", cursor });
    const keys = listing.objects.filter((object) => object.uploaded.getTime() < cutoff).map((object) => object.key);
    if (keys.length) {
      await bucket.delete(keys);
      deleted += keys.length;
    }
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor);
  return deleted;
}
