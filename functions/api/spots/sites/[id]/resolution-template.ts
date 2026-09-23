import { getCtx, errorResponse } from "../../../../lib/db.js";
import { ifMatchRevision, quotedEtag } from "../../../../lib/etag";
import { getNoxDb, type NoxDatabaseEnv } from "../../../../lib/nox-db";
import { noxSpotAuditStatement } from "../../../../lib/noxspot-audit";
import {
  DEFAULT_NOXSPOT_RESOLUTION_TEMPLATE,
  NoxSpotResolutionTemplateSchema,
  resolutionTemplateFromWidgetConfig,
  resolutionTemplateRevision,
} from "../../../../lib/noxspot-resolution-template.js";

interface Ctx {
  env: NoxDatabaseEnv;
  data: { orgId: number; projectId?: string | null; userLogin: string; isAdmin: boolean; auth?: { type?: string } };
  request: Request;
  params: { id: string };
}

async function loadSite(context: Ctx) {
  const { orgId, projectId } = getCtx(context) as Ctx["data"];
  return getNoxDb(context.env).prepare(
    `SELECT id, project_id, widget_config FROM spot_sites
      WHERE id = ? AND org_id = ?${projectId ? " AND project_id = ?" : ""} LIMIT 1`,
  ).bind(...(projectId ? [context.params.id, orgId, projectId] : [context.params.id, orgId])).first<{
    id: string; project_id: string; widget_config: string;
  }>();
}

function jsonWithRevision(body: unknown, revision: string, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ETag: quotedEtag(revision) },
  });
}

export async function onRequestGet(context: Ctx): Promise<Response> {
  const { orgId, isAdmin, auth } = getCtx(context) as Ctx["data"];
  if (!orgId) return errorResponse("Missing org context", 400);
  if (!isAdmin && auth?.type !== "api_token") return errorResponse("Admin or project API token required", 403);
  const site = await loadSite(context);
  if (!site) return errorResponse("NoxSpot site not found", 404);
  const resolved = resolutionTemplateFromWidgetConfig(site.widget_config);
  const revision = await resolutionTemplateRevision(resolved.template);
  return jsonWithRevision({
    template: resolved.template,
    defaults: DEFAULT_NOXSPOT_RESOLUTION_TEMPLATE,
    usingDefault: resolved.usingDefault,
    revision,
  }, revision);
}

export async function onRequestPatch(context: Ctx): Promise<Response> {
  const { orgId, userLogin, isAdmin, auth } = getCtx(context) as Ctx["data"];
  if (!orgId) return errorResponse("Missing org context", 400);
  if (!isAdmin && auth?.type !== "api_token") return errorResponse("Admin or project API token required", 403);
  const requestedRevision = ifMatchRevision(context.request);
  if (!requestedRevision) return errorResponse("If-Match is required; fetch the template first", 428);
  let raw: unknown;
  try { raw = await context.request.json(); } catch { return errorResponse("Invalid JSON body", 400); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !("template" in raw)) {
    return errorResponse("Expected a template property", 422);
  }
  const input = (raw as { template: unknown }).template;
  const parsed = input === null ? null : NoxSpotResolutionTemplateSchema.safeParse(input);
  if (parsed && !parsed.success) return errorResponse("Invalid resolution email template", 422);

  const site = await loadSite(context);
  if (!site) return errorResponse("NoxSpot site not found", 404);
  const current = resolutionTemplateFromWidgetConfig(site.widget_config);
  const currentRevision = await resolutionTemplateRevision(current.template);
  if (requestedRevision !== currentRevision) {
    return jsonWithRevision({ error: "Template changed concurrently; refresh and try again" }, currentRevision, 412);
  }

  const nextConfig = { ...current.widgetConfig } as Record<string, unknown>;
  if (parsed === null) delete nextConfig.resolutionEmail;
  else nextConfig.resolutionEmail = parsed.data;
  const nextTemplate = parsed === null ? { ...DEFAULT_NOXSPOT_RESOLUTION_TEMPLATE } : parsed.data;
  const nextRevision = await resolutionTemplateRevision(nextTemplate);
  const db = getNoxDb(context.env);
  const serializedNextConfig = JSON.stringify(nextConfig);
  const result = await db.prepare(
    `UPDATE spot_sites SET widget_config = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      WHERE id = ? AND org_id = ? AND project_id = ? AND widget_config = ?`,
  ).bind(serializedNextConfig, site.id, orgId, site.project_id, site.widget_config).run();
  if ((result.meta?.changes ?? 0) !== 1) {
    // Some remote D1 bindings have returned a missing/zero change count even
    // though the compare-and-swap was persisted. Confirm the stored value
    // before reporting a conflict so callers never receive a false 412.
    const persisted = await loadSite(context);
    if (!persisted || persisted.widget_config !== serializedNextConfig) {
      return errorResponse("Template changed concurrently; refresh and try again", 412);
    }
  }
  await noxSpotAuditStatement(db, {
    orgId,
    projectId: site.project_id,
    siteId: site.id,
    actorLogin: userLogin,
    action: parsed === null ? "resolution_template.reset" : "resolution_template.updated",
    changes: parsed === null ? { usingDefault: true } : { template: parsed.data },
  }).run();
  return jsonWithRevision({ template: nextTemplate, usingDefault: parsed === null, revision: nextRevision }, nextRevision);
}
