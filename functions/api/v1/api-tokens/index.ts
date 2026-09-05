import { z } from "zod";
import { requireAdmin } from "../../../lib/access.js";
import {
  auditAuth,
  createApiTokenValue,
  normalizeApiTokenScopes,
  sha256,
} from "../../../lib/api-auth.js";

interface Env { DB: D1Database }
interface AuthContext {
  env: Env;
  request: Request;
  data: {
    orgId: number;
    userLogin: string;
    isAdmin: boolean;
    auth?: { type?: string; id?: string };
  };
}

const CreateToken = z.object({
  name: z.string().trim().min(1).max(80),
  environment: z.enum(["live", "test"]).default("live"),
  projectId: z.string().trim().min(1).max(240),
  scopes: z.array(z.string()).min(1).max(12),
  expiresInDays: z.number().int().min(1).max(365).default(90),
}).strict();

export async function onRequestGet(context: AuthContext): Promise<Response> {
  const denied = lifecycleDenied(context);
  if (denied) return denied;
  const result = await context.env.DB.prepare(
    `SELECT token.id, token.name, token.environment, token.project_id,
            project.name AS project_name, token.token_prefix, token.scopes_json,
            token.created_by, token.created_at, token.expires_at,
            token.last_used_at, token.revoked_at
       FROM api_tokens token
       LEFT JOIN projects project ON project.id = token.project_id
      WHERE token.org_id = ? ORDER BY token.created_at DESC`,
  ).bind(context.data.orgId).all();
  return apiResponse({ apiVersion: 1, tokens: result.results.map(serializeToken) });
}

export async function onRequestPost(context: AuthContext): Promise<Response> {
  const denied = lifecycleDenied(context);
  if (denied) return denied;
  let input: unknown;
  try { input = await context.request.json(); }
  catch { return apiError("invalid_request", "Request body must be valid JSON", 400); }
  const parsed = CreateToken.safeParse(input);
  if (!parsed.success) return apiError("invalid_request", "API token settings are invalid", 400, parsed.error.flatten());
  const scopes = normalizeApiTokenScopes(parsed.data.scopes);
  if (!scopes) return apiError("invalid_scope", "One or more API token scopes are invalid", 400);
  const project = await context.env.DB.prepare(
    `SELECT project.id, project.name
       FROM projects project
       JOIN project_routing_settings routing ON routing.project_id = project.id
      WHERE project.id = ? AND routing.org_id = ? AND routing.enabled = 1
        AND COALESCE(project.archived, 0) = 0`,
  ).bind(parsed.data.projectId, context.data.orgId).first<{ id: string; name: string }>();
  if (!project) return apiError("project_not_found", "Choose an enabled project in this organization", 422);

  const credential = createApiTokenValue(parsed.data.environment);
  const tokenHash = await sha256(credential.token);
  const expiresAt = new Date(Date.now() + parsed.data.expiresInDays * 86400_000).toISOString();
  await context.env.DB.prepare(
    `INSERT INTO api_tokens
       (id, org_id, project_id, name, environment, token_prefix, token_hash, scopes_json,
        created_by, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    credential.id, context.data.orgId, project.id, parsed.data.name, parsed.data.environment,
    credential.prefix, tokenHash, JSON.stringify(scopes), context.data.userLogin, expiresAt,
  ).run();
  await auditAuth(context.env.DB, {
    orgId: context.data.orgId,
    actorType: "user",
    actorId: context.data.userLogin,
    action: "api_token.created",
    targetId: credential.id,
    metadata: { environment: parsed.data.environment, projectId: project.id, scopes, expiresAt },
  });
  return apiResponse({
    apiVersion: 1,
    token: credential.token,
    credential: {
      id: credential.id, name: parsed.data.name, environment: parsed.data.environment,
      projectId: project.id, projectName: project.name,
      prefix: credential.prefix, scopes, expiresAt,
    },
    warning: "Copy this token now. NoxConnect cannot display it again.",
  }, 201);
}

function lifecycleDenied(context: AuthContext): Response | null {
  const denied = requireAdmin(context);
  if (denied) return apiError("admin_required", "Only an organization admin can manage API tokens", 403);
  if (context.data.auth?.type === "api_token") {
    return apiError("session_required", "API tokens cannot create, list, rotate, or revoke API tokens", 403);
  }
  return null;
}

function serializeToken(row: Record<string, unknown>) {
  let scopes: unknown[] = [];
  try { scopes = JSON.parse(String(row.scopes_json)); } catch { /* invalid rows expose no authority */ }
  return {
    id: row.id,
    name: row.name,
    environment: row.environment,
    projectId: row.project_id,
    projectName: row.project_name,
    prefix: row.token_prefix,
    scopes,
    createdBy: row.created_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

function apiResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

function apiError(code: string, message: string, status: number, details?: unknown): Response {
  return apiResponse({ apiVersion: 1, error: { code, message, ...(details === undefined ? {} : { details }) } }, status);
}

export { apiError, apiResponse, lifecycleDenied, serializeToken };
