import { getCtx } from "../../../../lib/db.js";
import { API_VERSION, normalizeLegacyError, requireV1Admin, requireV1Member, v1Error, v1Response } from "../../../../lib/api-v1";
import { parseServiceId } from "../../../../lib/service-capabilities";
import { applyServiceConfigPatch, ifMatchRevision, parseServiceConfigPatch, parseSettings, quotedEtag, serviceConfig, serviceConfigLinks, serviceConfigMetadata, settingsRevision } from "../../../../lib/service-config";
import { onRequestPut as putLegacyConfig } from "../../../config/[key].js";
import { getNoxDb, type NoxDatabaseEnv } from "../../../../lib/nox-db";

interface Ctx {
  env: NoxDatabaseEnv;
  data: { orgId: number; orgLogin: string; userLogin: string; isAdmin: boolean; configCompareAndSwap?: { expectedRaw: string | null } };
  request: Request;
  params: { service: string };
}

async function readSettings(context: Ctx) {
  const { orgId } = getCtx(context) as Ctx["data"];
  const row = await getNoxDb(context.env).prepare(
    "SELECT data FROM config WHERE org_id = ? AND key = 'settings'",
  ).bind(orgId).first<{ data: string }>();
  const raw = row?.data ?? null;
  try {
    return { raw, settings: parseSettings(raw), revision: await settingsRevision(raw) };
  } catch (error) {
    console.error(JSON.stringify({ message: "Corrupt service settings", orgId, error: error instanceof Error ? error.message : String(error) }));
    return { response: v1Error("corrupt_settings", "Corrupt settings row — repair before continuing", 500) };
  }
}

function responseBody(context: Ctx, service: Parameters<typeof serviceConfig>[0], settings: Parameters<typeof serviceConfig>[1], revision: string) {
  return {
    apiVersion: API_VERSION,
    organization: { login: context.data.orgLogin },
    service,
    schemaVersion: 1,
    revision,
    configuration: serviceConfigMetadata(service),
    config: serviceConfig(service, settings),
    links: serviceConfigLinks(service),
  };
}

function configResponse(body: ReturnType<typeof responseBody>) {
  return v1Response(body, 200, { ETag: quotedEtag(body.revision) });
}

export async function onRequestGet(context: Ctx): Promise<Response> {
  const accessError = requireV1Member(context);
  if (accessError) return accessError;
  const service = parseServiceId(context.params.service);
  if (!service) return v1Error("service_not_found", "Unknown Nox service", 404);
  const current = await readSettings(context);
  if ("response" in current) return current.response!;
  return configResponse(responseBody(context, service, current.settings, current.revision));
}

export async function onRequestPatch(context: Ctx): Promise<Response> {
  const accessError = requireV1Admin(context);
  if (accessError) return accessError;
  const service = parseServiceId(context.params.service);
  if (!service) return v1Error("service_not_found", "Unknown Nox service", 404);
  const metadata = serviceConfigMetadata(service);
  if (!metadata.writable) {
    return v1Error(
      "resource_scoped_config",
      `${service} configuration is managed through its linked resources`,
      409,
      { resources: serviceConfigLinks(service).resources },
      { Allow: "GET" },
    );
  }

  const requestedRevision = ifMatchRevision(context.request);
  if (!requestedRevision) return v1Error("precondition_required", "If-Match is required; fetch the current service config first", 428);
  let value: unknown;
  try { value = await context.request.json(); } catch { return v1Error("invalid_json", "Invalid JSON body", 400); }
  const parsed = parseServiceConfigPatch(service, value);
  if (!parsed.success) return v1Error("validation_failed", "Invalid service config", 422, { issues: parsed.error.issues });

  const parsedPatch = parsed.data as Record<string, unknown>;
  if (service === "noxfeed" && typeof parsedPatch.projectScope === "string") {
    const { orgLogin } = getCtx(context) as Ctx["data"];
    const project = await getNoxDb(context.env).prepare(
      "SELECT 1 AS found FROM projects WHERE id = ? AND owner_id = ? AND COALESCE(archived, 0) = 0",
    ).bind(parsedPatch.projectScope, orgLogin).first();
    if (!project) {
      return v1Error(
        "project_not_found",
        "projectScope must be null for all projects or the ID of an active project",
        422,
        { field: "projectScope" },
      );
    }
  }

  const current = await readSettings(context);
  if ("response" in current) return current.response!;
  if (requestedRevision !== current.revision) {
    return v1Error(
      "revision_conflict",
      "Settings changed concurrently; fetch config and retry",
      412,
      { currentRevision: current.revision },
      { ETag: quotedEtag(current.revision) },
    );
  }
  if (Object.keys(parsed.data as object).length === 0) {
    return configResponse(responseBody(context, service, current.settings, current.revision));
  }
  const next = applyServiceConfigPatch(service, current.settings, parsed.data as Record<string, unknown>);

  const legacyResponse = await putLegacyConfig({
    ...context,
    request: new Request(context.request.url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(next),
    }),
    params: { key: "settings" },
    data: { ...context.data, configCompareAndSwap: { expectedRaw: current.raw } },
  });
  if (!legacyResponse.ok) {
    if (legacyResponse.status === 409) {
      const conflict = await legacyResponse.clone().json().catch(() => null) as { error?: string } | null;
      if (conflict?.error?.startsWith("Settings changed concurrently")) {
        return v1Error("revision_conflict", "Settings changed concurrently; fetch config and retry", 412);
      }
    }
    return normalizeLegacyError(legacyResponse);
  }

  const raw = JSON.stringify(next);
  const revision = await settingsRevision(raw);
  return configResponse(responseBody(context, service, next, revision));
}
