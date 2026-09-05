import { z } from "zod";
import { NativeAuthError, refreshNativeSession } from "../../../lib/native-auth.js";
import { validate } from "../../../lib/validate";

const Body = z.object({ refresh_token: z.string().startsWith("nox_rt_").max(256) });

export async function onRequestPost(context: { env: Record<string, unknown> & { DB: D1Database }; request: Request }): Promise<Response> {
  const parsed = validate(Body, await context.request.json().catch(() => null));
  if (!parsed.ok) return parsed.response;
  let session;
  try {
    session = await refreshNativeSession(context.env.DB, context.env, parsed.data.refresh_token);
  } catch (error) {
    if (error instanceof NativeAuthError) return response({ error: error.code, error_description: error.message }, error.status);
    throw error;
  }
  if (!session) return response({ error: "invalid_grant", error_description: "The native session expired; sign in again" }, 401);
  return response({
    access_token: session.accessToken,
    refresh_token: session.refreshToken,
    token_type: "bearer",
    expires_in: session.expiresIn,
  });
}

function response(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}
