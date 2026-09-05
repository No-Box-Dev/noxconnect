import { z } from "zod";
import { createNativeSession, nativeAuthRateLimit } from "../../../lib/native-auth.js";
import { getGitHubUserProfile } from "../../../lib/github-user.js";
import { validate } from "../../../lib/validate";

const Body = z.object({
  client: z.literal("noxfeed-mac"),
  access_token: z.string().min(1).max(512),
  refresh_token: z.string().min(1).max(512).optional(),
});

export async function onRequestPost(context: { env: { DB: D1Database; ENCRYPTION_KEY?: string; NATIVE_AUTH_RATE_LIMITER?: RateLimit }; request: Request }): Promise<Response> {
  if (!context.env.ENCRYPTION_KEY) return response({ error: "native_auth_unavailable" }, 503);
  const rate = await nativeAuthRateLimit(context.env, context.request, "legacy-exchange");
  if (rate === "limited") return response({ error: "rate_limited", error_description: "Too many upgrade attempts; wait a minute" }, 429);
  if (rate !== "allowed") return response({ error: "native_auth_unavailable" }, 503);
  const parsed = validate(Body, await context.request.json().catch(() => null));
  if (!parsed.ok) return parsed.response;
  if (parsed.data.access_token.startsWith("nox_")) return response({ error: "invalid_grant" }, 400);
  let user: { login: string; avatar_url?: string | null };
  try { user = await getGitHubUserProfile(parsed.data.access_token) as typeof user; }
  catch { return response({ error: "invalid_grant", error_description: "GitHub credential is invalid" }, 401); }
  const session = await createNativeSession(context.env.DB, context.env.ENCRYPTION_KEY, {
    clientName: parsed.data.client,
    githubLogin: user.login,
    githubToken: parsed.data.access_token,
    githubRefreshToken: parsed.data.refresh_token ?? null,
  });
  return response({
    access_token: session.accessToken,
    refresh_token: session.refreshToken,
    token_type: "bearer",
    expires_in: session.expiresIn,
    user,
  });
}

function response(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}
