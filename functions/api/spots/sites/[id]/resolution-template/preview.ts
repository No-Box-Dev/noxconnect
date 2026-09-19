import { z } from "zod";
import { getCtx, errorResponse, jsonResponse } from "../../../../../lib/db.js";
import { getNoxDb, type NoxDatabaseEnv } from "../../../../../lib/nox-db";
import { validate } from "../../../../../lib/validate";
import { NoxSpotResolutionTemplateSchema, renderResolutionTemplate } from "../../../../../lib/noxspot-resolution-template.js";

interface Ctx {
  env: NoxDatabaseEnv;
  data: { orgId: number; projectId?: string | null; isAdmin: boolean };
  request: Request;
  params: { id: string };
}

const Preview = z.object({ template: NoxSpotResolutionTemplateSchema }).strict();

export async function onRequestPost(context: Ctx): Promise<Response> {
  const { orgId, projectId, isAdmin } = getCtx(context) as Ctx["data"];
  if (!orgId) return errorResponse("Missing org context", 400);
  if (!isAdmin) return errorResponse("Admin required", 403);
  const site = await getNoxDb(context.env).prepare(
    `SELECT name FROM spot_sites WHERE id = ? AND org_id = ?${projectId ? " AND project_id = ?" : ""} LIMIT 1`,
  ).bind(...(projectId ? [context.params.id, orgId, projectId] : [context.params.id, orgId])).first<{ name: string }>();
  if (!site) return errorResponse("NoxSpot site not found", 404);
  let raw: unknown;
  try { raw = await context.request.json(); } catch { return errorResponse("Invalid JSON body", 400); }
  const parsed = validate(Preview, raw);
  if (!parsed.ok) return parsed.response;
  const rendered = renderResolutionTemplate(parsed.data.template, {
    report_title: "Could not update a collection on mobile",
    site_name: site.name,
  });
  return jsonResponse({
    preview: {
      subject: rendered.subject,
      greeting: "Hi Alex,",
      acknowledgement: rendered.acknowledgement,
      summary: "We found that the collection controls were not responding on mobile. We updated the interaction so the selected collection can be removed correctly.\n\nYou should now be able to update your collection normally on mobile.",
      reopenText: rendered.reopenText,
      buttonLabel: rendered.buttonLabel,
      closing: rendered.closing,
      replyTo: rendered.replyTo,
    },
  });
}
