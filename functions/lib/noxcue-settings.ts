import { z } from "zod";

const shortText = (max: number) => z.string().trim().min(1).max(max);
const exactOrigin = z.string().trim().max(300).refine((value) => {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:")
      && url.origin === value.replace(/\/$/, "") && url.username === "" && url.password === "";
  } catch { return false; }
}, "Use an exact web origin such as https://app.example.com");

function safeHealthUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return false;
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(":")) return false;
    return true;
  } catch { return false; }
}
export const cueSourceInputSchema = z.object({
  name: shortText(120),
  environment: z.enum(["production", "staging", "development", "preview", "test", "local"]).default("production"),
  enabled: z.boolean().default(true),
  alertsEnabled: z.boolean().default(true),
  projectId: z.string().trim().min(1).max(200).optional(),
  timezone: z.string().trim().min(1).max(100).refine((value) => {
    try { new Intl.DateTimeFormat("en", { timeZone: value }).format(); return true; }
    catch { return false; }
  }, "Use an IANA timezone such as Asia/Kuala_Lumpur").default("UTC"),
  digestEnabled: z.boolean().default(true),
  digestTimeLocal: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).default("00:30"),
  slackChannelId: z.string().trim().min(1).max(100).nullable().default(null),
  slackConnectionId: z.string().trim().min(1).max(100).nullable().default(null),
  allowedOrigins: z.array(exactOrigin).max(10).default([]),
  healthEnabled: z.boolean().default(false),
  healthUrl: z.string().trim().max(2_048).refine(safeHealthUrl, "Use a public HTTPS URL without credentials or a custom port").nullable().default(null),
}).strict().superRefine((value, ctx) => {
  if (value.healthEnabled && !value.healthUrl) {
    ctx.addIssue({ code: "custom", path: ["healthUrl"], message: "Add a health URL before enabling checks" });
  }
});

export const createCueKeySchema = z.object({
  name: shortText(80),
  kind: z.enum(["publishable", "secret"]),
}).strict();

export async function hashCueKey(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createCueKey(kind: "publishable" | "secret" = "secret"): string {
  const random = new Uint8Array(32);
  crypto.getRandomValues(random);
  const token = btoa(String.fromCharCode(...random))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  return `nox_${kind === "publishable" ? "pub" : "secret"}_${token}`;
}
