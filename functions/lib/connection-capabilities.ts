import { z } from "zod";

export const CONNECTION_CAPABILITY_CONTRACT = "noxconnect.connection-capability" as const;
export const CONNECTION_CAPABILITY_VERSION = 1 as const;

const ServiceId = z.enum(["noxticket", "noxfeed", "noxspot", "noxcue"]);
const CapabilityId = z.enum([
  "github.issue.create",
  "github.issue.update",
  "github.issue.comment",
  "slack.message.deliver",
  "ai.complete",
]);
const Identifier = z.string().trim().min(1).max(200);
const ProjectId = z.string().trim().min(1).max(160);
const Repository = z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/);
const HttpUrl = z.string().url().max(3_000).refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "https:" || protocol === "http:";
}, "Expected an HTTP(S) URL");

const BaseCommand = z.object({
  contract: z.literal(CONNECTION_CAPABILITY_CONTRACT),
  version: z.literal(CONNECTION_CAPABILITY_VERSION),
  commandId: Identifier,
  idempotencyKey: Identifier,
  service: ServiceId,
  organizationId: z.number().int().positive(),
  projectId: ProjectId,
}).strict();

const GitHubLabel = z.object({
  name: z.string().trim().min(1).max(50),
  color: z.string().regex(/^[0-9a-fA-F]{6}$/),
  description: z.string().max(100).optional(),
}).strict();

const GitHubIssueFields = z.object({
  title: z.string().trim().min(1).max(256),
  body: z.string().max(64_000),
  labels: z.array(GitHubLabel).max(20).default([]),
  assignees: z.array(z.string().regex(/^[A-Za-z0-9-]{1,39}$/)).max(20).optional(),
}).strict();

const GitHubIssueCreate = BaseCommand.extend({
  capability: z.literal("github.issue.create"),
  input: z.object({
    repository: Repository,
    idempotencyMarker: z.string().trim().min(8).max(300),
    issue: GitHubIssueFields,
  }).strict(),
}).strict();

const GitHubIssueUpdate = BaseCommand.extend({
  capability: z.literal("github.issue.update"),
  input: z.object({
    repository: Repository,
    issueNumber: z.number().int().positive(),
    issue: GitHubIssueFields.partial().extend({ state: z.enum(["open", "closed"]).optional() })
      .refine((value) => Object.keys(value).length > 0, "At least one issue field is required"),
  }).strict(),
}).strict();

const GitHubIssueComment = BaseCommand.extend({
  capability: z.literal("github.issue.comment"),
  input: z.object({
    repository: Repository,
    issueNumber: z.number().int().positive(),
    body: z.string().trim().min(1).max(64_000),
  }).strict(),
}).strict();

export const SlackRouteKey = z.enum([
  "noxticket",
  "noxfeed_posts",
  "noxfeed_release_notes",
  "noxfeed_daily_summary",
  "noxspot",
  "noxcue",
  "noxcue_alerts",
]);

const SlackMessage = z.object({
  text: z.string().trim().min(1).max(4_000),
  blocks: z.array(z.record(z.string(), z.unknown())).max(50),
  client_msg_id: z.string().trim().min(1).max(200).optional(),
}).strict().superRefine((message, context) => {
  const bytes = new TextEncoder().encode(JSON.stringify(message)).byteLength;
  if (bytes > 64_000) context.addIssue({ code: "custom", message: "Slack message exceeds 64 KB" });
});

const SlackDeliver = BaseCommand.extend({
  capability: z.literal("slack.message.deliver"),
  input: z.object({
    route: SlackRouteKey,
    message: SlackMessage,
  }).strict(),
}).strict();

const AiComplete = BaseCommand.extend({
  capability: z.literal("ai.complete"),
  input: z.object({
    purpose: Identifier,
    system: z.string().trim().min(1).max(30_000),
    user: z.string().max(80_000),
    maxTokens: z.number().int().min(1).max(4_096),
    responseFormat: z.enum(["text", "json"]),
  }).strict(),
}).strict();

export const ConnectionCapabilityCommandSchema = z.discriminatedUnion("capability", [
  GitHubIssueCreate,
  GitHubIssueUpdate,
  GitHubIssueComment,
  SlackDeliver,
  AiComplete,
]);

export type ConnectionCapabilityCommand = z.infer<typeof ConnectionCapabilityCommandSchema>;

const ReceiptBase = z.object({
  contract: z.literal("noxconnect.connection-receipt"),
  version: z.literal(1),
  commandId: Identifier,
  idempotencyKey: Identifier,
  capability: CapabilityId,
  status: z.enum(["completed", "queued", "blocked", "failed"]),
}).strict();

export const ConnectionCapabilityReceiptSchema = z.discriminatedUnion("provider", [
  ReceiptBase.extend({
    provider: z.literal("github"),
    result: z.object({
      issueNumber: z.number().int().positive(),
      url: HttpUrl.nullable(),
      state: z.string().max(40).nullable(),
      created: z.boolean(),
    }).strict(),
  }).strict(),
  ReceiptBase.extend({
    provider: z.literal("slack"),
    result: z.object({
      deliveryId: Identifier,
      queued: z.boolean(),
    }).strict(),
  }).strict(),
  ReceiptBase.extend({
    provider: z.literal("ai"),
    result: z.object({
      text: z.string().max(100_000).nullable(),
      model: z.string().max(200).nullable(),
    }).strict(),
  }).strict(),
]);

export type ConnectionCapabilityReceipt = z.infer<typeof ConnectionCapabilityReceiptSchema>;

const FORBIDDEN_CREDENTIAL_KEYS = new Set([
  "authorization",
  "cookie",
  "setcookie",
  "token",
  "accesstoken",
  "refreshtoken",
  "bottoken",
  "apikey",
  "privatekey",
  "clientsecret",
  "password",
  "secret",
]);

function normalizedKey(value: string): string {
  return value.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

export function findForbiddenCredentialPaths(value: unknown, path = "$", found: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((item, index) => findForbiddenCredentialPaths(item, `${path}[${index}]`, found));
    return found;
  }
  if (!value || typeof value !== "object") return found;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = `${path}.${key}`;
    if (FORBIDDEN_CREDENTIAL_KEYS.has(normalizedKey(key))) found.push(childPath);
    findForbiddenCredentialPaths(child, childPath, found);
  }
  return found;
}

export function parseConnectionCapabilityCommand(value: unknown): ConnectionCapabilityCommand {
  const forbidden = findForbiddenCredentialPaths(value);
  if (forbidden.length > 0) {
    throw new Error(`Connection capability commands cannot contain credentials: ${forbidden.join(", ")}`);
  }
  return ConnectionCapabilityCommandSchema.parse(value);
}

export function parseConnectionCapabilityReceipt(value: unknown): ConnectionCapabilityReceipt {
  const forbidden = findForbiddenCredentialPaths(value);
  if (forbidden.length > 0) {
    throw new Error(`Connection capability receipts cannot contain credentials: ${forbidden.join(", ")}`);
  }
  return ConnectionCapabilityReceiptSchema.parse(value);
}
