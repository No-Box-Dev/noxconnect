import { DurableObject } from "cloudflare:workers";

const MAX_LIMIT = 1_000;
const MAX_WINDOW_MS = 3_600_000;

export class RateLimiter extends DurableObject<Env> {

  async check(key: string, limit: number, windowMs: number): Promise<{ limited: boolean; retryAfter: number }> {
    if (!/^[0-9a-f]{64}$/.test(key) || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT ||
        !Number.isInteger(windowMs) || windowMs < 1_000 || windowMs > MAX_WINDOW_MS) {
      throw new RangeError("Invalid rate-limit request");
    }

    const now = Date.now();
    const existing = await this.ctx.storage.get<{ window_start: number; expires_at: number; count: number }>(key);

    const windowStart = !existing || now >= existing.expires_at ? now : existing.window_start;
    const expiresAt = !existing || now >= existing.expires_at ? now + windowMs : existing.expires_at;
    const count = !existing || now >= existing.expires_at ? 1 : existing.count + 1;
    await this.ctx.storage.put(key, { window_start: windowStart, expires_at: expiresAt, count });
    return { limited: count > limit, retryAfter: count > limit ? Math.max(1, Math.ceil((expiresAt - now) / 1_000)) : 0 };
  }
}

export async function checkRateLimit(env: Pick<Env, "RATE_LIMITER">, key: string, limit: number, windowMs = 60_000): Promise<boolean> {
  try {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)));
    const hash = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
    const stub = env.RATE_LIMITER.getByName(`shard:${digest[0] % 64}`);
    return (await stub.check(hash, limit, windowMs)).limited;
  } catch (error) {
    console.error(JSON.stringify({ event: "noxspot.rate_limit.failure", error: error instanceof Error ? error.message : String(error) }));
    return true;
  }
}
