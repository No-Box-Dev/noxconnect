import { z } from "zod";

export const DEFAULT_NOXSPOT_RESOLUTION_TEMPLATE = Object.freeze({
  tone: "default",
  subject: "Resolved: {{report_title}}",
  acknowledgement: "Thanks for reporting “{{report_title}}”.",
  reopenText: "Still seeing the problem? Reopen the ticket and add more details or a screenshot if helpful.",
  buttonLabel: "Reopen the ticket",
  closing: "Thank you again for helping us improve {{site_name}}.",
  replyTo: null,
});

const Email = z.string().trim().email().max(254);
const ALLOWED_TEMPLATE_VARIABLES = new Set(["report_title", "site_name"]);
const TemplateField = (max) => z.string().trim().min(1).max(max).superRefine((value, ctx) => {
  for (const match of value.matchAll(/\{\{([^{}]+)\}\}/g)) {
    if (!ALLOWED_TEMPLATE_VARIABLES.has(match[1])) {
      ctx.addIssue({ code: "custom", message: `Unsupported template variable: {{${match[1]}}}` });
    }
  }
  if (/\{\{|\}\}/.test(value.replace(/\{\{(?:report_title|site_name)\}\}/g, ""))) {
    ctx.addIssue({ code: "custom", message: "Invalid template variable syntax" });
  }
});

export const NoxSpotResolutionTemplateSchema = z.object({
  tone: z.enum(["default", "warm", "formal", "concise"]),
  subject: TemplateField(200),
  acknowledgement: TemplateField(500),
  reopenText: TemplateField(500),
  buttonLabel: TemplateField(60),
  closing: TemplateField(500),
  replyTo: Email.nullable(),
}).strict();

export function resolutionTemplateFromWidgetConfig(raw) {
  let config = {};
  try { config = typeof raw === "string" ? JSON.parse(raw || "{}") : raw || {}; } catch { config = {}; }
  const custom = config?.resolutionEmail;
  const parsed = NoxSpotResolutionTemplateSchema.safeParse(custom);
  return {
    template: parsed.success ? parsed.data : { ...DEFAULT_NOXSPOT_RESOLUTION_TEMPLATE },
    usingDefault: !parsed.success,
    widgetConfig: config && typeof config === "object" && !Array.isArray(config) ? config : {},
  };
}

export function renderResolutionTemplate(template, variables) {
  const parsed = NoxSpotResolutionTemplateSchema.parse(template);
  const replace = (value) => value.replace(/\{\{(report_title|site_name)\}\}/g, (_match, key) => String(variables[key] ?? ""));
  return {
    ...parsed,
    subject: replace(parsed.subject),
    acknowledgement: replace(parsed.acknowledgement),
    reopenText: replace(parsed.reopenText),
    buttonLabel: replace(parsed.buttonLabel),
    closing: replace(parsed.closing),
  };
}

export async function resolutionTemplateRevision(template) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(template)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function resolutionToneInstruction(tone) {
  return {
    warm: "Use a warm and reassuring tone while staying concise.",
    formal: "Use a professional and formal tone while keeping the language plain.",
    concise: "Use the shortest clear wording allowed by the required structure.",
  }[tone] ?? "Use a warm, direct, and concise tone.";
}
