import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../github-app.js", () => ({
  getInstallationIdForOrg: vi.fn(async () => 42),
  getInstallationToken: vi.fn(async () => "token"),
}));
vi.mock("../github-sync.js", () => ({ upsertIssue: vi.fn(async () => undefined) }));
vi.mock("../delivery-outbox.js", () => ({
  queueOutboxDelivery: vi.fn(async () => true),
  stageSlackDelivery: vi.fn(async () => ({ id: "delivery-1", status: "pending" })),
}));
vi.mock("../noxspot-response.js", () => ({
  getNoxSpotIssueResponse: vi.fn(async (_env, capture) => {
    const marker = `<!-- noxspot:${capture.captureId} -->`;
    const reporter = capture.reporterGithubLogin
      ? `\n- **Reporter:** @${capture.reporterGithubLogin}`
      : capture.reporter ? `\n- **Reporter:** ${capture.reporter}` : "";
    const typeLabel = capture.issueType === "error" ? "error"
      : capture.issueType === "feature" ? "enhancement"
        : capture.issueType === "feedback" ? "feedback" : "bug";
    return {
      contract: "noxspot.response",
      version: 1,
      idempotencyMarker: marker,
      issue: {
        title: capture.title,
        body: `${capture.title}${reporter}\n\n${marker}`,
        labels: [
          { name: "noxspot", color: "FE795D", description: "Captured with NoxSpot" },
          { name: typeLabel, color: "D73A4A", description: "Capture type" },
        ],
      },
    };
  }),
  getNoxSpotSlackResponse: vi.fn(async (_env, capture, issue) => ({
    contract: "noxspot.response",
    version: 1,
    message: {
      text: `New NoxSpot issue: ${capture.title}`,
      blocks: [
        { type: "section", fields: [{ type: "mrkdwn", text: `*Page*\n${capture.metadata?.url}` }] },
        { type: "actions", elements: [
          { type: "button", text: { type: "plain_text", text: "Open reported page" }, url: capture.metadata?.url },
          { type: "button", text: { type: "plain_text", text: "Open GitHub issue" }, url: issue.html_url },
        ] },
      ],
    },
  })),
}));
vi.mock("../slack.js", () => ({
  resolveSlackChannels: vi.fn(async () => ({
    fallbackChannelId: "", noxCueChannelId: "", noxFeedChannelId: "", noxTicketChannelId: "",
  })),
  resolveSlackRoute: vi.fn((channels, service, siteChannelId) => {
    if (service === "noxcue") return channels.noxCueChannelId || channels.fallbackChannelId || "";
    return siteChannelId || channels.fallbackChannelId || "";
  }),
  resolveSlackConnectionId: vi.fn((channels, service, siteConnectionId) => {
    if (service === "noxspot") return siteConnectionId || channels.fallbackConnectionId || "";
    if (service === "noxcue") return channels.noxCueConnectionId || channels.fallbackConnectionId || "";
    return channels.fallbackConnectionId || "";
  }),
}));

import { createNoxSpotGitHubIssue } from "../noxspot.js";
import { upsertIssue } from "../github-sync.js";
import { queueOutboxDelivery, stageSlackDelivery } from "../delivery-outbox.js";
import { resolveSlackChannels } from "../slack.js";

function db(site = {}) {
  const calls = [];
  const configuredSite = {
    site_name: "Website",
    repo: "web",
    project_id: "p1",
    slack_channel_id: null,
    slack_connection_id: null,
    owner_id: "acme",
    ...site,
  };
  return {
    _calls: calls,
    async batch(statements) { return Promise.all(statements.map((statement) => statement.run())); },
    prepare(sql) {
      const statement = {
        bind(...binds) { statement.binds = binds; return statement; },
        async first() { return sql.includes("FROM spot_sites site") ? configuredSite : null; },
        async run() { calls.push({ sql, binds: statement.binds }); return { success: true }; },
      };
      return statement;
    },
  };
}

const capture = {
  type: "spot_create_github_issue",
  captureId: "cap-1",
  deliveryId: "noxspot:cap-1",
  orgId: 7,
  ownerId: "acme",
  projectId: "p1",
  repo: "web",
  siteId: "site-1",
  siteName: "Website",
  issueType: "bug",
  title: "Checkout is broken",
  description: "The submit button does nothing.",
  screenshotUrl: "https://cdn.example/shot.png",
  reporter: "Ada",
  metadata: { url: "https://app.example.com/checkout?cart=1", browser: "Chrome" },
};

describe("createNoxSpotGitHubIssue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveSlackChannels).mockResolvedValue({
      fallbackChannelId: "", noxCueChannelId: "", noxFeedChannelId: "", noxTicketChannelId: "",
    });
  });

  it("rejects unknown explicit capture contract versions", async () => {
    await expect(createNoxSpotGitHubIssue({ DB: db() }, { ...capture, version: 2 }))
      .rejects.toThrow("Unsupported NoxSpot capture version: 2");
  });

  it("creates one labeled GitHub issue, mirrors it, and emits the feed event", async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          number: 12, title: capture.title, state: "open", body: "body",
          user: { login: "noxspot", avatar_url: null }, assignees: [], labels: [{ name: "noxspot" }],
          created_at: "2026-08-14T00:00:00Z", updated_at: "2026-08-14T00:00:00Z",
          html_url: "https://github.com/acme/web/issues/12",
        }),
      });
    const database = db();
    const result = await createNoxSpotGitHubIssue({ DB: database }, capture);

    expect(result).toEqual({ number: 12, url: "https://github.com/acme/web/issues/12" });
    expect(upsertIssue).toHaveBeenCalledWith(database, 7, "web", expect.objectContaining({ number: 12 }));
    const createCall = globalThis.fetch.mock.calls.find(([, init]) => init?.method === "POST" && String(init.body).includes("Checkout is broken"));
    expect(JSON.parse(createCall[1].body)).toMatchObject({ labels: ["noxspot", "bug"] });
    const eventCall = database._calls.find((call) => call.sql.includes("INSERT INTO events"));
    expect(eventCall.sql).toContain("INSERT INTO events");
    expect(JSON.parse(eventCall.binds[6])).toMatchObject({
      githubIssueNumber: 12,
      githubIssueUrl: "https://github.com/acme/web/issues/12",
      siteId: "site-1",
      description: "The submit button does nothing.",
      reporter: "Ada",
      screenshotUrl: "https://cdn.example/shot.png",
    });
  });

  it("reuses an existing issue with the capture marker on a retry", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => [{
        number: 12, title: capture.title, body: "<!-- noxspot:cap-1 -->",
        state: "open", user: null, assignees: [], labels: [],
        created_at: "x", updated_at: "x", html_url: "https://github.com/acme/web/issues/12",
      }],
    });
    await createNoxSpotGitHubIssue({ DB: db() }, capture);
    expect(globalThis.fetch).toHaveBeenCalledOnce();
  });

  it("turns a tenant member selected as reporter into a GitHub mention", async () => {
    const database = db();
    const originalPrepare = database.prepare.bind(database);
    database.prepare = (sql) => {
      const statement = originalPrepare(sql);
      if (sql.includes("FROM members")) statement.first = async () => ({ login: "Ada-Lovelace" });
      return statement;
    };
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          number: 13, title: capture.title, state: "open", body: "body",
          user: null, assignees: [], labels: [], created_at: "x", updated_at: "x",
          html_url: "https://github.com/acme/web/issues/13",
        }),
      });

    await createNoxSpotGitHubIssue({ DB: database }, { ...capture, reporter: "@ada-lovelace" });

    const createCall = globalThis.fetch.mock.calls.find(([, init]) => init?.method === "POST" && String(init.body).includes("Checkout is broken"));
    expect(JSON.parse(createCall[1].body).body).toContain("**Reporter:** @Ada-Lovelace");
    const eventCall = database._calls.find((call) => call.sql.includes("INSERT INTO events"));
    expect(eventCall.binds[1]).toBe("Ada-Lovelace");
  });

  it("stages Slack separately after GitHub succeeds", async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          number: 14, title: capture.title, state: "open", body: "body",
          user: null, assignees: [], labels: [], created_at: "x", updated_at: "x",
          html_url: "https://github.com/acme/web/issues/14",
        }),
      });
    const database = db({ slack_channel_id: "C123", slack_connection_id: "conn-2" });
    await createNoxSpotGitHubIssue(
      { DB: database, TASK_QUEUE: { send: vi.fn() } },
      { ...capture, ownerId: "stale-owner", repo: "stale-repo", slackChannelId: "C-STALE", slackConnectionId: "conn-stale" },
    );
    expect(stageSlackDelivery).toHaveBeenCalledWith(database, expect.objectContaining({
      source: "noxspot", sourceId: "cap-1", connectionId: "conn-2", channelId: "C123",
    }));
    const stagedMessage = vi.mocked(stageSlackDelivery).mock.calls.at(-1)[1].payload.message;
    expect(stagedMessage.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "section",
        fields: expect.arrayContaining([
          expect.objectContaining({ text: expect.stringContaining("https://app.example.com/checkout?cart=1") }),
        ]),
      }),
      expect.objectContaining({
        type: "actions",
        elements: expect.arrayContaining([
          expect.objectContaining({ text: expect.objectContaining({ text: "Open reported page" }), url: "https://app.example.com/checkout?cart=1" }),
        ]),
      }),
    ]));
    expect(globalThis.fetch.mock.calls.some(([url]) => String(url).includes("/repos/acme/web/"))).toBe(true);
    expect(globalThis.fetch.mock.calls.some(([url]) => String(url).includes("stale-owner"))).toBe(false);
    expect(queueOutboxDelivery).toHaveBeenCalledWith(expect.objectContaining({ DB: database }), "delivery-1", "acme");
  });

  it("keeps automatic errors on the configured NoxSpot site channel", async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          number: 15, title: capture.title, state: "open", body: "body",
          user: null, assignees: [], labels: [], created_at: "x", updated_at: "x",
          html_url: "https://github.com/acme/web/issues/15",
        }),
      });
    vi.mocked(resolveSlackChannels).mockResolvedValue({
      fallbackChannelId: "C-FALLBACK", noxCueChannelId: "C-CUE",
      noxFeedChannelId: "", noxTicketChannelId: "",
    });

    await createNoxSpotGitHubIssue(
      { DB: db({ slack_channel_id: "C-SPOT" }), TASK_QUEUE: { send: vi.fn() } },
      { ...capture, issueType: "error", slackChannelId: "C-SPOT" },
    );

    expect(stageSlackDelivery).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      source: "noxspot", channelId: "C-SPOT",
    }));
  });

  it("uses the organization fallback when a NoxSpot site has no channel", async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          number: 16, title: capture.title, state: "open", body: "body",
          user: null, assignees: [], labels: [], created_at: "x", updated_at: "x",
          html_url: "https://github.com/acme/web/issues/16",
        }),
      });
    vi.mocked(resolveSlackChannels).mockResolvedValue({
      fallbackChannelId: "C-FALLBACK", noxCueChannelId: "",
      noxFeedChannelId: "", noxTicketChannelId: "",
    });

    await createNoxSpotGitHubIssue(
      { DB: db(), TASK_QUEUE: { send: vi.fn() } },
      { ...capture, slackChannelId: null },
    );

    expect(stageSlackDelivery).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      source: "noxspot", channelId: "C-FALLBACK",
    }));
  });
});
