import { describe, expect, it, vi } from "vitest";
import {
  createNativeSession,
  NativeAuthError,
  refreshNativeSession,
  resolveNativeSession,
  revokeNativeSession,
  revokeNativeSessionWithRefreshToken,
} from "../native-auth.js";

const encryptionKey = "11".repeat(32);

class MemoryD1 {
  rows: Array<Record<string, unknown>> = [];

  prepare(sql: string) {
    return {
      bind: (...args: unknown[]) => ({
        run: async () => {
          if (sql.includes("INSERT INTO native_sessions")) {
            const [id, client_name, github_login, access_token_hash, refresh_token_hash,
              encrypted_github_token, encrypted_github_refresh_token,
              github_token_expires_at, github_refresh_expires_at,
              access_expires_at, refresh_expires_at] = args;
            this.rows.push({
              id, client_name, github_login, access_token_hash, refresh_token_hash,
              encrypted_github_token, encrypted_github_refresh_token,
              github_token_expires_at, github_refresh_expires_at,
              access_expires_at, refresh_expires_at, revoked_at: null,
            });
          } else if (sql.includes("SET revoked_at") && sql.includes("WHERE id")) {
            const row = this.rows.find((candidate) => candidate.id === args[0]);
            if (row) row.revoked_at = new Date().toISOString();
          }
          return { success: true };
        },
        first: async () => {
          if (sql.includes("WHERE access_token_hash")) {
            return this.rows.find((row) => row.access_token_hash === args[0] && !row.revoked_at) ?? null;
          }
          if (sql.includes("WHERE refresh_token_hash")) {
            const row = this.rows.find((candidate) => candidate.refresh_token_hash === args[0] && !candidate.revoked_at) ?? null;
            if (row && sql.includes("SET revoked_at")) row.revoked_at = new Date().toISOString();
            return row;
          }
          if (sql.includes("SET access_token_hash")) {
            const row = this.rows.find((candidate) => candidate.id === args[4]
              && candidate.refresh_token_hash === args[5] && !candidate.revoked_at);
            if (!row) return null;
            row.access_token_hash = args[0];
            row.refresh_token_hash = args[1];
            row.access_expires_at = args[2];
            row.refresh_expires_at = args[3];
            return { id: row.id };
          }
          return null;
        },
      }),
    };
  }
}

describe("native NoxConnect sessions", () => {
  it("stores only hashes, resolves an opaque access token, and rotates both credentials", async () => {
    const db = new MemoryD1();
    const issued = await createNativeSession(db as unknown as D1Database, encryptionKey, {
      githubLogin: "ada",
      githubToken: "github-provider-secret",
      githubRefreshToken: "github-provider-refresh",
    });

    expect(issued.accessToken).toMatch(/^nox_at_/);
    expect(issued.refreshToken).toMatch(/^nox_rt_/);
    expect(JSON.stringify(db.rows)).not.toContain(issued.accessToken);
    expect(JSON.stringify(db.rows)).not.toContain(issued.refreshToken);
    expect(JSON.stringify(db.rows)).not.toContain("github-provider-secret");

    const resolved = await resolveNativeSession(db as unknown as D1Database, encryptionKey, issued.accessToken);
    expect(resolved?.github_login).toBe("ada");
    expect(resolved?.githubToken).toBe("github-provider-secret");

    const rotated = await refreshNativeSession(db as unknown as D1Database, {
      DB: db as unknown as D1Database,
      ENCRYPTION_KEY: encryptionKey,
    }, issued.refreshToken);
    expect(rotated?.accessToken).toMatch(/^nox_at_/);
    expect(rotated?.accessToken).not.toBe(issued.accessToken);
    expect(await resolveNativeSession(db as unknown as D1Database, encryptionKey, issued.accessToken)).toBeNull();
    expect((await resolveNativeSession(db as unknown as D1Database, encryptionKey, rotated!.accessToken))?.githubToken)
      .toBe("github-provider-secret");

    await revokeNativeSession(db as unknown as D1Database, issued.id);
    expect(await resolveNativeSession(db as unknown as D1Database, encryptionKey, rotated!.accessToken)).toBeNull();
  });

  it("revokes the server session with a refresh token after access expiry", async () => {
    const db = new MemoryD1();
    const issued = await createNativeSession(db as unknown as D1Database, encryptionKey, {
      githubLogin: "ada",
      githubToken: "github-provider-secret",
    });
    db.rows[0].access_expires_at = new Date(Date.now() - 1000).toISOString();

    expect(await revokeNativeSessionWithRefreshToken(db as unknown as D1Database, issued.refreshToken)).toBe(true);
    expect(db.rows[0].revoked_at).not.toBeNull();
  });

  it("keeps a native session on a temporary GitHub refresh failure", async () => {
    const db = new MemoryD1();
    const issued = await createNativeSession(db as unknown as D1Database, encryptionKey, {
      githubLogin: "ada",
      githubToken: "github-provider-secret",
      githubRefreshToken: "github-provider-refresh",
    });
    db.rows[0].github_token_expires_at = new Date(Date.now() - 1000).toISOString();
    globalThis.fetch = vi.fn(async () => { throw new Error("temporary network failure"); });

    await expect(refreshNativeSession(db as unknown as D1Database, {
      DB: db as unknown as D1Database,
      ENCRYPTION_KEY: encryptionKey,
      GITHUB_APP_CLIENT_ID: "client",
      GITHUB_APP_CLIENT_SECRET: "secret",
    }, issued.refreshToken)).rejects.toBeInstanceOf(NativeAuthError);
    expect(db.rows[0].revoked_at).toBeNull();
  });
});
