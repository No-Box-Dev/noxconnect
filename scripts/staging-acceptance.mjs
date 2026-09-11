#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { findCueEvent, findIssue, findRelease, hasTestLabel, marker, validateSafety } from "./staging-acceptance-lib.mjs";

const preflightOnly = process.argv.includes("--preflight");
const runId = `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
const runMarker = marker(runId);
const markers = {
  ticket: `${runMarker} noxticket`,
  feed: `${runMarker} noxfeed`,
  cue: `${runMarker} noxcue`,
  spot: `${runMarker} noxspot`,
};
const config = {
  baseUrl: process.env.NOX_ACCEPTANCE_BASE_URL ?? "",
  org: process.env.NOX_ACCEPTANCE_ORG ?? "",
  projectId: process.env.NOX_ACCEPTANCE_PROJECT_ID ?? "",
  repo: process.env.NOX_ACCEPTANCE_REPO ?? "",
  slackConnectionId: process.env.NOX_ACCEPTANCE_SLACK_CONNECTION_ID ?? "",
  slackChannelId: process.env.NOX_ACCEPTANCE_SLACK_CHANNEL_ID ?? "",
  accessToken: process.env.NOX_ACCEPTANCE_ACCESS_TOKEN ?? "",
  noxspotUrl: process.env.NOX_ACCEPTANCE_NOXSPOT_URL ?? "",
  noxspotOrigin: process.env.NOX_ACCEPTANCE_NOXSPOT_ORIGIN ?? "",
  noxspotSiteId: process.env.NOX_ACCEPTANCE_NOXSPOT_SITE_ID ?? "",
  noxcueSourceId: process.env.NOX_ACCEPTANCE_NOXCUE_SOURCE_ID ?? "",
  noxcueIngestKey: process.env.NOX_ACCEPTANCE_NOXCUE_INGEST_KEY ?? "",
  confirm: process.env.NOX_ACCEPTANCE_CONFIRM ?? "",
};

const safetyErrors = validateSafety(config, { writes: !preflightOnly });
if (safetyErrors.length) fail(`Safety check failed:\n- ${safetyErrors.join("\n- ")}`);

const baseUrl = new URL(config.baseUrl);
const noxspotUrl = new URL(config.noxspotUrl);
const checks = [];
let ticketIssue = null;
let cueIssue = null;
let spotIssue = null;

function fail(message) { throw new Error(message); }
function pass(name, detail = "") {
  checks.push(name);
  process.stdout.write(`PASS ${name}${detail ? ` — ${detail}` : ""}\n`);
}

async function request(name, path, init = {}, expected = [200]) {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${config.accessToken}`);
  headers.set("X-Org", config.org);
  headers.set("Accept", "application/json");
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(new URL(path, baseUrl), { ...init, headers });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!expected.includes(response.status)) {
    fail(`${name}: expected ${expected.join("/")}, received ${response.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
  }
  pass(name, String(response.status));
  return { response, body };
}

function gh(name, method, path, fields = {}) {
  const args = ["api", "--method", method, path];
  for (const [key, value] of Object.entries(fields)) args.push("-f", `${key}=${value}`);
  const result = spawnSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) fail(`${name}: GitHub CLI failed (${result.stderr.trim() || `exit ${result.status}`})`);
  let body = null;
  try { body = result.stdout ? JSON.parse(result.stdout) : null; } catch { body = result.stdout; }
  return body;
}

async function poll(name, load, accept, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    latest = await load();
    const accepted = accept(latest);
    if (accepted) { pass(name); return accepted; }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  fail(`${name}: timed out after ${Math.round(timeoutMs / 1000)}s; last response ${JSON.stringify(latest)}`);
}

function githubIssues() {
  return gh("list acceptance issues", "GET", `repos/${config.org}/${config.repo}/issues`, { state: "all", per_page: "100" });
}

function closeGithubIssue(issue) {
  if (!issue?.number) return;
  gh(`close GitHub issue #${issue.number}`, "PATCH", `repos/${config.org}/${config.repo}/issues/${issue.number}`, { state: "closed" });
}

async function preflight() {
  const health = await fetch(new URL("/__noxhere/health", baseUrl));
  const healthBody = await health.json().catch(() => null);
  if (health.status !== 200 || healthBody?.service !== "noxhere" || healthBody?.plane !== "public-platform") {
    fail(`NoxHere staging health failed: ${health.status}`);
  }
  pass("NoxHere staging gateway health", "200");

  await request("NoxConnect staging readiness", "/api/health/ready");
  const catalog = (await request("service discovery", "/api/v1/services")).body;
  for (const id of ["noxconnect", "noxticket", "noxfeed", "noxspot", "noxcue"]) {
    const service = catalog?.services?.find((candidate) => candidate.id === id);
    if (!service) fail(`service discovery: ${id} is missing`);
    if (service.enabled === false) fail(`service discovery: ${id} is disabled`);
    if (id !== "noxconnect" && service.runtime?.state !== "ready") {
      fail(`service discovery: ${id} runtime is ${service.runtime?.state ?? "unknown"}`);
    }
  }
  pass("all product service bindings are ready");

  const projects = (await request("project discovery", "/api/v1/projects")).body;
  const projectItems = Array.isArray(projects) ? projects : projects?.projects;
  const project = projectItems?.find((item) => item.id === config.projectId && item.repo === config.repo);
  if (!project) fail(`project discovery: ${config.projectId}/${config.repo} is not enabled`);
  pass("staging project is enabled", config.projectId);

  const ticketConfig = (await request("NoxTicket staging config", "/api/v1/services/noxticket/config")).body?.config;
  if (ticketConfig?.featureRepository !== config.repo) fail("NoxTicket feature repository is not the allowlisted staging repository");
  const feedConfig = (await request("NoxFeed staging config", "/api/v1/services/noxfeed/config")).body?.config;
  if (feedConfig?.projectScope && feedConfig.projectScope !== config.projectId) fail("NoxFeed is scoped to a different project");

  const repo = gh("read staging repository", "GET", `repos/${config.org}/${config.repo}`);
  if (repo?.owner?.login?.toLowerCase() !== config.org.toLowerCase() || repo?.name !== config.repo) {
    fail("GitHub staging repository identity does not match the allowlist");
  }
  if (!repo.private || repo.archived) {
    fail("GitHub acceptance repository must be private and active");
  }
  pass("GitHub acceptance repository is reachable", repo.full_name);

  const slack = (await request(
    "Slack acceptance channel discovery",
    `/api/v1/slack/channels?connectionId=${encodeURIComponent(config.slackConnectionId)}`,
  )).body;
  const channel = slack?.channels?.find((item) => item.id === config.slackChannelId);
  if (slack?.connectionId !== config.slackConnectionId || !channel || !hasTestLabel(channel.name)) {
    fail("Slack acceptance destination must be an explicitly test-labelled channel on the selected connection");
  }
  pass("Slack acceptance destination is isolated", `#${channel.name}`);

  const spotConfigResponse = await fetch(new URL(`/api/spots/public/v1/sites/${encodeURIComponent(config.noxspotSiteId)}/config`, noxspotUrl), {
    headers: { Origin: config.noxspotOrigin, Accept: "application/json" },
  });
  if (!spotConfigResponse.ok) fail(`NoxSpot site preflight failed: ${spotConfigResponse.status} ${await spotConfigResponse.text()}`);
  pass("NoxSpot staging site accepts the staging origin", String(spotConfigResponse.status));
  const spotSites = (await request("NoxSpot site discovery", "/api/v1/spots/sites")).body?.sites;
  const spotSite = spotSites?.find((item) => item.id === config.noxspotSiteId && item.projectId === config.projectId && item.repo === config.repo);
  if (!spotSite
    || spotSite.slackConnectionId !== config.slackConnectionId
    || spotSite.slackEffectiveChannelId !== config.slackChannelId) {
    fail("NoxSpot staging site is not project-scoped to the acceptance Slack channel");
  }

  const sources = (await request("NoxCue source discovery", "/api/v1/cues/sources")).body?.sources;
  const source = sources?.find((item) => item.id === config.noxcueSourceId && item.projectId === config.projectId);
  if (!source || !source.enabled || source.environment !== "staging") fail("NoxCue staging source is missing, disabled, or not scoped to staging");
  if (source.effectiveAlertSlackChannelId !== config.slackChannelId
    || source.effectiveAlertSlackConnectionId !== config.slackConnectionId) {
    fail("NoxCue staging source is not routed to the acceptance Slack destination");
  }
  pass("NoxCue staging source is enabled", config.noxcueSourceId);
  const incidentProjects = (await request("NoxCue GitHub incident policy", "/api/v1/cues/github-issues")).body?.projects;
  const incidentProject = incidentProjects?.find((item) => item.projectId === config.projectId && item.repo === config.repo);
  if (!incidentProject?.enabled || !incidentProject.environments?.includes("staging")) {
    fail("NoxCue GitHub incidents are not enabled for the staging project/environment");
  }
  pass("NoxCue staging GitHub incident policy is enabled");
}

async function slackAcceptance() {
  for (const kind of ["noxticket", "noxfeed_release_notes", "noxcue"]) {
    await request(`Slack provider write for ${kind}`, "/api/v1/slack/test", {
      method: "POST",
      body: JSON.stringify({
        connectionId: config.slackConnectionId,
        channelId: config.slackChannelId,
        kind,
      }),
    });
  }
}

async function noxTicketAcceptance() {
  const created = (await request("NoxTicket creates a GitHub-backed feature", "/api/v1/features", {
    method: "POST",
    headers: { "Idempotency-Key": `acceptance-ticket-${runId}` },
    body: JSON.stringify({ title: `Acceptance feature ${markers.ticket}`, status: "todo", backlog: true }),
  }, [201])).body;
  const number = Number(created?.number);
  if (!number || !String(created?.title ?? "").includes(markers.ticket)) fail("NoxTicket returned an invalid feature receipt");
  const issue = gh("verify NoxTicket GitHub issue", "GET", `repos/${config.org}/${config.repo}/issues/${number}`);
  if (!String(issue?.title ?? "").includes(markers.ticket)) fail("NoxTicket GitHub issue marker is missing");
  ticketIssue = issue;
  pass("NoxTicket GitHub provider receipt", `#${number}`);
}

async function noxFeedAcceptance() {
  const repository = gh("read NoxFeed staging repository", "GET", `repos/${config.org}/${config.repo}`);
  const base = repository.default_branch;
  const baseRef = gh("read NoxFeed base ref", "GET", `repos/${config.org}/${config.repo}/git/ref/heads/${base}`);
  const branch = `nox-acceptance/${runId}`;
  gh("create NoxFeed acceptance branch", "POST", `repos/${config.org}/${config.repo}/git/refs`, {
    ref: `refs/heads/${branch}`,
    sha: baseRef.object.sha,
  });
  gh("create NoxFeed acceptance commit", "PUT", `repos/${config.org}/${config.repo}/contents/.nox-acceptance/${runId}.md`, {
    message: `Acceptance fixture ${markers.feed}`,
    content: Buffer.from(`${markers.feed}\n`).toString("base64"),
    branch,
  });
  const pull = gh("create NoxFeed acceptance pull request", "POST", `repos/${config.org}/${config.repo}/pulls`, {
    title: `Acceptance release ${markers.feed}`,
    head: branch,
    base,
    body: `Automated staging-only provider acceptance. ${markers.feed}`,
  });
  const merged = gh("merge NoxFeed acceptance pull request", "PUT", `repos/${config.org}/${config.repo}/pulls/${pull.number}/merge`, {
    merge_method: "squash",
  });
  if (!merged?.merged) fail(`NoxFeed fixture PR #${pull.number} was not merged: ${merged?.message ?? "unknown reason"}`);
  pass("NoxFeed staging pull request merged", `#${pull.number}`);
  await poll("NoxFeed release note observed through the public API", async () => (
    await request("poll NoxFeed release notes", `/api/v1/feed?mode=release-notes&repo=${encodeURIComponent(config.repo)}&limit=50`)
  ).body, (body) => findRelease(body?.events, config.repo, pull.number, markers.feed));
}

async function noxCueAcceptance() {
  const response = await fetch(new URL("/api/v1/cues/public/events", baseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Nox-Ingest-Key": config.noxcueIngestKey,
      "Idempotency-Key": `acceptance-cue-${runId}`,
    },
    body: JSON.stringify({
      version: 1,
      type: "error.occurred",
      title: `Acceptance error ${markers.cue}`,
      message: "Staging-only NoxCue provider acceptance event.",
      idempotencyKey: `acceptance-cue-${runId}`,
      occurredAt: new Date().toISOString(),
      url: config.noxspotOrigin,
      data: { errorCode: "NOX_ACCEPTANCE", environment: "staging", component: "acceptance-suite", fatal: false, unhandled: false },
    }),
  });
  if (![200, 201, 202].includes(response.status)) fail(`NoxCue ingest failed: ${response.status} ${await response.text()}`);
  pass("NoxCue staging event accepted", String(response.status));
  await poll("NoxCue event and Slack receipt observed", async () => (
    await request("poll NoxCue events", `/api/v1/cues/events?sourceId=${encodeURIComponent(config.noxcueSourceId)}&limit=50`)
  ).body, (body) => {
    const event = findCueEvent(body?.events, markers.cue);
    return event?.deliveryStatus === "delivered" ? event : null;
  });
  cueIssue = await poll("NoxCue GitHub incident observed", async () => githubIssues(), (items) => findIssue(items, markers.cue));
}

async function noxSpotAcceptance() {
  const before = (await request("read NoxSpot delivery baseline", "/api/v1/spots/sites")).body?.sites
    ?.find((site) => site.id === config.noxspotSiteId)?.slackLastDeliveredAt ?? null;
  const response = await fetch(new URL("/api/spots/public/v1/reports", noxspotUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: config.noxspotOrigin,
      "Idempotency-Key": `acceptance-spot-${runId}`,
    },
    body: JSON.stringify({
      attemptId: `acceptance-spot-${runId}`,
      siteId: config.noxspotSiteId,
      title: `Acceptance feedback ${markers.spot}`,
      description: "Staging-only NoxSpot provider acceptance report.",
      type: "feedback",
      environment: "staging",
      metadata: { suite: "nox-staging-provider-acceptance", runId },
    }),
  });
  if (response.status !== 200) fail(`NoxSpot report failed: ${response.status} ${await response.text()}`);
  pass("NoxSpot staging report queued", "200");
  spotIssue = await poll("NoxSpot GitHub issue observed", async () => githubIssues(), (items) => findIssue(items, markers.spot));
  await poll("NoxSpot Slack delivery receipt observed", async () => (
    await request("poll NoxSpot site receipt", "/api/v1/spots/sites")
  ).body, (body) => {
    const site = body?.sites?.find((item) => item.id === config.noxspotSiteId);
    return site && site.slackHealth === "connected" && site.slackLastDeliveredAt && site.slackLastDeliveredAt !== before ? site : null;
  });
}

async function cleanup() {
  if (ticketIssue?.number) {
    await request("close NoxTicket acceptance feature", `/api/v1/features/${ticketIssue.number}`, { method: "DELETE" });
    ticketIssue = null;
  }
  closeGithubIssue(cueIssue);
  closeGithubIssue(spotIssue);
}

try {
  process.stdout.write(`Nox staging acceptance ${runMarker}\n`);
  await preflight();
  if (preflightOnly) {
    process.stdout.write(`\nPASS: ${checks.length} staging preflight checks completed; no provider writes were made.\n`);
  } else {
    await slackAcceptance();
    await noxTicketAcceptance();
    await noxFeedAcceptance();
    await noxCueAcceptance();
    await noxSpotAcceptance();
    await cleanup();
    process.stdout.write(`\nPASS: ${checks.length} staging checks completed, including real GitHub and Slack provider writes.\n`);
  }
} catch (error) {
  process.stderr.write(`\nFAIL: ${error instanceof Error ? error.message : String(error)}\n`);
  try { await cleanup(); } catch (cleanupError) {
    process.stderr.write(`Cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}\n`);
  }
  process.exitCode = 1;
}
