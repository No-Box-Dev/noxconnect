export const STAGING_SLACK_BASE_URL = "https://noxhere-staging.jasper-414.workers.dev";

export function slackManifestForEnvironment(manifest, environment = "production") {
  if (environment === "production") return structuredClone(manifest);
  if (environment !== "staging") throw new Error("SLACK_MANIFEST_ENV must be production or staging");
  const next = structuredClone(manifest);
  const host = new URL(STAGING_SLACK_BASE_URL).hostname;
  next.display_information.name = "NoxConnect Staging";
  next.display_information.description = "Isolated provider acceptance for the Nox service suite.";
  next.features.bot_user.display_name = "NoxConnect Staging";
  next.features.unfurl_domains = [host];
  next.oauth_config.redirect_urls = [`${STAGING_SLACK_BASE_URL}/api/slack/oauth/callback`];
  next.settings.event_subscriptions.request_url = `${STAGING_SLACK_BASE_URL}/api/slack/events`;
  next.settings.interactivity.request_url = `${STAGING_SLACK_BASE_URL}/api/slack/interactions`;
  return next;
}
