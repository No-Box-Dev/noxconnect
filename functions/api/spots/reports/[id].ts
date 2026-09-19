import { z } from "zod";
import { getCtx, errorResponse, jsonResponse } from "../../../lib/db";
import { updateNoxSpotReport } from "../../../lib/noxspot-resolution.js";

const MAX_BODY_BYTES = 16 * 1024;
const UpdateReport = z.object({
  status: z.enum(["open", "investigating", "resolved"]),
  summary: z.string().trim().max(4_000).optional(),
  notify: z.boolean().optional().default(false),
  retryNotification: z.boolean().optional().default(false),
}).strict().refine((value) => value.status === "resolved" || (!value.notify && !value.retryNotification), {
  message: "Notifications can only be sent for resolved reports",
});

interface Context {
  request: Request;
  env: { DB: D1Database; TASK_QUEUE: Queue };
  params: { id?: string };
  data: {
    orgId: number;
    orgLogin: string;
    userLogin: string;
    isAdmin: boolean;
    projectId?: string | null;
    auth?: { type?: string };
  };
}

export async function onRequestPatch(context: Context): Promise<Response> {
  const auth = getCtx(context) as Context["data"];
  if (!auth.isAdmin && auth.auth?.type !== "api_token") return errorResponse("Admin or project API token required", 403);
  const reportId = decodeURIComponent(context.params.id ?? "").trim();
  if (!/^[A-Za-z0-9:_-]{1,120}$/.test(reportId)) return errorResponse("Invalid report ID", 400);

  const declaredLength = Number(context.request.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) return errorResponse("Request body too large", 413);
  const bodyText = await context.request.text();
  if (new TextEncoder().encode(bodyText).byteLength > MAX_BODY_BYTES) return errorResponse("Request body too large", 413);
  let body: unknown;
  try { body = JSON.parse(bodyText); }
  catch { return errorResponse("Invalid JSON body", 400); }
  const parsed = UpdateReport.safeParse(body);
  if (!parsed.success) return errorResponse(parsed.error.issues[0]?.message ?? "Invalid report update", 400);

  const result = await updateNoxSpotReport(context.env, {
    reportId,
    orgId: auth.orgId,
    projectId: auth.projectId ?? null,
    ownerId: auth.orgLogin,
    actor: auth.userLogin,
    source: auth.auth?.type === "api_token" ? "api" : "platform",
    ...parsed.data,
  });
  if (!result) return errorResponse("NoxSpot report not found", 404);
  return jsonResponse({ report: result });
}
