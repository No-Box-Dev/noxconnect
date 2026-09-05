import { z } from "zod";
import { getCtx, jsonResponse, errorResponse } from "../../../lib/db";
import { validate } from "../../../lib/validate";
import { getNoxDb, type NoxDatabaseEnv } from "../../../lib/nox-db";
import { noxSpotAuditStatement } from "../../../lib/noxspot-audit";

interface Ctx {
  env: NoxDatabaseEnv;
  data: { orgId: number; orgLogin: string; userLogin: string; isAdmin: boolean; projectId?: string | null };
  request: Request;
}

const CreateSite = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  projectId: z.string().trim().min(1, "Project is required").max(240).optional(),
  buttonColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Invalid button color").optional(),
  buttonText: z.string().trim().min(1).max(40).optional(),
  widgetMode: z.enum(["development", "release"]).optional(),
  autoErrorLogging: z.boolean().optional(),
});

const SITE_SELECT = `
  site.id, site.name, site.project_id, site.repo, site.widget_config,
  site.slack_channel_id, site.slack_connection_id, site.created_at, site.updated_at`;

function siteDto(row: Record<string, unknown>) {
  let config: Record<string, unknown> = {};
  try { config = JSON.parse(String(row.widget_config || "{}")); } catch { /* defaults below */ }
  const pendingCount = Number(row.slack_pending_count ?? 0);
  const blockedCount = Number(row.slack_blocked_count ?? 0);
  const failedCount = Number(row.slack_failed_count ?? 0);
  const effectiveSlackChannelId = row.slack_channel_id || row.slack_fallback_channel_id;
  const slackHealth = !effectiveSlackChannelId ? "disabled"
    : !row.slack_connected ? "disconnected"
      : row.slack_install_health === "degraded" || blockedCount > 0 || failedCount > 0 ? "degraded"
        : pendingCount > 0 || row.slack_install_health !== "ok" ? "pending" : "connected";
  return {
    id: row.id,
    name: row.name,
    projectId: row.project_id,
    repo: row.repo,
    buttonColor: config.buttonColor ?? "#FE795D",
    buttonText: config.buttonText ?? "Report issue",
    widgetMode: config.widgetMode === "release" ? "release" : "development",
    autoErrorLogging: config.autoErrorLogging === true,
    environments: Array.isArray(config.environments) ? config.environments : [],
    blocks: Array.isArray(config.blocks) ? config.blocks : [],
    slackChannelId: row.slack_channel_id,
    slackConnectionId: row.slack_connection_id ?? null,
    slackEffectiveChannelId: effectiveSlackChannelId ?? null,
    slackUsesFallback: Boolean(!row.slack_channel_id && row.slack_fallback_channel_id),
    slackHealth,
    slackLastDeliveredAt: row.slack_last_delivered_at ?? null,
    slackPendingCount: pendingCount,
    slackBlockedCount: blockedCount + failedCount,
    slackLastError: row.slack_last_error ?? null,
    dailySummaryEnabled: config.dailySummaryEnabled !== false,
    externalShare: row.external_share_id ? {
      id: row.external_share_id,
      slug: row.external_share_slug,
      enabled: Number(row.external_share_enabled ?? 0) === 1,
    } : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function onRequestGet(context: Ctx): Promise<Response> {
  const { orgId, projectId } = getCtx(context) as Ctx["data"];
  if (!orgId) return errorResponse("Missing org context", 400);
  const db = getNoxDb(context.env);

  const { results } = await db.prepare(
    `SELECT ${SITE_SELECT},
            (SELECT COUNT(*) FROM issues issue
              WHERE issue.org_id = site.org_id AND issue.repo = site.repo
                AND EXISTS (SELECT 1 FROM json_each(issue.labels_json)
                             WHERE json_extract(value, '$.name') = 'noxspot')) AS issue_count,
            (SELECT COUNT(*) FROM issues issue
              WHERE issue.org_id = site.org_id AND issue.repo = site.repo AND issue.state = 'open'
                AND EXISTS (SELECT 1 FROM json_each(issue.labels_json)
                             WHERE json_extract(value, '$.name') = 'noxspot')) AS open_issue_count,
            EXISTS(SELECT 1 FROM slack_connections slack WHERE slack.org_id = site.org_id
              AND slack.id = COALESCE(site.slack_connection_id,
                (SELECT json_extract(config.data, '$.slack.fallbackConnectionId') FROM config
                  WHERE config.org_id = site.org_id AND config.key = 'settings'),
                (SELECT id FROM slack_connections default_slack WHERE default_slack.org_id = site.org_id
                  ORDER BY is_default DESC, installed_at LIMIT 1))) AS slack_connected,
            (SELECT slack.health_status FROM slack_connections slack WHERE slack.org_id = site.org_id
              AND slack.id = COALESCE(site.slack_connection_id,
                (SELECT json_extract(config.data, '$.slack.fallbackConnectionId') FROM config
                  WHERE config.org_id = site.org_id AND config.key = 'settings'),
                (SELECT id FROM slack_connections default_slack WHERE default_slack.org_id = site.org_id
                  ORDER BY is_default DESC, installed_at LIMIT 1))) AS slack_install_health,
            (SELECT json_extract(config.data, '$.slack.fallbackChannelId') FROM config
              WHERE config.org_id = site.org_id AND config.key = 'settings') AS slack_fallback_channel_id,
            (SELECT json_extract(config.data, '$.slack.fallbackConnectionId') FROM config
              WHERE config.org_id = site.org_id AND config.key = 'settings') AS slack_fallback_connection_id,
            (SELECT COUNT(*) FROM delivery_outbox delivery
              WHERE delivery.site_id = site.id AND delivery.destination = 'slack'
                AND delivery.status IN ('pending', 'queued', 'processing', 'retrying')) AS slack_pending_count,
            (SELECT COUNT(*) FROM delivery_outbox delivery
              WHERE delivery.site_id = site.id AND delivery.destination = 'slack'
                AND delivery.status = 'blocked_configuration') AS slack_blocked_count,
            (SELECT COUNT(*) FROM delivery_outbox delivery
              WHERE delivery.site_id = site.id AND delivery.destination = 'slack'
                AND delivery.status = 'failed') AS slack_failed_count,
            (SELECT MAX(delivery.delivered_at) FROM delivery_outbox delivery
              WHERE delivery.site_id = site.id AND delivery.destination = 'slack') AS slack_last_delivered_at,
            (SELECT delivery.last_error FROM delivery_outbox delivery
              WHERE delivery.site_id = site.id AND delivery.destination = 'slack'
                AND delivery.last_error IS NOT NULL
              ORDER BY delivery.updated_at DESC LIMIT 1) AS slack_last_error,
            (SELECT share.id FROM external_project_shares share
                WHERE share.org_id = site.org_id AND share.project_id = site.project_id LIMIT 1) AS external_share_id,
            (SELECT share.slug FROM external_project_shares share
                WHERE share.org_id = site.org_id AND share.project_id = site.project_id LIMIT 1) AS external_share_slug,
            (SELECT share.enabled FROM external_project_shares share
                WHERE share.org_id = site.org_id AND share.project_id = site.project_id LIMIT 1) AS external_share_enabled
       FROM spot_sites site
      WHERE site.org_id = ? AND (? IS NULL OR site.project_id = ?)
      ORDER BY site.created_at DESC`,
  ).bind(orgId, projectId ?? null, projectId ?? null).all<Record<string, unknown>>();

  return jsonResponse({
    sites: (results ?? []).map((row) => ({
      ...siteDto(row),
      issueCount: Number(row.issue_count ?? 0),
      openIssueCount: Number(row.open_issue_count ?? 0),
    })),
  });
}

export async function onRequestPost(context: Ctx): Promise<Response> {
  const { orgId, orgLogin, userLogin, isAdmin, projectId } = getCtx(context) as Ctx["data"];
  if (!orgId) return errorResponse("Missing org context", 400);
  if (!isAdmin) return errorResponse("Admin required", 403);
  const db = getNoxDb(context.env);

  let raw: unknown;
  try { raw = await context.request.json(); }
  catch { return errorResponse("Invalid JSON body", 400); }
  const parsed = validate(CreateSite, raw);
  if (!parsed.ok) return parsed.response;
  const input = parsed.data;
  if (projectId && input.projectId && input.projectId !== projectId) return errorResponse("The requested resource was not found", 404);
  const targetProjectId = projectId ?? input.projectId;
  if (!targetProjectId) return errorResponse("Project is required", 400);

  const project = await db.prepare(
    "SELECT repo FROM projects WHERE id = ? AND owner_id = ? AND COALESCE(archived, 0) = 0",
  ).bind(targetProjectId, orgLogin).first<{ repo: string }>();
  if (!project?.repo) return errorResponse("Active project not found in this organization", 400);

  const id = crypto.randomUUID();
  const insertSite = db.prepare(
    `INSERT INTO spot_sites
       (id, org_id, project_id, repo, name, widget_config, slack_channel_id)
     VALUES (?, ?, ?, ?, ?, ?, NULL)`,
  ).bind(
    id, orgId, targetProjectId, project.repo, input.name,
    JSON.stringify({
      buttonColor: input.buttonColor ?? "#FE795D",
      buttonText: input.buttonText ?? "Report issue",
      widgetMode: input.widgetMode ?? "development",
      autoErrorLogging: input.autoErrorLogging === true,
      dailySummaryEnabled: true,
      environments: [],
      blocks: [],
    }),
  );
  await db.batch([
    insertSite,
    noxSpotAuditStatement(db, {
      orgId,
      siteId: id,
      actorLogin: userLogin,
      action: "site.created",
      changes: { name: input.name, projectId: targetProjectId },
    }),
  ]);

  const row = await db.prepare(
    `SELECT ${SITE_SELECT},
       (SELECT json_extract(config.data, '$.slack.fallbackChannelId') FROM config
         WHERE config.org_id = site.org_id AND config.key = 'settings') AS slack_fallback_channel_id
     FROM spot_sites site
     WHERE site.id = ? AND site.org_id = ?`,
  ).bind(id, orgId).first<Record<string, unknown>>();

  return jsonResponse({ site: siteDto(row ?? {}) }, 201);
}
