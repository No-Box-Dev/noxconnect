import { afterEach, describe, expect, it, vi } from "vitest";
import { exchangeGitHubOAuthIdentity, startGitHubDeviceIdentity } from "../connection-identity";

function database() {
  const calls: Array<{ sql: string; binds: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      const statement = {
        binds: [] as unknown[],
        bind(...binds: unknown[]) { statement.binds = binds; return statement; },
        async first() {
          calls.push({ sql, binds: statement.binds });
          if (sql.includes("SELECT id FROM orgs")) return { id: statement.binds[0] === "octocat" ? 8 : 7 };
          if (sql.includes("RETURNING id")) return { id: statement.binds[0] };
          return null;
        },
        async run() { calls.push({ sql, binds: statement.binds }); return { meta: { changes: 1 } }; },
      };
      return statement;
    },
  } as unknown as D1Database;
  return { db, calls };
}

afterEach(() => vi.unstubAllGlobals());

describe("GitHub OAuth identity connection", () => {
  it("stores provider tokens encrypted and returns only bounded identity claims", async () => {
    const { db, calls } = database();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("oauth/access_token")) return Response.json({
        access_token: "github-access-secret",
        refresh_token: "github-refresh-secret",
        expires_in: 28_800,
        refresh_token_expires_in: 15_897_600,
      });
      if (url.endsWith("/user")) return Response.json({ id: 42, login: "octocat", avatar_url: "https://example.test/avatar" });
      return Response.json([{ role: "admin", state: "active", organization: { login: "acme" } }]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await exchangeGitHubOAuthIdentity({
      DB: db,
      GITHUB_APP_CLIENT_ID: "client-id",
      GITHUB_APP_CLIENT_SECRET: "client-secret",
      ENCRYPTION_KEY: "11".repeat(32),
      NOXHERE_OAUTH_CALLBACK_URL: "https://app.noxhere.com/auth/github/callback",
    }, {
      code: "one-time-code",
      redirectUri: "https://app.noxhere.com/auth/github/callback",
    });

    expect(result).toMatchObject({
      version: 1,
      user: { id: 42, login: "octocat" },
      organizations: [
        { id: 8, login: "octocat", role: "admin" },
        { id: 7, login: "acme", role: "admin" },
      ],
    });
    expect(result.connectionId).toMatch(/^noxic_/);
    expect(JSON.stringify(result)).not.toContain("github-access-secret");
    expect(JSON.stringify(result)).not.toContain("github-refresh-secret");
    const insert = calls.find((call) => call.sql.includes("INSERT INTO identity_connections"));
    expect(insert?.binds).not.toContain("github-access-secret");
    expect(insert?.binds).not.toContain("github-refresh-secret");
    expect(String(insert?.binds[4])).toContain(":");
  });

  it("exposes the signed-in user's personal workspace without organization memberships", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("oauth/access_token")) return Response.json({ access_token: "github-access-secret" });
      if (url.endsWith("/user")) return Response.json({ id: 42, login: "octocat" });
      return Response.json([]);
    }));

    const result = await exchangeGitHubOAuthIdentity({
      DB: database().db,
      GITHUB_APP_CLIENT_ID: "client-id",
      GITHUB_APP_CLIENT_SECRET: "client-secret",
      ENCRYPTION_KEY: "11".repeat(32),
      NOXHERE_OAUTH_CALLBACK_URL: "https://app.noxhere.com/auth/github/callback",
    }, {
      code: "one-time-code",
      redirectUri: "https://app.noxhere.com/auth/github/callback",
    });

    expect(result.organizations).toEqual([{ id: 8, login: "octocat", role: "admin" }]);
  });

  it("rejects a caller-selected OAuth callback before contacting GitHub", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(exchangeGitHubOAuthIdentity({
      DB: database().db,
      GITHUB_APP_CLIENT_ID: "client-id",
      GITHUB_APP_CLIENT_SECRET: "client-secret",
      ENCRYPTION_KEY: "11".repeat(32),
      NOXHERE_OAUTH_CALLBACK_URL: "https://app.noxhere.com/auth/github/callback",
    }, {
      code: "one-time-code",
      redirectUri: "https://attacker.example/callback",
    })).rejects.toThrow("invalid_identity_redirect_uri");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns an opaque device handle and encrypts GitHub's device code", async () => {
    const { db, calls } = database();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      device_code: "github-provider-device-secret",
      user_code: "ABCD-EFGH",
      verification_uri: "https://github.com/login/device",
      expires_in: 900,
      interval: 5,
    })));
    const result = await startGitHubDeviceIdentity({
      DB: db,
      GITHUB_APP_CLIENT_ID: "client-id",
      ENCRYPTION_KEY: "11".repeat(32),
    }, { client: "noxfeed-mac" });
    expect(result.deviceCode).toMatch(/^noxid_/);
    expect(JSON.stringify(result)).not.toContain("github-provider-device-secret");
    const insert = calls.find((call) => call.sql.includes("INSERT INTO identity_device_authorizations"));
    expect(insert?.binds).not.toContain("github-provider-device-secret");
    expect(String(insert?.binds[2])).toContain(":");
  });
});
