import { z } from "zod";
import { getCtx, errorResponse, jsonResponse } from "../../../../../lib/db.js";
import { getNoxDb, type NoxDatabaseEnv } from "../../../../../lib/nox-db";
import { validate } from "../../../../../lib/validate";
import { noxSpotAuditStatement } from "../../../../../lib/noxspot-audit";
import { NoxSpotResolutionTemplateSchema } from "../../../../../lib/noxspot-resolution-template.js";

interface EmailService { sendEmail(command: unknown): Promise<{ messageId: string }> }
interface Ctx {
  env: NoxDatabaseEnv & { NOXCONNECT_EMAIL?: EmailService };
  data: { orgId: number; projectId?: string | null; userLogin: string; isAdmin: boolean; auth?: { type?: string } };
  request: Request;
  params: { id: string };
}

const TestEmail = z.object({
  recipient: z.string().trim().email().max(254),
  template: NoxSpotResolutionTemplateSchema,
}).strict();

export async function onRequestPost(context: Ctx): Promise<Response> {
  const { orgId, projectId, userLogin, isAdmin, auth } = getCtx(context) as Ctx["data"];
  if (!orgId) return errorResponse("Missing org context", 400);
  if (!isAdmin && auth?.type !== "api_token") return errorResponse("Admin or project API token required", 403);
  if (!context.env.NOXCONNECT_EMAIL?.sendEmail) return errorResponse("Email delivery is unavailable", 503);
  let raw: unknown;
  try { raw = await context.request.json(); } catch { return errorResponse("Invalid JSON body", 400); }
  const parsed = validate(TestEmail, raw);
  if (!parsed.ok) return parsed.response;
  const db = getNoxDb(context.env);
  const site = await db.prepare(
    `SELECT id, name, project_id FROM spot_sites WHERE id = ? AND org_id = ?${projectId ? " AND project_id = ?" : ""} LIMIT 1`,
  ).bind(...(projectId ? [context.params.id, orgId, projectId] : [context.params.id, orgId])).first<{
    id: string; name: string; project_id: string;
  }>();
  if (!site) return errorResponse("NoxSpot site not found", 404);

  const receipt = await context.env.NOXCONNECT_EMAIL.sendEmail({
    contract: "noxconnect.transactional-email",
    version: 1,
    requestId: `noxspot-template-test:${site.id}:${crypto.randomUUID()}`,
    recipient: parsed.data.recipient,
    template: "noxspot.resolution",
    model: {
      siteName: site.name,
      reportTitle: "Example resolved ticket",
      summary: "We found that an example action was not completing as expected. We updated the behavior so the action now completes correctly.\n\nYou should now be able to complete the example action normally.",
      reporterName: "Alex",
      responseUrl: "https://app.noxhere.com",
      presentation: parsed.data.template,
    },
  });
  await noxSpotAuditStatement(db, {
    orgId,
    projectId: site.project_id,
    siteId: site.id,
    actorLogin: userLogin,
    action: "resolution_template.test_sent",
    changes: { sent: true },
  }).run();
  return jsonResponse({ ok: true, messageId: receipt.messageId });
}
