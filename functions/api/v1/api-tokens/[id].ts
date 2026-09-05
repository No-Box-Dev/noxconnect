import { auditAuth } from "../../../lib/api-auth.js";
import { apiError, apiResponse, lifecycleDenied } from "./index.js";

interface Context {
  env: { DB: D1Database };
  request: Request;
  params: { id: string };
  data: { orgId: number; userLogin: string; isAdmin: boolean; auth?: { type?: string } };
}

export async function onRequestDelete(context: Context): Promise<Response> {
  const denied = lifecycleDenied(context);
  if (denied) return denied;
  const result = await context.env.DB.prepare(
    `UPDATE api_tokens SET revoked_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      WHERE id = ? AND org_id = ? AND revoked_at IS NULL`,
  ).bind(context.params.id, context.data.orgId).run();
  if (!result.meta?.changes) return apiError("not_found", "API token not found or already revoked", 404);
  await auditAuth(context.env.DB, {
    orgId: context.data.orgId,
    actorType: "user",
    actorId: context.data.userLogin,
    action: "api_token.revoked",
    targetId: context.params.id,
  });
  return apiResponse({ apiVersion: 1, revoked: true, id: context.params.id });
}
