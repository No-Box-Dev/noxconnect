import { z } from "zod";
import { DEFAULT_BOARD_STAGES } from "./board-stages.js";
import { normalizeNoxSettings } from "./naming-compat.js";
import type { ServiceId } from "./service-capabilities";

const ServiceToggles = z.object({
  noxticket: z.boolean().optional(),
  noxfeed: z.boolean().optional(),
  noxspot: z.boolean().optional(),
  noxcue: z.boolean().optional(),
}).strict();

const Stage = z.object({
  id: z.string(),
  label: z.string(),
  color: z.string(),
}).strict();

const PATCH_SCHEMAS = {
  noxconnect: z.object({
    enabledServices: ServiceToggles.optional(),
    newRepositoryPolicy: z.enum(["include", "exclude"]).optional(),
  }).strict(),
  noxticket: z.object({
    featureRepository: z.string().trim().min(1).max(100).nullable().optional(),
    workflow: z.object({ stages: z.array(Stage) }).strict().optional(),
  }).strict(),
  noxfeed: z.object({
    projectScope: z.string().trim().min(1).max(200).nullable().optional(),
    releaseNotesPrompt: z.string().max(20_000).nullable().optional(),
  }).strict(),
  noxspot: z.object({}).strict(),
  noxcue: z.object({}).strict(),
} satisfies Record<ServiceId, z.ZodType>;

export type NoxSettings = Record<string, unknown> & {
  apps?: Record<string, boolean>;
  newRepoDefault?: "include" | "exclude";
  noxTicketRepo?: string;
  boardStages?: Array<{ id: string; label: string; color: string }>;
  releaseNotesPrompt?: string;
  slack?: Record<string, unknown> & { noxFeedProjectId?: string };
};

export function parseSettings(raw: string | null): NoxSettings {
  if (raw == null) return {};
  const value = normalizeNoxSettings(JSON.parse(raw));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Settings must be a JSON object");
  }
  return value as NoxSettings;
}

export function serviceConfig(service: ServiceId, settings: NoxSettings) {
  switch (service) {
    case "noxconnect":
      return {
        enabledServices: {
          noxticket: settings.apps?.noxticket !== false,
          noxfeed: settings.apps?.noxfeed !== false,
          noxspot: settings.apps?.noxspot !== false,
          noxcue: settings.apps?.noxcue !== false,
        },
        newRepositoryPolicy: settings.newRepoDefault ?? "include",
      };
    case "noxticket":
      return {
        featureRepository: settings.noxTicketRepo?.trim() || "noxconnect",
        workflow: { stages: settings.boardStages ?? DEFAULT_BOARD_STAGES },
      };
    case "noxfeed":
      return {
        projectScope: typeof settings.slack?.noxFeedProjectId === "string" ? settings.slack.noxFeedProjectId : null,
        releaseNotesPrompt: settings.releaseNotesPrompt ?? null,
      };
    case "noxspot":
    case "noxcue":
      return {};
  }
}

export function parseServiceConfigPatch(service: ServiceId, value: unknown) {
  return PATCH_SCHEMAS[service].safeParse(value);
}

export function applyServiceConfigPatch(service: ServiceId, current: NoxSettings, patch: Record<string, unknown>): NoxSettings {
  const next: NoxSettings = structuredClone(current);
  if (service === "noxconnect") {
    if (patch.enabledServices) next.apps = { ...(next.apps ?? {}), ...(patch.enabledServices as Record<string, boolean>) };
    if (patch.newRepositoryPolicy) next.newRepoDefault = patch.newRepositoryPolicy as "include" | "exclude";
  }
  if (service === "noxticket") {
    if (Object.hasOwn(patch, "featureRepository")) {
      if (patch.featureRepository === null) delete next.noxTicketRepo;
      else next.noxTicketRepo = patch.featureRepository as string;
    }
    const workflow = patch.workflow as { stages: NoxSettings["boardStages"] } | undefined;
    if (workflow) next.boardStages = workflow.stages;
  }
  if (service === "noxfeed") {
    if (Object.hasOwn(patch, "releaseNotesPrompt")) {
      if (patch.releaseNotesPrompt === null || !(patch.releaseNotesPrompt as string).trim()) delete next.releaseNotesPrompt;
      else next.releaseNotesPrompt = patch.releaseNotesPrompt as string;
    }
    if (Object.hasOwn(patch, "projectScope")) {
      next.slack = { ...(next.slack ?? {}) };
      if (patch.projectScope === null) delete next.slack.noxFeedProjectId;
      else next.slack.noxFeedProjectId = patch.projectScope as string;
    }
  }
  return next;
}

export function serviceConfigLinks(service: ServiceId) {
  const base = `/api/v1/services/${service}`;
  const resources: Record<ServiceId, Record<string, string>> = {
    noxconnect: { connections: "/api/integrations/connections", repositories: "/api/projects", people: "/api/actors" },
    noxticket: { features: "/api/features", specifications: "/api/specs" },
    noxfeed: { feed: "/api/v1/feed", aiSettings: "/api/llm-settings" },
    noxspot: { sites: "/api/spots/sites" },
    noxcue: { sources: "/api/cues/sources", metrics: "/api/cues/metrics" },
  };
  return { self: `${base}/config`, setup: `${base}/setup`, health: `${base}/health`, resources: resources[service] };
}

export function serviceConfigMetadata(service: ServiceId) {
  const fields: Record<ServiceId, string[]> = {
    noxconnect: ["enabledServices", "newRepositoryPolicy"],
    noxticket: ["featureRepository", "workflow.stages"],
    noxfeed: ["projectScope", "releaseNotesPrompt"],
    noxspot: [],
    noxcue: [],
  };
  const resourceScoped = service === "noxspot" || service === "noxcue";
  return {
    mode: resourceScoped ? "resource" as const : "service" as const,
    writable: !resourceScoped,
    writableFields: fields[service],
  };
}

export async function settingsRevision(raw: string | null): Promise<string> {
  const bytes = new TextEncoder().encode(raw == null ? "noxconnect:settings:missing" : raw);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function quotedEtag(revision: string) {
  return `"${revision}"`;
}

export function ifMatchRevision(request: Request) {
  const value = request.headers.get("If-Match")?.trim();
  if (!value) return null;
  return value.startsWith("\"") && value.endsWith("\"") ? value.slice(1, -1) : value;
}
