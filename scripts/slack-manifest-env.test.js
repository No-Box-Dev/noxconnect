import { describe, expect, it } from "vitest";
import { slackManifestForEnvironment, STAGING_SLACK_BASE_URL } from "./slack-manifest-env.mjs";

const manifest = {
  display_information: { name: "NoxConnect", description: "Production" },
  features: { bot_user: { display_name: "NoxConnect" }, unfurl_domains: ["app.noxhere.com"] },
  oauth_config: { redirect_urls: ["https://app.noxhere.com/api/slack/oauth/callback"] },
  settings: {
    event_subscriptions: { request_url: "https://app.noxhere.com/api/slack/events" },
    interactivity: { request_url: "https://app.noxhere.com/api/slack/interactions" },
  },
};

describe("Slack staging manifest", () => {
  it("rewrites every public endpoint without mutating production", () => {
    const staging = slackManifestForEnvironment(manifest, "staging");
    expect(staging.display_information.name).toBe("NoxConnect Staging");
    expect(staging.oauth_config.redirect_urls).toEqual([`${STAGING_SLACK_BASE_URL}/api/slack/oauth/callback`]);
    expect(staging.settings.event_subscriptions.request_url).toBe(`${STAGING_SLACK_BASE_URL}/api/slack/events`);
    expect(staging.settings.interactivity.request_url).toBe(`${STAGING_SLACK_BASE_URL}/api/slack/interactions`);
    expect(manifest.display_information.name).toBe("NoxConnect");
  });

  it("rejects unknown environments", () => {
    expect(() => slackManifestForEnvironment(manifest, "preview")).toThrow(/production or staging/);
  });
});
