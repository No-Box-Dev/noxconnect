import { z } from "zod";
import { decryptToken } from "../../lib/crypto";
import { validate } from "../../lib/validate";

interface Env {
  DB: D1Database;
  ENCRYPTION_KEY?: string;
  [k: string]: unknown;
}

interface Ctx {
  env: Env;
  request: Request;
}

// Body schema — replaces the hand-rolled `typeof code === "string"` check.
const ExchangeBody = z.object({
  code: z.string().min(1, "Missing exchange code"),
});

/**
 * POST /api/auth/exchange
 * Exchanges a one-time auth code for the GitHub access token.
 * The code is deleted after use (one-time only).
 */
export async function legacyTokenExchange(context: Ctx): Promise<Response> {
  let rawBody: unknown;
  try {
    rawBody = await context.request.json();
  } catch {
    return jsonError("Invalid request body", 400);
  }

  const parsed = validate(ExchangeBody, rawBody);
  if (!parsed.ok) return parsed.response;
  const { code } = parsed.data;

  // Clean up expired pending tokens first
  await context.env.DB.prepare(
    "DELETE FROM pending_tokens WHERE created_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-5 minutes')"
  ).run();

  // Look up and delete the pending token in one step
  const row = await context.env.DB.prepare(
    "DELETE FROM pending_tokens WHERE code = ? RETURNING encrypted_token"
  ).bind(code).first<{ encrypted_token: string }>();

  if (!row) {
    return jsonError("Invalid or expired exchange code", 401);
  }

  // Distinguish "infra is broken" (ENCRYPTION_KEY missing) from "this token
  // is bad" (decrypt failed). The old catch-all 401 masked exactly the
  // ENCRYPTION_KEY-missing failure that caused the May 12 outage: users
  // saw "Invalid or expired exchange code" instead of a 5xx that would
  // have surfaced the misconfiguration.
  const encryptionKey = context.env.ENCRYPTION_KEY;
  if (!encryptionKey) {
    console.error("[auth/exchange] ENCRYPTION_KEY is not configured");
    return jsonError("Server misconfigured: ENCRYPTION_KEY missing", 500);
  }
  let token: string;
  try {
    token = await decryptToken(row.encrypted_token, encryptionKey);
  } catch (err) {
    console.error("[auth/exchange] decryptToken failed:", (err as Error)?.message ?? err);
    return jsonError("Invalid or expired exchange code", 401);
  }

  return new Response(JSON.stringify({ token }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

export async function onRequestPost(): Promise<Response> {
  return new Response(JSON.stringify({
    error: "Token exchange has been replaced by the secure browser session flow. Sign in again.",
  }), {
    status: 410,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
