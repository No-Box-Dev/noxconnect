const TEST_LABEL = /(?:^|[-_.])(staging|stage|sandbox|acceptance|test|cert)(?:$|[-_.])/i;

export const WRITE_CONFIRMATION = "write-to-isolated-nox-staging";

export function acceptanceHostname(hostname, service) {
  const host = hostname.toLowerCase();
  if (service === "noxhere") {
    return host === "app.noxhere.com"
      || host === "staging.noxhere.com"
      || /^noxhere-staging\.[a-z0-9-]+\.workers\.dev$/.test(host);
  }
  return host === "api.noxspot.dev"
    || /^noxspot-api-staging\.[a-z0-9-]+\.workers\.dev$/.test(host);
}

export function hasTestLabel(value) {
  return TEST_LABEL.test(String(value ?? ""));
}

export function validateSafety(config, { writes = false } = {}) {
  const errors = [];
  let base;
  let spot;
  let origin;
  try { base = new URL(config.baseUrl); } catch { errors.push("NOX_ACCEPTANCE_BASE_URL must be a valid URL"); }
  try { spot = new URL(config.noxspotUrl); } catch { errors.push("NOX_ACCEPTANCE_NOXSPOT_URL must be a valid URL"); }
  try { origin = new URL(config.noxspotOrigin); } catch { errors.push("NOX_ACCEPTANCE_NOXSPOT_ORIGIN must be a valid URL"); }

  if (base && (base.protocol !== "https:" || !acceptanceHostname(base.hostname, "noxhere"))) {
    errors.push("NOX_ACCEPTANCE_BASE_URL must be an allowlisted NoxHere host");
  }
  if (spot && (spot.protocol !== "https:" || !acceptanceHostname(spot.hostname, "noxspot"))) {
    errors.push("NOX_ACCEPTANCE_NOXSPOT_URL must be an allowlisted NoxSpot host");
  }
  if (origin && (origin.protocol !== "https:" || !TEST_LABEL.test(origin.hostname))) {
    errors.push("NOX_ACCEPTANCE_NOXSPOT_ORIGIN must contain an explicit staging/sandbox/test label");
  }
  if (!config.org?.trim()) errors.push("NOX_ACCEPTANCE_ORG is required");
  if (!TEST_LABEL.test(config.repo)) errors.push("NOX_ACCEPTANCE_REPO must be an explicitly named staging/sandbox/test repository");
  if (!config.slackConnectionId?.trim()) errors.push("NOX_ACCEPTANCE_SLACK_CONNECTION_ID is required");
  if (!/^[CG][A-Z0-9]{5,20}$/.test(config.slackChannelId ?? "")) errors.push("NOX_ACCEPTANCE_SLACK_CHANNEL_ID must be a Slack channel ID");
  if (!config.projectId) errors.push("NOX_ACCEPTANCE_PROJECT_ID is required");
  if (!config.accessToken?.startsWith("nox_at_")) errors.push("NOX_ACCEPTANCE_ACCESS_TOKEN must be a short-lived NoxHere native access token");
  if (!config.noxcueSourceId) errors.push("NOX_ACCEPTANCE_NOXCUE_SOURCE_ID is required");
  if (!config.noxcueIngestKey) errors.push("NOX_ACCEPTANCE_NOXCUE_INGEST_KEY is required");
  if (!config.noxspotSiteId) errors.push("NOX_ACCEPTANCE_NOXSPOT_SITE_ID is required");
  if (writes && config.confirm !== WRITE_CONFIRMATION) {
    errors.push(`Set NOX_ACCEPTANCE_CONFIRM=${WRITE_CONFIRMATION} to enable provider writes`);
  }
  return errors;
}

export function marker(runId) {
  return `[nox-acceptance:${runId}]`;
}

export function findIssue(items, titleMarker) {
  return (items ?? []).find((item) => !item.pull_request && String(item.title ?? "").includes(titleMarker)) ?? null;
}

export function findRelease(events, repo, prNumber, titleMarker) {
  return (events ?? []).find((event) => event.repo === repo
    && Number(event.pr?.number) === Number(prNumber)
    && String(event.pr?.title ?? "").includes(titleMarker)) ?? null;
}

export function findCueEvent(events, titleMarker) {
  return (events ?? []).find((event) => String(event.title ?? event.event?.title ?? "").includes(titleMarker)) ?? null;
}
