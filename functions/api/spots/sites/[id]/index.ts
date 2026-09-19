import { z } from "zod";
import { getCtx, jsonResponse, errorResponse } from "../../../../lib/db";
import { validate } from "../../../../lib/validate";
import { getNoxDb, type NoxDatabaseEnv } from "../../../../lib/nox-db";
import { getSlackChannel, resolveSlackChannels, resolveSlackInstall } from "../../../../lib/slack.js";
import { requeueBlockedForSite } from "../../../../lib/delivery-outbox.js";
import { noxSpotAuditStatement } from "../../../../lib/noxspot-audit";

interface Ctx {
  env: NoxDatabaseEnv & { ENCRYPTION_KEY?: string; TASK_QUEUE?: Queue; NOXSPOT_ASSETS?: R2Bucket };
  data: { orgId: number; projectId?: string | null; userLogin: string; isAdmin: boolean };
  request: Request;
  params: { id: string };
}

const EnvironmentInput = z.object({
  name: z.string().trim().min(1).max(60),
  url: z.string().trim().min(1).max(500).refine((value) => {
    try { new URL(value.includes("://") ? value : `https://${value}`); return true; }
    catch { return false; }
  }, "Invalid environment URL"),
  buttonColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
  buttonText: z.string().trim().min(1).max(40).nullable().optional(),
  widgetMode: z.enum(["development", "release"]).nullable().optional(),
  enabled: z.boolean().optional(),
});

const BlockInput = z.object({
  id: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,119}$/),
  type: z.enum([
    "title", "description", "reporter", "contact_email", "custom_text",
    "custom_textarea", "custom_select", "element_picker", "metadata", "console_logs",
  ]),
  label: z.string().trim().max(120).nullable().optional(),
  required: z.boolean().optional(),
  options: z.array(z.string().trim().min(1).max(120)).max(30).optional(),
  environments: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
}).superRefine((block, ctx) => {
  if (block.type === "custom_select" && (!block.options || block.options.length === 0)) {
    ctx.addIssue({ code: "custom", message: "Select blocks require at least one option", path: ["options"] });
  }
  if (block.type !== "custom_select" && block.options?.length) {
    ctx.addIssue({ code: "custom", message: "Only select blocks accept options", path: ["options"] });
  }
});

const UpdateSite = z.object({
  slackChannelId: z.string().trim().max(80).nullable().optional(),
  slackConnectionId: z.string().trim().min(1).max(120).nullable().optional(),
  dailySummaryEnabled: z.boolean().optional(),
  autoErrorLogging: z.boolean().optional(),
  widgetMode: z.enum(["development", "release"]).optional(),
  buttonColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  buttonText: z.string().trim().min(1).max(40).optional(),
  environments: z.array(EnvironmentInput).max(50).superRefine((environments, ctx) => {
    const names = new Set<string>();
    for (let index = 0; index < environments.length; index += 1) {
      const key = environments[index].name.toLowerCase();
      if (names.has(key)) ctx.addIssue({ code: "custom", message: "Environment names must be unique", path: [index, "name"] });
      names.add(key);
    }
  }).optional(),
  blocks: z.array(BlockInput).max(30).superRefine((blocks, ctx) => {
    const ids = new Set<string>();
    for (let index = 0; index < blocks.length; index += 1) {
      if (ids.has(blocks[index].id)) ctx.addIssue({ code: "custom", message: "Block IDs must be unique", path: [index, "id"] });
      ids.add(blocks[index].id);
    }
    if (blocks.length > 0 && blocks.filter((block) => block.type === "title").length !== 1) {
      ctx.addIssue({ code: "custom", message: "A custom form must contain exactly one title block" });
    }
  }).optional(),
}).refine((value) => Object.keys(value).length > 0, "No changes supplied");

export async function onRequestPatch(context: Ctx): Promise<Response> {
  const { orgId, projectId, userLogin, isAdmin } = getCtx(context) as Ctx["data"];
  if (!orgId) return errorResponse("Missing org context", 400);
  if (!isAdmin) return errorResponse("Admin required", 403);
  const db = getNoxDb(context.env);

  let raw: unknown;
  try { raw = await context.request.json(); }
  catch { return errorResponse("Invalid JSON body", 400); }
  const parsed = validate(UpdateSite, raw);
  if (!parsed.ok) return parsed.response;

  const existing = await db.prepare(
    `SELECT id, project_id, slack_channel_id, slack_connection_id, widget_config
       FROM spot_sites WHERE id = ? AND org_id = ?${projectId ? " AND project_id = ?" : ""}`,
  ).bind(...(projectId ? [context.params.id, orgId, projectId] : [context.params.id, orgId])).first<Record<string, unknown>>();
  if (!existing) return errorResponse("NoxSpot site not found", 404);
  const resourceProjectId = String(existing.project_id);

  const input = parsed.data;
  if (input.slackChannelId) {
    const connectionId = input.slackConnectionId !== undefined
      ? input.slackConnectionId : existing.slack_connection_id;
    const slack = await resolveSlackInstall({ ...context.env, DB: db }, orgId, String(connectionId || "") || null);
    if (!slack) return errorResponse("Connect Slack in Integrations before selecting a channel", 409);
    try {
      const channel = await getSlackChannel(slack.botToken, input.slackChannelId);
      if (!channel || channel.is_archived) return errorResponse("Slack channel is archived or unavailable", 409);
      if (channel.is_private && !channel.is_member) return errorResponse("Invite the NoxSpot bot to this private channel first", 409);
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : "Slack channel is unavailable", 409);
    }
  }
  let config: Record<string, unknown> = {};
  try { config = JSON.parse(String(existing.widget_config || "{}")); } catch { /* replace corrupt config */ }
  const finalEnvironments = input.environments ?? (Array.isArray(config.environments) ? config.environments : []);
  const finalBlocks = input.blocks ?? (Array.isArray(config.blocks) ? config.blocks : []);
  const environmentNames = new Set(finalEnvironments.map((environment) => String((environment as { name?: unknown }).name ?? "")));
  const missingEnvironment = finalBlocks.flatMap((block) =>
    Array.isArray((block as { environments?: unknown }).environments)
      ? ((block as { environments: unknown[] }).environments.filter((name) => typeof name === "string" && !environmentNames.has(name)) as string[])
      : [],
  )[0];
  if (missingEnvironment) return errorResponse(`Block references unknown environment: ${missingEnvironment}`, 400);
  for (const key of ["buttonColor", "buttonText", "widgetMode", "autoErrorLogging", "dailySummaryEnabled", "environments", "blocks"] as const) {
    if (input[key] !== undefined) config[key] = input[key];
  }
  const updateStatement = db.prepare(
    `UPDATE spot_sites SET slack_channel_id = ?, slack_connection_id = ?, widget_config = ?,
       updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      WHERE id = ? AND org_id = ? AND project_id = ?`,
  ).bind(
    input.slackChannelId !== undefined ? input.slackChannelId || null : existing.slack_channel_id,
    input.slackConnectionId !== undefined ? input.slackConnectionId || null : existing.slack_connection_id,
    JSON.stringify(config),
    context.params.id,
    orgId,
    resourceProjectId,
  );
  await db.batch([
    updateStatement,
    noxSpotAuditStatement(db, {
      orgId,
      projectId: resourceProjectId,
      siteId: context.params.id,
      actorLogin: userLogin,
      action: "site.updated",
      changes: input,
    }),
  ]);

  if (input.slackChannelId !== undefined) {
    if (input.slackChannelId) {
      await db.prepare(
        `UPDATE delivery_outbox SET channel_id = ?, slack_connection_id = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
         WHERE org_id = ? AND site_id = ? AND source = 'noxspot'
           AND destination = 'slack' AND status != 'delivered'`,
      ).bind(input.slackChannelId, input.slackConnectionId ?? existing.slack_connection_id ?? null, orgId, context.params.id).run();
      await requeueBlockedForSite({ ...context.env, DB: db }, orgId, context.params.id);
    } else {
      const channels = await resolveSlackChannels(db, orgId, resourceProjectId);
      if (channels.fallbackChannelId) {
        await db.prepare(
          `UPDATE delivery_outbox SET channel_id = ?, slack_connection_id = ?, status = 'pending',
             last_error_code = NULL, last_error = NULL, next_attempt_at = NULL,
             updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
           WHERE org_id = ? AND site_id = ? AND source = 'noxspot'
             AND destination = 'slack' AND status != 'delivered'`,
        ).bind(channels.fallbackChannelId, channels.fallbackConnectionId || null, orgId, context.params.id).run();
        await requeueBlockedForSite({ ...context.env, DB: db }, orgId, context.params.id);
      } else {
        await db.prepare(
          `UPDATE delivery_outbox SET status = 'blocked_configuration',
             last_error_code = 'alerts_disabled', last_error = 'No NoxSpot site or organization fallback channel is configured',
             updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
           WHERE org_id = ? AND site_id = ? AND source = 'noxspot'
             AND destination = 'slack' AND status != 'delivered'`,
        ).bind(orgId, context.params.id).run();
      }
    }
  }

  return jsonResponse({ ok: true });
}

export async function onRequestDelete(context: Ctx): Promise<Response> {
  const { orgId, projectId, userLogin, isAdmin } = getCtx(context) as Ctx["data"];
  if (!orgId) return errorResponse("Missing org context", 400);
  if (!isAdmin) return errorResponse("Admin required", 403);
  if (!context.env.NOXSPOT_ASSETS) return errorResponse("Screenshot storage is unavailable", 503);
  const db = getNoxDb(context.env);

  const site = await db.prepare(
    `SELECT id, project_id FROM spot_sites
      WHERE id = ? AND org_id = ?${projectId ? " AND project_id = ?" : ""}`,
  ).bind(...(projectId ? [context.params.id, orgId, projectId] : [context.params.id, orgId])).first<{ id: string; project_id: string }>();
  if (!site) return errorResponse("NoxSpot site not found", 404);

  const prefix = `screenshots/${site.id}/`;
  let cursor: string | undefined;
  do {
    const page = await context.env.NOXSPOT_ASSETS.list({ prefix, cursor });
    const keys = page.objects.map((object) => object.key);
    if (keys.length) await context.env.NOXSPOT_ASSETS.delete(keys);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  await db.batch([
    db.prepare(
      "DELETE FROM delivery_outbox WHERE org_id = ? AND site_id = ? AND source = 'noxspot'",
    ).bind(orgId, site.id),
    noxSpotAuditStatement(db, {
      orgId,
      projectId: site.project_id,
      siteId: site.id,
      actorLogin: userLogin,
      action: "site.deleted",
    }),
    db.prepare("DELETE FROM spot_sites WHERE id = ? AND org_id = ? AND project_id = ?").bind(site.id, orgId, site.project_id),
  ]);
  return jsonResponse({ ok: true });
}
