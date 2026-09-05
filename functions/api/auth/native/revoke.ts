import {
  resolveNativeSession,
  revokeNativeSession,
  revokeNativeSessionWithRefreshToken,
} from "../../../lib/native-auth.js";

export async function onRequestPost(context: { env: { DB: D1Database; ENCRYPTION_KEY?: string }; request: Request }): Promise<Response> {
  const bearer = (context.request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  const body = await context.request.json().catch(() => null) as { refresh_token?: unknown } | null;
  const refreshToken = typeof body?.refresh_token === "string" ? body.refresh_token : null;
  if (refreshToken) {
    const revoked = await revokeNativeSessionWithRefreshToken(context.env.DB, refreshToken);
    return result(revoked ? 200 : 401);
  }
  if (!context.env.ENCRYPTION_KEY || !bearer.startsWith("nox_at_")) return result(401);
  const session = await resolveNativeSession(context.env.DB, context.env.ENCRYPTION_KEY, bearer).catch(() => null);
  if (!session) return result(401);
  await revokeNativeSession(context.env.DB, session.id);
  return result(200);
}

function result(status: number): Response {
  return Response.json(status === 200 ? { revoked: true } : { error: "unauthorized" }, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}
