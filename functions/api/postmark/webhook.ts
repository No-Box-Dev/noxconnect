import { z } from "zod";

const POSTMARK_WEBHOOK_IPS = new Set([
  "3.134.147.250",
  "50.31.156.6",
  "50.31.156.77",
  "18.217.206.57",
]);
const MAX_BODY_BYTES = 64 * 1024;

const webhookEventSchema = z.object({
  RecordType: z.enum(["Delivery", "Bounce", "SpamComplaint"]),
  MessageID: z.string().min(1).max(200),
  MessageStream: z.string().min(1).max(100).optional().default("outbound"),
  Tag: z.string().max(200).nullish(),
  Recipient: z.string().email().max(320).optional(),
  Email: z.string().email().max(320).optional(),
  DeliveredAt: z.string().max(100).optional(),
  BouncedAt: z.string().max(100).optional(),
  Type: z.string().max(100).optional(),
  TypeCode: z.number().int().optional(),
}).refine((event) => Boolean(event.Recipient || event.Email), {
  message: "Recipient is required",
});

type WebhookContext = {
  request: Request;
  env: { DB: D1Database; POSTMARK_WEBHOOK_SECRET?: string };
};

export async function onRequestPost(context: WebhookContext): Promise<Response> {
  const sourceIp = context.request.headers.get("CF-Connecting-IP")?.trim();
  if (!sourceIp || !POSTMARK_WEBHOOK_IPS.has(sourceIp)) return forbidden();

  const secret = context.env.POSTMARK_WEBHOOK_SECRET;
  if (!secret || !(await validBasicAuth(context.request.headers.get("Authorization"), secret))) {
    return forbidden();
  }

  const declaredLength = Number(context.request.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return Response.json({ error: "payload_too_large" }, { status: 413 });
  }

  const rawBody = await context.request.text();
  if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
    return Response.json({ error: "payload_too_large" }, { status: 413 });
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(rawBody);
  } catch {
    return badRequest();
  }
  const parsed = webhookEventSchema.safeParse(decoded);
  if (!parsed.success) return badRequest();

  const event = parsed.data;
  const recipient = (event.Recipient || event.Email)!.trim().toLowerCase();
  const recipientHash = await sha256(recipient);
  const traceId = context.request.headers.get("X-PM-Webhook-Trace-Id")?.trim();
  const providerEventId = traceId && traceId.length <= 200
    ? `trace:${traceId}`
    : `payload:${await sha256(rawBody)}`;
  const eventType = event.RecordType === "Delivery"
    ? "delivery"
    : event.RecordType === "Bounce" ? "bounce" : "spam_complaint";
  const providerEventAt = event.DeliveredAt || event.BouncedAt || new Date().toISOString();
  const detailCode = event.TypeCode === undefined
    ? event.Type ?? null
    : String(event.TypeCode);

  await context.env.DB.prepare(
    `INSERT INTO transactional_email_events
       (id, event_type, message_id, message_stream, tag, recipient_hash,
        status, provider_event_at, detail_code)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  ).bind(
    providerEventId,
    eventType,
    event.MessageID,
    event.MessageStream,
    event.Tag ?? null,
    recipientHash,
    eventType === "delivery" ? "delivered" : eventType,
    providerEventAt,
    detailCode,
  ).run();

  return Response.json({ accepted: true }, {
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

export function onRequest(): Response {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}

async function validBasicAuth(header: string | null, expectedSecret: string): Promise<boolean> {
  if (!header?.startsWith("Basic ")) return false;
  let decoded: string;
  try {
    decoded = atob(header.slice(6));
  } catch {
    return false;
  }
  const separator = decoded.indexOf(":");
  if (separator < 0 || decoded.slice(0, separator) !== "postmark") return false;
  const [provided, expected] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(decoded.slice(separator + 1))),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(expectedSecret)),
  ]);
  const left = new Uint8Array(provided);
  const right = new Uint8Array(expected);
  let difference = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function forbidden(): Response {
  return Response.json({ error: "forbidden" }, {
    status: 403,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

function badRequest(): Response {
  return Response.json({ error: "invalid_webhook" }, {
    status: 400,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}
