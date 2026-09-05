import { auditAuth, createApiTokenValue, sha256 } from "../../../../lib/api-auth.js";
import { apiError, apiResponse, lifecycleDenied } from "../index.js";

interface Context {
  env: { DB: D1Database };
  request: Request;
  params: { id: string };
  data: { orgId: number; userLogin: string; isAdmin: boolean; auth?: { type?: string } };
}

export async function onRequestPost(context: Context): Promise<Response> {
  const denied = lifecycleDenied(context);
  if (denied) return denied;
  const current = await context.env.DB.prepare(
    `SELECT token.id, token.project_id, token.name, token.environment,
            token.scopes_json, token.expires_at,
            CASE WHEN routing.enabled = 1 AND COALESCE(project.archived, 0) = 0
                 THEN 1 ELSE 0 END AS project_enabled
       FROM api_tokens token
       LEFT JOIN projects project ON project.id = token.project_id
       LEFT JOIN project_routing_settings routing
         ON routing.org_id = token.org_id AND routing.project_id = token.project_id
      WHERE token.id = ? AND token.org_id = ? AND token.revoked_at IS NULL`,
  ).bind(context.params.id, context.data.orgId).first<Record<string, unknown>>();
  if (!current) return apiError("not_found", "API token not found or already revoked", 404);
  if (current.project_enabled !== 1) return apiError("project_not_enabled", "This token's project is no longer enabled", 409);

  const replacement = createApiTokenValue(String(current.environment));
  const hash = await sha256(replacement.token);
  await context.env.DB.batch([
    context.env.DB.prepare(
      "UPDATE api_tokens SET revoked_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ? AND org_id = ?",
    ).bind(context.params.id, context.data.orgId),
    context.env.DB.prepare(
      `INSERT INTO api_tokens
         (id, org_id, project_id, name, environment, token_prefix, token_hash, scopes_json,
          created_by, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      replacement.id, context.data.orgId, current.project_id, current.name, current.environment,
      replacement.prefix, hash, current.scopes_json, context.data.userLogin, current.expires_at,
    ),
  ]);
  await auditAuth(context.env.DB, {
    orgId: context.data.orgId,
    actorType: "user",
    actorId: context.data.userLogin,
    action: "api_token.rotated",
    targetId: replacement.id,
    metadata: { replacedId: context.params.id, projectId: current.project_id },
  });
  return apiResponse({
    apiVersion: 1,
    token: replacement.token,
    credential: { id: replacement.id, prefix: replacement.prefix, projectId: current.project_id, replaces: context.params.id },
    warning: "Copy this token now. NoxConnect cannot display it again.",
  }, 201);
}
