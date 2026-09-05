import { z } from "zod";
import { encryptToken } from "../../../../lib/crypto";
import { randomToken } from "../../../../lib/api-auth.js";
import { nativeAuthRateLimit } from "../../../../lib/native-auth.js";
import { validate } from "../../../../lib/validate";

interface Env {
  DB: D1Database;
  ENCRYPTION_KEY?: string;
  GITHUB_APP_CLIENT_ID?: string;
  NATIVE_AUTH_RATE_LIMITER?: RateLimit;
}

const Body = z.object({ client: z.literal("noxfeed-mac") });

export async function onRequestPost(context: { env: Env; request: Request }): Promise<Response> {
  if (!context.env.ENCRYPTION_KEY || !context.env.GITHUB_APP_CLIENT_ID) {
    return failure("native_auth_unavailable", "Native authentication is not configured", 503);
  }
  const rate = await nativeAuthRateLimit(context.env, context.request, "device-start");
  if (rate === "limited") return failure("rate_limited", "Too many sign-in attempts; wait a minute", 429);
  if (rate !== "allowed") return failure("native_auth_unavailable", "Native authentication is temporarily unavailable", 503);
  const parsed = validate(Body, await context.request.json().catch(() => null));
  if (!parsed.ok) return parsed.response;

  let response: Response;
  try {
    response = await fetch("https://github.com/login/device/code", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "NoxConnect",
      },
      body: new URLSearchParams({ client_id: context.env.GITHUB_APP_CLIENT_ID }),
    });
  } catch {
    return failure("provider_unavailable", "GitHub sign-in is temporarily unavailable", 503);
  }
  const data = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok || !data || typeof data.device_code !== "string" ||
      typeof data.user_code !== "string" || typeof data.verification_uri !== "string") {
    return failure("provider_unavailable", "GitHub sign-in is temporarily unavailable", 503);
  }

  const interval = Math.min(60, Math.max(5, Number(data.interval) || 5));
  const expiresIn = Math.min(900, Math.max(60, Number(data.expires_in) || 900));
  const id = `noxdc_${randomToken(24)}`;
  const encrypted = await encryptToken(data.device_code, context.env.ENCRYPTION_KEY);
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
  await context.env.DB.prepare(
    `INSERT INTO native_device_authorizations
       (id, encrypted_device_code, client_name, interval_seconds, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).bind(id, encrypted, parsed.data.client, interval, expiresAt).run();

  return json({
    device_code: id,
    user_code: data.user_code,
    verification_uri: data.verification_uri,
    expires_in: expiresIn,
    interval,
  });
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: securityHeaders() });
}

function failure(code: string, message: string, status: number): Response {
  return json({ error: code, error_description: message }, status);
}

function securityHeaders(): Headers {
  return new Headers({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
}
