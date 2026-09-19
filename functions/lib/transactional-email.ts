import { z } from "zod";

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
      Subject: rendered.subject,
      TextBody: rendered.text,
      HtmlBody: rendered.html,
      MessageStream: rendered.stream,
      TrackOpens: false,
      TrackLinks: "None",
      Tag: rendered.tag,
      Metadata: {
        request_id: command.requestId,
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

function render(command: TransactionalEmailCommand, env: EmailEnvironment) {
  if (command.template === "noxspot.resolution") {
    const from = env.NOXSPOT_EMAIL_FROM;
    if (!from) throw new Error("NoxSpot email sender is not configured");
    const summary = resolutionSummary(command.model.summary);
    const action = command.model.responseUrl
      ? `\n\nStill seeing the problem? Reopen this report and add more details or a screenshot if helpful:\n${command.model.responseUrl}`
      : "";
    const actionHtml = command.model.responseUrl
      ? `<p>Still seeing the problem? Reopen this report and add more details or a screenshot if helpful.</p><p style="margin:28px 0"><a href="${escapeHtml(command.model.responseUrl)}" style="background:#1c1917;color:white;padding:12px 18px;border-radius:8px;text-decoration:none">Reopen this report</a></p>`
      : "";
    const greeting = command.model.reporterName ? `Hi ${command.model.reporterName},\n\n` : "";
    const greetingHtml = command.model.reporterName ? `<p>Hi ${escapeHtml(command.model.reporterName)},</p>` : "";
    return {
      from: `NoxSpot <${from}>`,
      subject: `Resolved: ${command.model.reportTitle}`,
      text: `${greeting}Thanks for reporting “${command.model.reportTitle}”.\n\n${summary}${action}\n\n— The ${command.model.siteName} team, via NoxSpot`,
      html: layout(
        `Resolved: ${command.model.reportTitle}`,
        `${greetingHtml}<p>Thanks for reporting “${escapeHtml(command.model.reportTitle)}”.</p>${paragraphs(summary)}${actionHtml}<p style="font-size:13px;color:#78716c">— The ${escapeHtml(command.model.siteName)} team, via NoxSpot</p>`,
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
