import { describe, expect, it, vi } from "vitest";
import { onRequestGet } from "../cues/sources/[id]/apple";

describe("NoxCue Apple analytics API", () => {
  it("returns connection status without ever selecting the encrypted private key", async () => {
    const statements: string[] = [];
    const prepare = vi.fn((sql: string) => {
      statements.push(sql);
      const statement = {
        bind: vi.fn(() => statement),
        first: vi.fn(async () => sql.includes("FROM cue_sources")
          ? { id: "source-1", environment: "production" }
          : {
              app_id: "1476097583",
              key_id: "ABC123DEFG",
              status: "active",
              last_synced_at: "2026-09-10T06:00:00Z",
              last_successful_period: "2026-09-08",
              last_error: null,
              created_at: "2026-09-01T12:00:00Z",
            }),
      };
      return statement;
    });
    const response = await onRequestGet({
      env: { DB: { prepare } },
      data: { orgId: 7, orgLogin: "acme", isAdmin: true },
      params: { id: "source-1" },
      request: new Request("https://example.com"),
    } as never);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      connected: true,
      appId: "1476097583",
      keyId: "ABC123DEFG",
      status: "active",
      lastSyncedAt: "2026-09-10T06:00:00Z",
      lastSuccessfulPeriod: "2026-09-08",
      lastError: null,
      createdAt: "2026-09-01T12:00:00Z",
    });
    expect(statements.join("\n")).not.toContain("encrypted_private_key");
  });

  it("requires an administrator before reading connection state", async () => {
    const prepare = vi.fn();
    const response = await onRequestGet({
      env: { DB: { prepare } },
      data: { orgId: 7, orgLogin: "acme", isAdmin: false },
      params: { id: "source-1" },
      request: new Request("https://example.com"),
    } as never);
    expect(response.status).toBe(403);
    expect(prepare).not.toHaveBeenCalled();
  });
});
