import { z } from "zod";
import { decryptToken } from "../../../../lib/crypto";
import { createNativeSession } from "../../../../lib/native-auth.js";
import { validate } from "../../../../lib/validate";
import { getGitHubUserProfile } from "../../../../lib/github-user.js";

interface Env {
  DB: D1Database;
  ENCRYPTION_KEY?: string;
  GITHUB_APP_CLIENT_ID?: string;
  GITHUB_APP_CLIENT_SECRET?: string;
}

const Body = z.object({
  client: z.literal("noxfeed-mac"),
  device_code: z.string().startsWith("noxdc_").max(128),
});

export async function onRequestPost(context: { env: Env; request: Request }): Promise<Response> {
  const { ENCRYPTION_KEY: encryptionKey, GITHUB_APP_CLIENT_ID: clientId, GITHUB_APP_CLIENT_SECRET: clientSecret } = context.env;
  if (!encryptionKey || !clientId || !clientSecret) {
    return failure("native_auth_unavailable", "Native authentication is not configured", 503);
  }
  const parsed = validate(Body, await context.request.json().catch(() => null));
  if (!parsed.ok) return parsed.response;
  const row = await context.env.DB.prepare(
    `SELECT * FROM native_device_authorizations
      WHERE id = ? AND client_name = ? AND consumed_at IS NULL AND expires_at > ?`,
  ).bind(parsed.data.device_code, parsed.data.client, new Date().toISOString()).first<Record<string, unknown>>();
  if (!row) return failure("expired_token", "The sign-in code expired; start again", 400);

  const lastPolled = row.last_polled_at ? Date.parse(String(row.last_polled_at)) : 0;
  const interval = Number(row.interval_seconds) || 5;
  const remainingMs = interval * 1000 - (Date.now() - lastPolled);
  if (remainingMs > 0) {
    return failure("slow_down", "Wait before checking the sign-in code again", 429, Math.ceil(remainingMs / 1000));
  }
  const claimed = await context.env.DB.prepare(
    `UPDATE native_device_authorizations SET last_polled_at = ?
      WHERE id = ? AND consumed_at IS NULL
        AND (last_polled_at IS NULL OR last_polled_at <= ?)
      RETURNING id`,
  ).bind(
    new Date().toISOString(), row.id,
    new Date(Date.now() - interval * 1000).toISOString(),
  ).first();
  if (!claimed) return failure("slow_down", "Wait before checking the sign-in code again", 429, interval);

  const providerDeviceCode = await decryptToken(String(row.encrypted_device_code), encryptionKey);
  let providerResponse: Response;
  try {
    providerResponse = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "NoxConnect",
      },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        device_code: providerDeviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });
  } catch {
    return failure("provider_unavailable", "GitHub sign-in is temporarily unavailable", 503);
  }
  const data = await providerResponse.json().catch(() => null) as Record<string, unknown> | null;
  if (!providerResponse.ok || !data) return failure("provider_unavailable", "GitHub sign-in is temporarily unavailable", 503);
  if (typeof data.error === "string") {
    const status = data.error === "authorization_pending" ? 202
      : data.error === "slow_down" ? 429 : 400;
    return failure(data.error, providerMessage(data.error), status, status === 429 ? interval + 5 : undefined);
  }
  if (typeof data.access_token !== "string") return failure("invalid_provider_response", "GitHub returned an invalid sign-in response", 502);

  let user: { login: string; avatar_url?: string | null };
  try {
    user = await getGitHubUserProfile(data.access_token) as typeof user;
  } catch {
    return failure("invalid_provider_response", "GitHub could not verify this identity", 502);
  }
  const consumed = await context.env.DB.prepare(
    `UPDATE native_device_authorizations
        SET consumed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      WHERE id = ? AND consumed_at IS NULL RETURNING id`,
  ).bind(row.id).first();
  if (!consumed) return failure("expired_token", "This sign-in code was already used", 400);

  const session = await createNativeSession(context.env.DB, encryptionKey, {
    clientName: parsed.data.client,
    githubLogin: user.login,
    githubToken: data.access_token,
    githubRefreshToken: typeof data.refresh_token === "string" ? data.refresh_token : null,
    githubExpiresIn: data.expires_in,
    githubRefreshExpiresIn: data.refresh_token_expires_in,
  });
  return json({
    access_token: session.accessToken,
    refresh_token: session.refreshToken,
    token_type: "bearer",
    expires_in: session.expiresIn,
    user,
  });
}

function providerMessage(error: string): string {
  if (error === "authorization_pending") return "Waiting for GitHub authorization";
  if (error === "slow_down") return "Wait before checking the sign-in code again";
  if (error === "access_denied") return "GitHub authorization was cancelled";
  if (error === "expired_token") return "The sign-in code expired; start again";
  return "GitHub rejected the sign-in request";
}

function json(body: unknown, status = 200, retryAfter?: number): Response {
  const headers = new Headers({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  if (retryAfter) headers.set("Retry-After", String(retryAfter));
  return Response.json(body, { status, headers });
}

function failure(code: string, message: string, status: number, retryAfter?: number): Response {
  return json({ error: code, error_description: message }, status, retryAfter);
}
