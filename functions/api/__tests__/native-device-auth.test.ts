import { beforeEach, describe, expect, it, vi } from "vitest";
import { onRequestPost as startDevice } from "../auth/native/device/start";
import { onRequestPost as pollDevice } from "../auth/native/device/poll";

const encryptionKey = "22".repeat(32);

class NativeAuthDb {
  device: Record<string, unknown> | null = null;
  sessions: Array<Record<string, unknown>> = [];

  prepare(sql: string) {
    return {
      bind: (...args: unknown[]) => ({
        run: async () => {
          if (sql.includes("INSERT INTO native_device_authorizations")) {
            this.device = {
              id: args[0], encrypted_device_code: args[1], client_name: args[2],
              interval_seconds: args[3], expires_at: args[4], last_polled_at: null, consumed_at: null,
            };
          } else if (sql.includes("INSERT INTO native_sessions")) {
            this.sessions.push({
              id: args[0], client_name: args[1], github_login: args[2],
              access_token_hash: args[3], refresh_token_hash: args[4],
              encrypted_github_token: args[5], encrypted_github_refresh_token: args[6],
            });
          }
          return { success: true };
        },
        first: async () => {
          if (sql.includes("FROM native_device_authorizations")) return this.device;
          if (sql.includes("SET last_polled_at") && this.device) {
            this.device.last_polled_at = args[0];
            return { id: this.device.id };
          }
          if (sql.includes("SET consumed_at") && this.device && !this.device.consumed_at) {
            this.device.consumed_at = new Date().toISOString();
            return { id: this.device.id };
          }
          return null;
        },
      }),
    };
  }
}

describe("brokered native device authentication", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("rate-limits before making a provider request", async () => {
    globalThis.fetch = vi.fn();
    const response = await startDevice({
      env: {
        DB: new NativeAuthDb() as unknown as D1Database,
        ENCRYPTION_KEY: encryptionKey,
        GITHUB_APP_CLIENT_ID: "client-id",
        NATIVE_AUTH_RATE_LIMITER: { limit: vi.fn(async () => ({ success: false })) } as unknown as RateLimit,
      },
      request: new Request("https://app.unticket.ai/api/auth/native/device/start", {
        method: "POST", body: JSON.stringify({ client: "noxfeed-mac" }),
      }),
    });
    expect(response.status).toBe(429);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("keeps the GitHub device and provider tokens out of the native response and D1 plaintext", async () => {
    const db = new NativeAuthDb();
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({
        device_code: "github-device-secret",
        user_code: "ABCD-EFGH",
        verification_uri: "https://github.com/login/device",
        interval: 0,
        expires_in: 900,
      }))
      .mockResolvedValueOnce(Response.json({
        access_token: "github-access-secret",
        refresh_token: "github-refresh-secret",
        expires_in: 28_800,
        refresh_token_expires_in: 15_897_600,
      }))
      .mockResolvedValueOnce(Response.json({ login: "ada", avatar_url: "https://img.example/ada" }));
    const env = {
      DB: db as unknown as D1Database,
      ENCRYPTION_KEY: encryptionKey,
      GITHUB_APP_CLIENT_ID: "client-id",
      GITHUB_APP_CLIENT_SECRET: "server-only-secret",
      NATIVE_AUTH_RATE_LIMITER: { limit: vi.fn(async () => ({ success: true })) } as unknown as RateLimit,
    };

    const started = await startDevice({
      env,
      request: new Request("https://app.unticket.ai/api/auth/native/device/start", {
        method: "POST", body: JSON.stringify({ client: "noxfeed-mac" }),
        headers: { "Content-Type": "application/json" },
      }),
    });
    const startBody = await started.json() as Record<string, unknown>;
    expect(startBody.device_code).toMatch(/^noxdc_/);
    expect(JSON.stringify(startBody)).not.toContain("github-device-secret");
    expect(JSON.stringify(db.device)).not.toContain("github-device-secret");

    const polled = await pollDevice({
      env,
      request: new Request("https://app.unticket.ai/api/auth/native/device/poll", {
        method: "POST", body: JSON.stringify({ client: "noxfeed-mac", device_code: startBody.device_code }),
        headers: { "Content-Type": "application/json" },
      }),
    });
    const tokenBody = await polled.json() as Record<string, unknown>;
    expect(polled.status).toBe(200);
    expect(tokenBody.access_token).toMatch(/^nox_at_/);
    expect(tokenBody.refresh_token).toMatch(/^nox_rt_/);
    expect(tokenBody.user).toEqual({ login: "ada", avatar_url: "https://img.example/ada" });
    expect(JSON.stringify(tokenBody)).not.toContain("github-access-secret");
    expect(JSON.stringify(tokenBody)).not.toContain("github-refresh-secret");
    expect(JSON.stringify(db.sessions)).not.toContain("github-access-secret");
    expect(JSON.stringify(db.sessions)).not.toContain("github-refresh-secret");

    const providerPoll = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(String(providerPoll[1]?.body)).toContain("client_secret=server-only-secret");
  });
});
