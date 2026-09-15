import { getCtx } from "../../../../lib/db.js";
import { API_VERSION, requireV1Admin, requireV1Member, v1Error, v1Response } from "../../../../lib/api-v1";
import { parseServiceId } from "../../../../lib/service-capabilities";
import { applyServiceConfigPatch, ifMatchRevision, parseServiceConfigPatch, parseSettings, quotedEtag, serviceConfig, serviceConfigLinks, serviceConfigMetadata, settingsRevision } from "../../../../lib/service-config";
import { getNoxDb, type NoxDatabaseEnv } from "../../../../lib/nox-db";
import { validateConfigPatchWithService, type ProductServiceEnvironment } from "../../../../lib/service-manifests";

interface Ctx {
  env: NoxDatabaseEnv & ProductServiceEnvironment;
  data: { orgId: number; projectId?: string | null; orgLogin: string; userLogin: string; isAdmin: boolean };
  request: Request;
  params: { service: string };
}

async function readSettings(context: Ctx) {
  const { orgId, projectId } = getCtx(context) as Ctx["data"];
  const row = await getNoxDb(context.env).prepare(
    projectId
      ? "SELECT data FROM project_config WHERE org_id = ? AND project_id = ? AND key = 'settings'"
      : "SELECT data FROM config WHERE org_id = ? AND key = 'settings'",
  ).bind(...(projectId ? [orgId, projectId] : [orgId])).first<{ data: string }>();
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
    project: context.data.projectId ? { id: context.data.projectId } : null,
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
  const current = await readSettings(context);
  if ("response" in current) return current.response!;
  const currentConfig = serviceConfig(service, current.settings);
  const serviceValidation = service === "noxconnect" || !context.data.projectId
    ? null
    : await validateConfigPatchWithService(context.env, service, currentConfig, value).catch((error) => {
        console.error(JSON.stringify({
          event: "service_config_validation_unavailable",
          service,
          error: error instanceof Error ? error.message : String(error),
        }));
        return null;
      });
  const parsed = serviceValidation ?? parseServiceConfigPatch(service, value);
  if ("valid" in parsed && !parsed.valid) {
    return v1Error("validation_failed", "Invalid service config", 422, { issues: parsed.issues });
  }
  if (!("valid" in parsed) && !parsed.success) {
    return v1Error("validation_failed", "Invalid service config", 422, { issues: parsed.error.issues });
  }
  const parsedPatch = ("valid" in parsed ? parsed.patch : parsed.data) as Record<string, unknown>;
  if (requestedRevision !== current.revision) {
    return v1Error(
      "revision_conflict",
      "Settings changed concurrently; fetch config and retry",
      412,
      { currentRevision: current.revision },
      { ETag: quotedEtag(current.revision) },
    );
  }
  if (Object.keys(parsedPatch).length === 0) {
    return configResponse(responseBody(context, service, current.settings, current.revision));
  }
  const next = applyServiceConfigPatch(service, current.settings, parsedPatch);

  const raw = JSON.stringify(next);
  const db = getNoxDb(context.env);
  const result = context.data.projectId
    ? current.raw === null
      ? await db.prepare(
        `INSERT OR IGNORE INTO project_config (org_id, project_id, key, data, updated_at)
         VALUES (?, ?, 'settings', ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
      ).bind(context.data.orgId, context.data.projectId, raw).run()
      : await db.prepare(
        `UPDATE project_config SET data = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
          WHERE org_id = ? AND project_id = ? AND key = 'settings' AND data = ?`,
      ).bind(raw, context.data.orgId, context.data.projectId, current.raw).run()
    : current.raw === null
      ? await db.prepare(
        `INSERT OR IGNORE INTO config (org_id, key, data, updated_at)
         VALUES (?, 'settings', ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
      ).bind(context.data.orgId, raw).run()
      : await db.prepare(
        `UPDATE config SET data = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
          WHERE org_id = ? AND key = 'settings' AND data = ?`,
      ).bind(raw, context.data.orgId, current.raw).run();
  if ((result.meta?.changes ?? 0) !== 1) {
    return v1Error("revision_conflict", "Settings changed concurrently; fetch config and retry", 412);
  }
  const revision = await settingsRevision(raw);
  return configResponse(responseBody(context, service, next, revision));
}
