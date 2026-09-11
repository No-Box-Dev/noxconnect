const STAGING_LABEL = /(?:^|[-_.])(staging|stage|sandbox|acceptance|test|cert)(?:$|[-_.])/i;

export const WRITE_CONFIRMATION = "write-to-isolated-nox-staging";

export function stagingHostname(hostname, service) {
  const host = hostname.toLowerCase();
  if (service === "noxhere") {
    return host === "staging.noxhere.com"
      || /^noxhere-staging\.[a-z0-9-]+\.workers\.dev$/.test(host);
  }
  return /^noxspot-api-staging\.[a-z0-9-]+\.workers\.dev$/.test(host);
}

export function validateSafety(config, { writes = false } = {}) {
  const errors = [];
  let base;
  let spot;
  let origin;
  try { base = new URL(config.baseUrl); } catch { errors.push("NOX_ACCEPTANCE_BASE_URL must be a valid URL"); }
  try { spot = new URL(config.noxspotUrl); } catch { errors.push("NOX_ACCEPTANCE_NOXSPOT_URL must be a valid URL"); }
  try { origin = new URL(config.noxspotOrigin); } catch { errors.push("NOX_ACCEPTANCE_NOXSPOT_ORIGIN must be a valid URL"); }

  if (base && (base.protocol !== "https:" || !stagingHostname(base.hostname, "noxhere"))) {
    errors.push("NOX_ACCEPTANCE_BASE_URL must be the dedicated NoxHere staging host");
  }
  if (spot && (spot.protocol !== "https:" || !stagingHostname(spot.hostname, "noxspot"))) {
    errors.push("NOX_ACCEPTANCE_NOXSPOT_URL must be the dedicated NoxSpot staging Worker");
  }
  if (origin && (origin.protocol !== "https:" || !STAGING_LABEL.test(origin.hostname))) {
    errors.push("NOX_ACCEPTANCE_NOXSPOT_ORIGIN must contain an explicit staging/sandbox/test label");
  }
  if (!STAGING_LABEL.test(config.org)) errors.push("NOX_ACCEPTANCE_ORG must be an explicitly named staging/sandbox/test organization");
  if (!STAGING_LABEL.test(config.repo)) errors.push("NOX_ACCEPTANCE_REPO must be an explicitly named staging/sandbox/test repository");
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
