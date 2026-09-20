import { z } from "zod";
import {
  DEFAULT_NOXSPOT_RESOLUTION_TEMPLATE,
  NoxSpotResolutionTemplateSchema,
  renderResolutionTemplate,
  resolutionEmailFontStacks,
} from "./noxspot-resolution-template.js";

const Email = z.string().trim().email().max(254);
const HttpUrl = z.string().url().max(3_000).refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "https:" || protocol === "http:";
}, "Expected an HTTP(S) URL");

const BaseCommand = z.object({
  contract: z.literal("noxconnect.transactional-email"),
  version: z.literal(1),
  requestId: z.string().trim().min(1).max(200),
  recipient: Email,
}).strict();

const PlatformCommand = BaseCommand.extend({
  template: z.enum(["platform.email-login", "platform.guest-invitation"]),
  model: z.object({
    subject: z.string().trim().min(1).max(300),
    heading: z.string().trim().min(1).max(300),
    detail: z.string().trim().min(1).max(2_000),
    actionUrl: HttpUrl,
  }).strict(),
}).strict();

const NoxSpotResolutionCommand = BaseCommand.extend({
  template: z.literal("noxspot.resolution"),
  model: z.object({
    siteName: z.string().trim().min(1).max(200),
    reportTitle: z.string().trim().min(1).max(300),
    summary: z.string().trim().min(1).max(4_000),
    reporterName: z.string().trim().min(1).max(100).optional(),
    responseUrl: HttpUrl.optional(),
    // Optional for backward compatibility with already-running internal callers.
    presentation: NoxSpotResolutionTemplateSchema.optional(),
  }).strict(),
}).strict();

const TransactionalEmailCommand = z.discriminatedUnion("template", [
  PlatformCommand,
  NoxSpotResolutionCommand,
]);

export type TransactionalEmailCommand = z.infer<typeof TransactionalEmailCommand>;

interface EmailEnvironment {
  POSTMARK_SERVER_TOKEN?: string;
  PLATFORM_EMAIL_FROM?: string;
  NOXSPOT_EMAIL_FROM?: string;
}

interface PostmarkResponse {
  ErrorCode?: number;
  Message?: string;
  MessageID?: string;
  SubmittedAt?: string;
}

export interface TransactionalEmailReceipt {
  contract: "noxconnect.transactional-email-receipt";
  version: 1;
  requestId: string;
  template: TransactionalEmailCommand["template"];
  status: "accepted";
  provider: "postmark";
  messageId: string;
  submittedAt: string | null;
}

export async function sendTransactionalEmail(
  env: EmailEnvironment,
  rawCommand: unknown,
): Promise<TransactionalEmailReceipt> {
  const command = TransactionalEmailCommand.parse(rawCommand);
  if (!env.POSTMARK_SERVER_TOKEN) throw new Error("Postmark delivery is not configured");
  const rendered = render(command, env);
  const requestMetadata = await postmarkMetadataValue(command.requestId);
  const response = await fetch("https://api.postmarkapp.com/email", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Postmark-Server-Token": env.POSTMARK_SERVER_TOKEN,
    },
    body: JSON.stringify({
      From: rendered.from,
      To: command.recipient,
      ...(rendered.replyTo ? { ReplyTo: rendered.replyTo } : {}),
      Subject: rendered.subject,
      TextBody: rendered.text,
      HtmlBody: rendered.html,
      MessageStream: rendered.stream,
      TrackOpens: false,
      TrackLinks: "None",
      Tag: rendered.tag,
      Metadata: {
        request_id: requestMetadata,
        template: command.template,
      },
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const result = await response.json().catch(() => null) as PostmarkResponse | null;
  if (!response.ok || result?.ErrorCode !== 0 || !result.MessageID) {
    throw new Error(`Postmark email request failed (${response.status}:${result?.ErrorCode ?? "invalid"})`);
  }
  return {
    contract: "noxconnect.transactional-email-receipt",
    version: 1,
    requestId: command.requestId,
    template: command.template,
    status: "accepted",
    provider: "postmark",
    messageId: result.MessageID,
    submittedAt: typeof result.SubmittedAt === "string" ? result.SubmittedAt : null,
  };
}

async function postmarkMetadataValue(value: string): Promise<string> {
  if (value.length <= 80) return value;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const suffix = [...new Uint8Array(digest)]
    .slice(0, 8)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${value.slice(0, 63)}:${suffix}`;
}

function render(command: TransactionalEmailCommand, env: EmailEnvironment) {
  if (command.template === "noxspot.resolution") {
    const from = env.NOXSPOT_EMAIL_FROM;
    if (!from) throw new Error("NoxSpot email sender is not configured");
    const summary = resolutionSummary(command.model.summary);
    const presentation = renderResolutionTemplate(
      command.model.presentation ?? DEFAULT_NOXSPOT_RESOLUTION_TEMPLATE,
      {
      report_title: command.model.reportTitle,
      site_name: command.model.siteName,
      },
    );
    const appearance = presentation.appearance;
    const fonts = resolutionEmailFontStacks(appearance.fontPreset);
    const buttonTextColor = contrastingTextColor(appearance.accentColor);
    const action = command.model.responseUrl
      ? `\n\n${presentation.reopenText}\n${command.model.responseUrl}`
      : "";
    const actionHtml = command.model.responseUrl
      ? `<p style="margin:0 0 22px;color:${appearance.textColor};font-size:16px;line-height:1.6">${escapeHtml(presentation.reopenText)}</p><table role="presentation" border="0" cellpadding="0" cellspacing="0"><tr><td bgcolor="${appearance.accentColor}" style="border-radius:10px"><a href="${escapeHtml(command.model.responseUrl)}" style="display:inline-block;background:${appearance.accentColor};border:1px solid ${appearance.accentColor};border-radius:10px;color:${buttonTextColor};font-family:${fonts.body};font-size:15px;font-weight:700;line-height:20px;padding:13px 20px;text-decoration:none">${escapeHtml(presentation.buttonLabel)}</a></td></tr></table>`
      : "";
    const greeting = command.model.reporterName ? `Hi ${command.model.reporterName},\n\n` : "";
    const greetingHtml = command.model.reporterName ? `<p>Hi ${escapeHtml(command.model.reporterName)},</p>` : "";
    return {
      from: `${presentation.senderName} <${from}>`,
      replyTo: presentation.replyTo,
      subject: presentation.subject,
      text: `${greeting}${presentation.acknowledgement}\n\n${summary}${action}\n\n${presentation.closing}`,
      html: resolutionLayout(
        presentation.subject,
        command.model.siteName,
        `${greetingHtml}<p>${escapeHtml(presentation.acknowledgement)}</p>${paragraphs(summary)}${actionHtml}<p style="margin:28px 0 0">${escapeHtml(presentation.closing)}</p>`,
        presentation.replyTo,
        appearance,
        fonts,
      ),
      stream: "noxspot-resolutions",
      tag: "noxspot-resolution",
    };
  }

  const from = env.PLATFORM_EMAIL_FROM;
  if (!from) throw new Error("Platform email sender is not configured");
  const actionLabel = command.template === "platform.email-login" ? "Sign in to Nox" : "Continue to Nox";
  return {
    from: `Nox <${from}>`,
    replyTo: null,
    subject: command.model.subject,
    text: `${command.model.heading}\n\n${command.model.detail}\n\n${command.model.actionUrl}\n\nIf you did not expect this email, you can ignore it.`,
    html: layout(
      command.model.heading,
      `<p>${escapeHtml(command.model.detail)}</p><p style="margin:28px 0"><a href="${escapeHtml(command.model.actionUrl)}" style="background:#1c1917;color:white;padding:12px 18px;border-radius:8px;text-decoration:none">${actionLabel}</a></p><p style="font-size:12px;color:#78716c">If you did not expect this email, you can ignore it.</p>`,
    ),
    stream: "outbound",
    tag: command.template === "platform.guest-invitation" ? "guest-invitation" : "email-login",
  };
}

function resolutionSummary(value: string): string {
  // The template owns the greeting. Strip common AI-generated acknowledgements
  // as a final safeguard so reporters are never thanked twice.
  const withoutDuplicateThanks = value.replace(
    /^\s*(?:thank you|thanks) for reporting(?: this issue)?[.!]\s*/i,
    "",
  ).trim();
  return withoutDuplicateThanks || value.trim();
}

function layout(heading: string, body: string): string {
  return `<main style="font-family:system-ui,sans-serif;max-width:560px;margin:auto;padding:32px;color:#292524"><h1 style="font-size:24px">${escapeHtml(heading)}</h1>${body}</main>`;
}

function resolutionLayout(
  heading: string,
  siteName: string,
  body: string,
  replyTo: string | null,
  appearance: {
    accentColor: string;
    backgroundColor: string;
    surfaceColor: string;
    textColor: string;
    mutedColor: string;
  },
  fonts: { heading: string; body: string },
): string {
  const escapedSiteName = escapeHtml(siteName);
  const support = replyTo
    ? ` Reply to this email at <a href="mailto:${escapeHtml(replyTo)}" style="color:${appearance.mutedColor};text-decoration:underline">${escapeHtml(replyTo)}</a> if you need help.`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${escapeHtml(heading)}</title></head><body style="margin:0;background:${appearance.backgroundColor};color:${appearance.textColor};font-family:${fonts.body}"><div style="display:none;max-height:0;overflow:hidden;opacity:0">An update about the issue you reported to ${escapedSiteName}.</div><table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" style="width:100%;background:${appearance.backgroundColor}"><tr><td align="center" style="padding:32px 16px"><table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px"><tr><td style="padding:0 6px 18px;color:${appearance.accentColor};font-family:${fonts.heading};font-size:20px;font-weight:800;letter-spacing:-.3px">${escapedSiteName} <span style="color:${appearance.mutedColor};font-family:${fonts.body};font-size:13px;font-weight:500;letter-spacing:0">via NoxSpot</span></td></tr><tr><td style="background:${appearance.surfaceColor};border:2px solid ${appearance.textColor};border-radius:12px;padding:36px 38px;box-shadow:4px 4px 0 ${appearance.accentColor};font-family:${fonts.body}"><div style="color:${appearance.accentColor};font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase">Issue update</div><h1 style="margin:10px 0 24px;color:${appearance.textColor};font-family:${fonts.heading};font-size:27px;line-height:1.25;letter-spacing:-.5px">${escapeHtml(heading)}</h1><div style="color:${appearance.textColor};font-size:16px;line-height:1.65">${body}</div></td></tr><tr><td style="padding:20px 8px 0;color:${appearance.mutedColor};font-family:${fonts.body};font-size:12px;line-height:1.55">You received this transactional email because you asked to be notified when your ${escapedSiteName} report was resolved.${support}<br>Sent by NoxSpot for ${escapedSiteName}.</td></tr></table></td></tr></table></body></html>`;
}

function contrastingTextColor(hex: string): "#000000" | "#FFFFFF" {
  const [red, green, blue] = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16));
  const luminance = (red * 299 + green * 587 + blue * 114) / 1000;
  return luminance >= 150 ? "#000000" : "#FFFFFF";
}

function paragraphs(value: string): string {
  return value.split(/\n\s*\n/).filter(Boolean).map((part) => `<p>${escapeHtml(part)}</p>`).join("");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}
