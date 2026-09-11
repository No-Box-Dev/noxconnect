import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../crypto", () => ({
  decryptToken: vi.fn(async (encrypted) => `decrypted:${encrypted}`),
  encryptToken: vi.fn(async (plain) => `encrypted:${plain}`),
}));

import {
  buildOAuthAuthorizeUrl,
  isSlackTeamId,
  SLACK_OAUTH_REDIRECT_URI,
  resolveSlackOAuthRedirectUri,
  SLACK_BOT_SCOPES,
  exchangeOAuthCode,
  signOAuthState,
  verifyOAuthState,
  resolveSlackInstall,
  saveSlackInstall,
  resolveSlackChannels,
  resolveSlackRoute,
  resolveSlackConnectionId,
  slackInstallNeedsReconnect,
  clearSlackChannelsForOrg,
  postSlackMessage,
  openSlackModal,
  listSlackChannels,
} from "../slack.js";

describe("slackInstallNeedsReconnect", () => {
  const currentApp = { SLACK_APP_ID: "A_CURRENT" };

  it("requires legacy installs to reconnect by default", () => {
    expect(slackInstallNeedsReconnect(currentApp, { appId: null })).toBe(true);
  });

  it("accepts legacy installs only when the compatibility flag is explicit", () => {
    expect(slackInstallNeedsReconnect(
      { ...currentApp, SLACK_ACCEPT_LEGACY_INSTALLS: "true" },
      { appId: null },
    )).toBe(false);
  });

  it("rejects a known different app even in legacy compatibility mode", () => {
    expect(slackInstallNeedsReconnect(
      { ...currentApp, SLACK_ACCEPT_LEGACY_INSTALLS: "true" },
      { appId: "A_OTHER" },
    )).toBe(true);
  });

  it("accepts an install recorded for the current app", () => {
    expect(slackInstallNeedsReconnect(currentApp, { appId: "A_CURRENT" })).toBe(false);
  });
});

describe("saveSlackInstall", () => {
  it("clears stale health errors after a successful reconnect", async () => {
    const calls = [];
    const db = {
      prepare(sql) {
        const statement = {
          bind: (...binds) => {
            calls.push({ sql, binds });
            return statement;
          },
          first: async () => ({ team_id: "T1" }),
          run: async () => ({ success: true }),
        };
        return statement;
      },
    };

    await saveSlackInstall(
      { DB: db, ENCRYPTION_KEY: "key" },
      7,
      {
        appId: "A1",
        botToken: "xoxb-new",
        botUserId: "U1",
        teamId: "T1",
        teamName: "Acme",
        installedBy: "alice",
      },
    );

    const upsert = calls.find(({ sql }) => sql.includes("INSERT INTO slack_connections"));
    expect(upsert.sql).toContain("health_status = 'unknown'");
    expect(upsert.sql).toContain("last_checked_at = NULL");
    expect(upsert.sql).toContain("last_error = NULL");
  });
});

describe("central Slack routing cleanup", () => {
  it("clears NoxSpot channels even when no feed settings exist", async () => {
    const calls = [];
    const db = {
      prepare(sql) {
        calls.push(sql);
        const statement = {
          bind: () => statement,
          run: async () => ({ success: true }),
          first: async () => null,
        };
        return statement;
      },
    };
    await clearSlackChannelsForOrg(db, 7);
    expect(calls[0]).toMatch(/UPDATE spot_sites SET slack_channel_id = NULL/);
  });
});

describe("isSlackTeamId", () => {
  it("accepts real team ids and rejects everything else", () => {
    expect(isSlackTeamId("T08B8C3E91N")).toBe(true);
    expect(isSlackTeamId("T1ABC23")).toBe(true);
    expect(isSlackTeamId("")).toBe(false);
    expect(isSlackTeamId("C08B8C3E91N")).toBe(false);
    expect(isSlackTeamId("t08b8c3e91n")).toBe(false);
    expect(isSlackTeamId("T08B8C3E91N<script>")).toBe(false);
    expect(isSlackTeamId(null)).toBe(false);
    expect(isSlackTeamId(42)).toBe(false);
  });
});

describe("buildOAuthAuthorizeUrl", () => {
  it("builds an authorize URL with the right scopes + state", () => {
    const url = buildOAuthAuthorizeUrl("client-123", "https://app.example.com", "state-xyz");
    expect(url).toContain("https://slack.com/oauth/v2/authorize");
    expect(url).toContain("client_id=client-123");
    expect(url).toContain("state=state-xyz");
    expect(url).toContain("channels%3Aread");
    expect(url).toContain("chat%3Awrite");
    expect(url).toContain(encodeURIComponent("https://app.example.com/api/slack/oauth/callback"));
  });

  it("uses the direct central callback for NoxConnect", () => {
    expect(SLACK_OAUTH_REDIRECT_URI).toBe("https://app.noxhere.com/api/slack/oauth/callback");
    const url = new URL(buildOAuthAuthorizeUrl(
      "client-123",
      "https://app.example.com",
      "state-xyz",
      SLACK_OAUTH_REDIRECT_URI,
    ));
    expect(url.searchParams.get("redirect_uri")).toBe(SLACK_OAUTH_REDIRECT_URI);
  });

  it("pins the workspace when a team is given and omits the param when empty", () => {
    const pinned = new URL(buildOAuthAuthorizeUrl(
      "client-123",
      "https://app.example.com",
      "state-xyz",
      SLACK_OAUTH_REDIRECT_URI,
      "T08B8C3E91N",
    ));
    expect(pinned.searchParams.get("team")).toBe("T08B8C3E91N");

    const unpinned = new URL(buildOAuthAuthorizeUrl(
      "client-123",
      "https://app.example.com",
      "state-xyz",
      SLACK_OAUTH_REDIRECT_URI,
      "",
    ));
    expect(unpinned.searchParams.has("team")).toBe(false);
  });

  it("ignores the retired NoxSpot callback override", () => {
    expect(resolveSlackOAuthRedirectUri({
      SLACK_OAUTH_REDIRECT_URI: "https://api.noxspot.dev/slack/callback",
    })).toBe(SLACK_OAUTH_REDIRECT_URI);
  });

  it("rejects an untrusted configured callback", () => {
    expect(resolveSlackOAuthRedirectUri({
      SLACK_OAUTH_REDIRECT_URI: "https://attacker.example/callback",
    })).toBe(SLACK_OAUTH_REDIRECT_URI);
  });
});

describe("Slack app manifest", () => {
  const manifest = JSON.parse(readFileSync(join(process.cwd(), "slack-app-manifest.json"), "utf8"));

  it("stays aligned with the OAuth flow and production endpoints", () => {
    expect(manifest.display_information.name).toBe("NoxConnect");
    expect(manifest.features.bot_user.display_name).toBe("NoxConnect");
    expect(manifest.oauth_config.scopes.bot).toEqual(SLACK_BOT_SCOPES);
    expect(manifest.oauth_config.redirect_urls).toEqual([
      "https://app.noxhere.com/api/slack/oauth/callback",
    ]);
    expect(manifest.settings.event_subscriptions).toEqual({
      request_url: "https://app.noxhere.com/api/slack/events",
      bot_events: ["link_shared"],
    });
    expect(manifest.settings.interactivity).toEqual({
      is_enabled: true,
      request_url: "https://app.noxhere.com/api/slack/interactions",
    });
    expect(manifest.features.unfurl_domains).toEqual(["app.noxhere.com"]);
  });
});

describe("exchangeOAuthCode", () => {
  beforeEach(() => { globalThis.fetch = vi.fn(); });
  afterEach(() => vi.restoreAllMocks());

  it("returns bot token + team metadata on success", async () => {
    globalThis.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        app_id: "A123",
        access_token: "xoxb-abc",
        bot_user_id: "U123",
        team: { id: "T999", name: "Acme" },
      }),
    });
    const result = await exchangeOAuthCode({
      clientId: "c", clientSecret: "s", code: "code1", redirectUri: "https://x/cb",
    });
    expect(result).toEqual({
      appId: "A123",
      botToken: "xoxb-abc",
      botUserId: "U123",
      teamId: "T999",
      teamName: "Acme",
    });
  });

  it("throws when Slack returns ok=false", async () => {
    globalThis.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: false, error: "invalid_code" }),
    });
    await expect(exchangeOAuthCode({ clientId: "c", clientSecret: "s", code: "x", redirectUri: "u" }))
      .rejects.toThrow(/invalid_code/);
  });

  it("throws when bot token is missing", async () => {
    globalThis.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, team: { id: "T1" } }),
    });
    await expect(exchangeOAuthCode({ clientId: "c", clientSecret: "s", code: "x", redirectUri: "u" }))
      .rejects.toThrow(/no bot token/);
  });
});

describe("HMAC state signing", () => {
  it("round-trips a payload through sign + verify", async () => {
    const payload = "nonce-abc:42:alice";
    const sig = await signOAuthState("secret-1", payload);
    const verified = await verifyOAuthState("secret-1", `${payload}.${sig}`);
    expect(verified).toEqual({ orgId: 42, userLogin: "alice" });
  });

  it("rejects an unsigned state", async () => {
    expect(await verifyOAuthState("secret-1", "nonce:42:alice")).toBeNull();
  });

  it("rejects a state signed with a different secret", async () => {
    const payload = "nonce:42:alice";
    const sig = await signOAuthState("attacker-secret", payload);
    expect(await verifyOAuthState("real-secret", `${payload}.${sig}`)).toBeNull();
  });

  it("rejects a state where the attacker swapped the orgId", async () => {
    // Attacker has a valid signature for orgId=42, tampers it to 99.
    const payload = "nonce:42:alice";
    const sig = await signOAuthState("secret-1", payload);
    const tampered = `nonce:99:alice.${sig}`;
    expect(await verifyOAuthState("secret-1", tampered)).toBeNull();
  });

  it("rejects malformed states", async () => {
    expect(await verifyOAuthState("secret-1", "")).toBeNull();
    expect(await verifyOAuthState("secret-1", "no-dot")).toBeNull();
    expect(await verifyOAuthState("secret-1", "payload.")).toBeNull();
    expect(await verifyOAuthState("secret-1", null)).toBeNull();
  });

  it("rejects a state whose orgId isn't a positive integer", async () => {
    const payload = "nonce:not-a-number:alice";
    const sig = await signOAuthState("secret-1", payload);
    expect(await verifyOAuthState("secret-1", `${payload}.${sig}`)).toBeNull();
  });

  it("enforces expiry for versioned browser handoff state", async () => {
    const freshPayload = `nonce:42:alice:${Date.now()}`;
    const freshSig = await signOAuthState("secret-1", freshPayload);
    expect(await verifyOAuthState("secret-1", `${freshPayload}.${freshSig}`, 600_000))
      .toMatchObject({ orgId: 42, userLogin: "alice" });

    const oldPayload = `nonce:42:alice:${Date.now() - 600_001}`;
    const oldSig = await signOAuthState("secret-1", oldPayload);
    expect(await verifyOAuthState("secret-1", `${oldPayload}.${oldSig}`, 600_000)).toBeNull();
  });

  it("round-trips a project assignment in browser handoff state", async () => {
    const payload = `nonce:42:alice:${Date.now()}:${encodeURIComponent("proj_acme_web")}`;
    const sig = await signOAuthState("secret-1", payload);
    expect(await verifyOAuthState("secret-1", `${payload}.${sig}`, 600_000))
      .toMatchObject({ orgId: 42, userLogin: "alice", projectId: "proj_acme_web" });
  });
});

describe("resolveSlackInstall", () => {
  function mkDb(row) {
    return { prepare: () => ({ bind: () => ({ first: async () => row }) }) };
  }
  it("returns null with no encryption key", async () => {
    const env = { DB: mkDb({ encrypted_bot_token: "enc" }) };
    expect(await resolveSlackInstall(env, "org-1")).toBeNull();
  });
  it("returns null when no row", async () => {
    const env = { DB: mkDb(null), ENCRYPTION_KEY: "k" };
    expect(await resolveSlackInstall(env, "org-1")).toBeNull();
  });
  it("decrypts + returns the install row", async () => {
    const env = {
      DB: mkDb({
        id: "conn-1",
        is_default: 1,
        app_id: "A1",
        team_id: "T1",
        team_name: "Acme",
        bot_user_id: "U1",
        encrypted_bot_token: "enc",
      }),
      ENCRYPTION_KEY: "k",
    };
    expect(await resolveSlackInstall(env, "org-1")).toEqual({
      id: "conn-1",
      isDefault: true,
      appId: "A1",
      teamId: "T1",
      teamName: "Acme",
      botUserId: "U1",
      botToken: "decrypted:enc",
    });
  });
});

describe("resolveSlackChannels", () => {
  function mkDb(row) {
    return { prepare: () => ({ bind: () => ({ first: async () => row }) }) };
  }
  it("returns empty IDs when no settings", async () => {
    expect(await resolveSlackChannels(mkDb(null), "org-1")).toEqual({
      fallbackChannelId: "", noxCueChannelId: "", noxTicketChannelId: "", noxFeedChannelId: "",
      postsChannelId: "", releaseNotesChannelId: "", fallbackConnectionId: "", noxCueConnectionId: "",
      noxTicketConnectionId: "", postsConnectionId: "", releaseNotesConnectionId: "",
      dailySummaryChannelId: "", dailySummaryConnectionId: "", noxFeedProjectId: "",
    });
  });
  it("adopts a combined NoxFeed route for both streams", async () => {
    const row = { data: JSON.stringify({ slack: {
      fallbackChannelId: "C0", noxCueChannelId: "CA", noxTicketChannelId: "CU", noxFeedChannelId: "CF",
    } }) };
    expect(await resolveSlackChannels(mkDb(row), "org-1")).toEqual({
      fallbackChannelId: "C0", noxCueChannelId: "CA", noxTicketChannelId: "CU", noxFeedChannelId: "CF",
      postsChannelId: "CF", releaseNotesChannelId: "CF", fallbackConnectionId: "", noxCueConnectionId: "",
      noxTicketConnectionId: "", postsConnectionId: "", releaseNotesConnectionId: "",
      dailySummaryChannelId: "", dailySummaryConnectionId: "", noxFeedProjectId: "",
    });
  });
  it("keeps dedicated NoxFeed routes distinct", async () => {
    const row = { data: JSON.stringify({ slack: {
      postsChannelId: "C-POSTS", releaseNotesChannelId: "C-RELEASES",
    } }) };
    expect(await resolveSlackChannels(mkDb(row), "org-1")).toMatchObject({
      postsChannelId: "C-POSTS", releaseNotesChannelId: "C-RELEASES",
    });
  });
  it("adopts pre-rename NoxTicket channel fields", async () => {
    const prefix = ["un", "ticket"].join("");
    const row = { data: JSON.stringify({ slack: {
      [`${prefix}ChannelId`]: "C-TICKET",
      [`${prefix}ConnectionId`]: "conn-ticket",
    } }) };
    expect(await resolveSlackChannels(mkDb(row), "org-1")).toMatchObject({
      noxTicketChannelId: "C-TICKET",
      noxTicketConnectionId: "conn-ticket",
    });
  });
  it("tolerates corrupt JSON", async () => {
    expect(await resolveSlackChannels(mkDb({ data: "not json" }), "org-1")).toEqual({
      fallbackChannelId: "", noxCueChannelId: "", noxTicketChannelId: "", noxFeedChannelId: "",
      postsChannelId: "", releaseNotesChannelId: "", fallbackConnectionId: "", noxCueConnectionId: "",
      noxTicketConnectionId: "", postsConnectionId: "", releaseNotesConnectionId: "",
      dailySummaryChannelId: "", dailySummaryConnectionId: "", noxFeedProjectId: "",
    });
  });

  it("returns the optional NoxFeed project scope", async () => {
    const row = { data: JSON.stringify({ slack: { noxFeedProjectId: " proj-1 " } }) };
    expect(await resolveSlackChannels(mkDb(row), "org-1")).toMatchObject({ noxFeedProjectId: "proj-1" });
  });

  it("uses service-specific channels before the organization fallback", () => {
    const channels = {
      fallbackChannelId: "C0", noxCueChannelId: "CA", noxTicketChannelId: "CU",
      postsChannelId: "CP", releaseNotesChannelId: "CR", dailySummaryChannelId: "CD",
    };
    expect(resolveSlackRoute(channels, "noxcue", "CS")).toBe("CA");
    expect(resolveSlackRoute(channels, "noxspot", "CS")).toBe("CS");
    expect(resolveSlackRoute(channels, "noxticket")).toBe("CU");
    expect(resolveSlackRoute(channels, "noxfeed_posts")).toBe("CP");
    expect(resolveSlackRoute(channels, "noxfeed_release_notes")).toBe("CR");
    expect(resolveSlackRoute(channels, "noxfeed_daily_summary")).toBe("CD");
  });

  it("falls back independently for every service", () => {
    const channels = { fallbackChannelId: "C0" };
    expect(resolveSlackRoute(channels, "noxcue", "CS")).toBe("C0");
    expect(resolveSlackRoute(channels, "noxspot")).toBe("C0");
    expect(resolveSlackRoute(channels, "noxticket")).toBe("C0");
    expect(resolveSlackRoute(channels, "noxfeed_posts")).toBe("C0");
    expect(resolveSlackRoute(channels, "noxfeed_release_notes")).toBe("C0");
    expect(resolveSlackRoute(channels, "noxfeed_daily_summary")).toBe("");
  });

  it("resolves each service workspace independently from its channel", () => {
    const channels = {
      fallbackConnectionId: "conn-default",
      noxCueConnectionId: "conn-alerts",
      postsConnectionId: "conn-feed",
      dailySummaryConnectionId: "conn-summary",
    };
    expect(resolveSlackConnectionId(channels, "noxcue")).toBe("conn-alerts");
    expect(resolveSlackConnectionId(channels, "noxfeed_posts")).toBe("conn-feed");
    expect(resolveSlackConnectionId(channels, "noxfeed_daily_summary")).toBe("conn-summary");
    expect(resolveSlackConnectionId(channels, "noxticket")).toBe("conn-default");
    expect(resolveSlackConnectionId(channels, "noxspot", "conn-site")).toBe("conn-site");
  });
});

describe("postSlackMessage", () => {
  beforeEach(() => { globalThis.fetch = vi.fn(); });
  afterEach(() => vi.restoreAllMocks());

  it("POSTs to chat.postMessage with bearer auth + channel", async () => {
    globalThis.fetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true, ts: "1.2" }) });
    await postSlackMessage("xoxb-1", "C-123", { text: "hi", blocks: [] });
    const [url, init] = globalThis.fetch.mock.calls[0];
    expect(url).toBe("https://slack.com/api/chat.postMessage");
    expect(init.headers.Authorization).toBe("Bearer xoxb-1");
    const body = JSON.parse(init.body);
    expect(body.channel).toBe("C-123");
    expect(body.text).toBe("hi");
  });

  it("opens a modal with the interaction trigger", async () => {
    globalThis.fetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true, view: { id: "V1" } }) });
    await openSlackModal("xoxb-1", "trigger-1", { type: "modal", title: { type: "plain_text", text: "Release notes" }, blocks: [] });
    const [url, init] = globalThis.fetch.mock.calls[0];
    expect(url).toBe("https://slack.com/api/views.open");
    expect(JSON.parse(init.body)).toMatchObject({ trigger_id: "trigger-1", view: { type: "modal" } });
  });

  it("throws when Slack returns ok=false", async () => {
    globalThis.fetch.mockResolvedValue({ ok: true, json: async () => ({ ok: false, error: "channel_not_found" }) });
    await expect(postSlackMessage("xoxb-1", "C-bad", {})).rejects.toThrow(/channel_not_found/);
  });
});

describe("listSlackChannels", () => {
  beforeEach(() => { globalThis.fetch = vi.fn(); });
  afterEach(() => vi.restoreAllMocks());

  it("returns sorted channels + handles pagination", async () => {
    globalThis.fetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({
        ok: true,
        channels: [{ id: "C2", name: "beta", is_private: false }],
        response_metadata: { next_cursor: "cur1" },
      })})
      .mockResolvedValueOnce({ ok: true, json: async () => ({
        ok: true,
        channels: [{ id: "C1", name: "alpha", is_private: true }],
        response_metadata: { next_cursor: "" },
      })});
    const result = await listSlackChannels("xoxb-1");
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("alpha");
    expect(result[1].name).toBe("beta");
    expect(result[0].is_private).toBe(true);
  });
});
