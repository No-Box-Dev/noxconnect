#!/usr/bin/env node

import { createHmac, randomBytes } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { encryptToken } from "../functions/lib/crypto.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const codebase = resolve(root, "..");
const noxCueDir = resolve(process.env.NOXCUE_DIR || join(codebase, "NoxAlert"));
const noxFeedDir = resolve(process.env.NOXFEED_SERVICE_DIR || join(codebase, "noxfeed-mac/service"));
const noxSpotDir = resolve(process.env.NOXSPOT_CAPTURE_DIR || join(root, "workers/noxspot-capture"));
const noxTicketDir = resolve(process.env.NOXTICKET_SERVICE_DIR || join(codebase, "noxticket-service"));
const capabilityDir = join(root, "workers/connection-capabilities");
const wrangler = join(root, "node_modules/.bin/wrangler");
const keepState = process.argv.includes("--keep-state");
const allowAuthSkip = process.argv.includes("--allow-auth-skip");
const org = process.env.NOXCONNECT_E2E_ORG || "No-Box-Dev";
const repo = process.env.NOXCONNECT_E2E_REPO || "noxconnect";
const projectId = `proj_${org}_${repo}`.toLowerCase();
const otherProjectId = `${projectId}_other`;
const otherRepo = `${repo}-other`;
const base = "http://127.0.0.1:8788";
const internalSecret = randomBytes(32).toString("base64url");
const stateRoot = mkdtempSync(join(tmpdir(), "noxconnect-local-e2e-"));
const persistence = join(stateRoot, "state");
const logsDir = join(stateRoot, "logs");
const rpcDir = join(stateRoot, "rpc-smoke");
const children = [];
const results = [];
let failed = false;
let stopping = false;

mkdirSync(persistence, { recursive: true });
mkdirSync(logsDir, { recursive: true });

function print(message) {
  process.stdout.write(`${message}\n`);
}

function checkPrerequisites() {
  const required = [
    [wrangler, "Run npm install in NoxConnect"],
    [join(root, "dist/index.html"), "Run npm run build in NoxConnect"],
    [join(noxCueDir, "wrangler.jsonc"), "Set NOXCUE_DIR to the NoxCue checkout"],
    [join(noxCueDir, "node_modules"), "Run npm ci in the NoxCue checkout"],
    [join(noxFeedDir, "wrangler.toml"), "Set NOXFEED_SERVICE_DIR to the NoxFeed service checkout"],
    [join(noxFeedDir, "node_modules"), "Run npm ci in the NoxFeed service checkout"],
    [join(noxSpotDir, "node_modules"), "Run npm ci in workers/noxspot-capture"],
    [join(noxTicketDir, "node_modules"), "Set NOXTICKET_SERVICE_DIR to the NoxTicket service checkout"],
  ];
  const missing = required.filter(([path]) => !existsSync(path));
  if (missing.length) {
    throw new Error(missing.map(([path, help]) => `Missing ${path}. ${help}.`).join("\n"));
  }
}

function run(label, command, args, options = {}) {
  print(`→ ${label}`);
  const result = spawnSync(command, args, {
    cwd: options.cwd || root,
    env: { ...process.env, ...options.env, CI: "1", NO_COLOR: "1" },
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const output = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
    throw new Error(`${label} failed (${result.status})${output ? `:\n${output}` : ""}`);
  }
  results.push(label);
  return (result.stdout || "").trim();
}

function start(name, cwd, args) {
  const logPath = join(logsDir, `${name}.log`);
  const log = createWriteStream(logPath, { flags: "a", mode: 0o600 });
  const child = spawn(wrangler, args, {
    cwd,
    env: { ...process.env, CI: "1", NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  children.push({ name, child, log, logPath });
  child.on("exit", (code, signal) => {
    if (!stopping && !failed && code !== null && code !== 0) {
      failed = true;
      print(`✗ ${name} exited early (${code ?? signal})`);
    }
  });
  return child;
}

async function waitFor(name, url, { timeoutMs = 45_000, expected = 200 } = {}) {
  const started = Date.now();
  let last = "not reachable";
  while (Date.now() - started < timeoutMs) {
    const proc = children.find((entry) => entry.name === name)?.child;
    if (proc?.exitCode !== null) break;
    try {
      const response = await fetch(url);
      if (response.status === expected) {
        results.push(`${name} is reachable`);
        print(`✓ ${name} is reachable`);
        return response;
      }
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`${name} did not become ready: ${last}`);
}

async function request(label, path, options = {}, expected = 200) {
  const { noxHereAuth, ...fetchOptions } = options;
  if (noxHereAuth) {
    const method = (fetchOptions.method || "GET").toUpperCase();
    const now = Math.floor(Date.now() / 1000);
    const assertion = {
      version: 1, issuer: "noxhere", audience: "noxconnect",
      issuedAt: now, expiresAt: now + 30, method, path, auth: noxHereAuth,
    };
    const payload = Buffer.from(JSON.stringify(assertion)).toString("base64url");
    const signature = createHmac("sha256", internalSecret).update(payload).digest("base64url");
    const headers = new Headers(fetchOptions.headers);
    headers.set("X-NoxHere-Internal-Assertion", payload);
    headers.set("X-NoxHere-Internal-Signature", signature);
    fetchOptions.headers = headers;
  }
  const response = await fetch(path.startsWith("http") ? path : `${base}${path}`, fetchOptions);
  const raw = await response.text();
  let body = raw;
  if ((response.headers.get("content-type") || "").includes("json")) {
    try { body = JSON.parse(raw); } catch { /* assertion below reports raw */ }
  }
  const statuses = Array.isArray(expected) ? expected : [expected];
  if (!statuses.includes(response.status)) {
    throw new Error(`${label}: expected HTTP ${statuses.join("/")}, got ${response.status}: ${raw.slice(0, 500)}`);
  }
  if (path.startsWith("/api/v1/")) {
    if (response.headers.get("cache-control") !== "no-store") {
      throw new Error(`${label}: canonical API response is missing Cache-Control: no-store`);
    }
    if (!response.headers.get("link")?.includes("/openapi.json")) {
      throw new Error(`${label}: canonical API response is missing the OpenAPI discovery link`);
    }
    if (response.status >= 400 && (body?.apiVersion !== 1 || typeof body?.error?.code !== "string")) {
      throw new Error(`${label}: canonical API error did not use the v1 coded envelope: ${raw.slice(0, 500)}`);
    }
  }
  results.push(label);
  print(`✓ ${label} (${response.status})`);
  return { response, body };
}

function signedOptions(auth, init = {}) {
  return {
    ...init,
    noxHereAuth: auth,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers || {}),
    },
  };
}

function tail(path, lines = 35) {
  try { return readFileSync(path, "utf8").split("\n").slice(-lines).join("\n"); }
  catch { return "(log unavailable)"; }
}

async function stopChildren() {
  stopping = true;
  for (const { child } of children) {
    if (child.exitCode === null) child.kill("SIGTERM");
  }
  await Promise.race([
    Promise.all(children.map(({ child }) => new Promise((resolveExit) => {
      if (child.exitCode !== null) resolveExit();
      else child.once("exit", resolveExit);
    }))),
    new Promise((resolveWait) => setTimeout(resolveWait, 5_000)),
  ]);
  for (const { child, log } of children) {
    if (child.exitCode === null) child.kill("SIGKILL");
    log.end();
  }
}

function makeRpcSmokeWorker() {
  mkdirSync(rpcDir, { recursive: true });
  writeFileSync(join(rpcDir, "wrangler.jsonc"), JSON.stringify({
    name: "noxconnect-local-rpc-smoke",
    main: "index.js",
    compatibility_date: "2026-09-09",
    services: [
      { binding: "NOXSPOT", service: "noxspot-api" },
      { binding: "NOXCUE", service: "noxcue" },
      { binding: "NOXFEED", service: "noxfeed-response" },
      { binding: "NOXTICKET", service: "noxticket" },
    ],
  }, null, 2), { mode: 0o600 });
  writeFileSync(join(rpcDir, "index.js"), `export default {
  async fetch(_request, env) {
    const [spot, cue, feed, ticket] = await Promise.all([
      env.NOXSPOT.describe(),
      env.NOXCUE.describe(),
      env.NOXFEED.describe(),
      env.NOXTICKET.describe(),
    ]);
    return Response.json({ spot, cue, feed, ticket });
  }
};\n`, { mode: 0o600 });
}

async function main() {
  print(`Local E2E state: ${stateRoot}`);
  checkPrerequisites();

  run("apply all NoxConnect migrations to a fresh local D1", wrangler, [
    "d1", "migrations", "apply", "noxconnect", "--local", "--persist-to", persistence,
  ]);
  const fixtureSql = [
    `INSERT INTO orgs (id, github_login) VALUES (910004, '${org.replaceAll("'", "''")}');`,
    `INSERT INTO installations (installation_id, owner_id, account_login, account_type, repos_json, installed_at, updated_at) VALUES (910004, '${org.replaceAll("'", "''")}', '${org.replaceAll("'", "''")}', 'Organization', '["${org.replaceAll('"', '\\"')}/${repo.replaceAll('"', '\\"')}"]', unixepoch(), unixepoch());`,
    `INSERT INTO projects (id, name, org, repo, owner_id) VALUES ('${projectId.replaceAll("'", "''")}', '${repo.replaceAll("'", "''")}', '${org.replaceAll("'", "''")}', '${repo.replaceAll("'", "''")}', '${org.replaceAll("'", "''")}');`,
    `INSERT INTO project_routing_settings (org_id, project_id, enabled) VALUES (910004, '${projectId.replaceAll("'", "''")}', 1);`,
    `INSERT INTO project_repositories (org_id, repo, project_id) VALUES (910004, '${repo.replaceAll("'", "''")}', '${projectId.replaceAll("'", "''")}');`,
    `INSERT INTO projects (id, name, org, repo, owner_id) VALUES ('${otherProjectId.replaceAll("'", "''")}', '${otherRepo.replaceAll("'", "''")}', '${org.replaceAll("'", "''")}', '${otherRepo.replaceAll("'", "''")}', '${org.replaceAll("'", "''")}');`,
    `INSERT INTO project_routing_settings (org_id, project_id, enabled) VALUES (910004, '${otherProjectId.replaceAll("'", "''")}', 1);`,
    `INSERT INTO project_repositories (org_id, repo, project_id) VALUES (910004, '${otherRepo.replaceAll("'", "''")}', '${otherProjectId.replaceAll("'", "''")}');`,
    `INSERT INTO events (delivery_id, source, type, project_id, org, repo, summary, technical_summary, payload_json, owner_id) VALUES ('local-feed-allowed', 'github', 'narrative', '${projectId.replaceAll("'", "''")}', '${org.replaceAll("'", "''")}', '${repo.replaceAll("'", "''")}', 'allowed project event', 'allowed', '{"trigger_type":"github:pr:merged","pr":{"number":1,"title":"Allowed","html_url":"https://example.test/allowed","author":{"login":"local"}}}', '${org.replaceAll("'", "''")}');`,
    `INSERT INTO events (delivery_id, source, type, project_id, org, repo, summary, technical_summary, payload_json, owner_id) VALUES ('local-feed-denied', 'github', 'narrative', '${otherProjectId.replaceAll("'", "''")}', '${org.replaceAll("'", "''")}', '${otherRepo.replaceAll("'", "''")}', 'other project event', 'denied', '{"trigger_type":"github:pr:merged","pr":{"number":2,"title":"Denied","html_url":"https://example.test/denied","author":{"login":"local"}}}', '${org.replaceAll("'", "''")}');`,
  ].join(" ");
  run("seed a credential-free local organization and project", wrangler, [
    "d1", "execute", "noxconnect", "--local", "--persist-to", persistence, "--command", fixtureSql,
  ]);

  const commonDev = ["--local", "--persist-to", persistence, "--log-level", "warn", "--show-interactive-dev-session=false"];
  start("capabilities", capabilityDir, ["dev", "--port", "8796", "--inspector-port", "9236", ...commonDev]);
  await waitFor("capabilities", "http://127.0.0.1:8796/", { expected: 404 });
  start("noxcue", noxCueDir, ["dev", "--port", "8792", "--inspector-port", "9232", ...commonDev]);
  await waitFor("noxcue", "http://127.0.0.1:8792/health");
  start("noxspot", noxSpotDir, ["dev", "--port", "8790", "--inspector-port", "9229", ...commonDev]);
  await waitFor("noxspot", "http://127.0.0.1:8790/health");
  start("noxfeed", noxFeedDir, ["dev", "--port", "8791", "--inspector-port", "9230", ...commonDev]);
  await waitFor("noxfeed", "http://127.0.0.1:8791/health");
  start("noxticket", noxTicketDir, ["dev", "--port", "8795", "--inspector-port", "9235", ...commonDev]);
  await waitFor("noxticket", "http://127.0.0.1:8795/health");

  start("cron", root, ["dev", "-c", "cron/wrangler.toml", "--port", "8794", "--inspector-port", "9234", ...commonDev]);
  makeRpcSmokeWorker();
  start("rpc", rpcDir, ["dev", "-c", "wrangler.jsonc", "--port", "8793", "--inspector-port", "9233", ...commonDev]);

  const encryptionKey = randomBytes(32).toString("hex");
  const webhookSecret = randomBytes(32).toString("hex");
  start("noxconnect", root, [
    "pages", "dev", "dist", "--port", "8788", "--inspector-port", "9231",
    "--persist-to", persistence, "--log-level", "warn", "--show-interactive-dev-session=false",
    "--binding", `ENCRYPTION_KEY=${encryptionKey}`,
    "--binding", `GITHUB_WEBHOOK_SECRET=${webhookSecret}`,
    "--binding", `NOXHERE_INTERNAL_SECRET=${internalSecret}`,
    "--service", "NOXSPOT_RESPONSE=noxspot-api",
    "--service", "NOXCUE_RESPONSE=noxcue",
    "--service", "NOXCUE_INGEST=noxcue",
    "--service", "NOXFEED_RESPONSE=noxfeed-response",
    "--service", "NOXTICKET_SERVICE=noxticket",
  ]);
  await waitFor("noxconnect", `${base}/developers`);
  await waitFor("rpc", "http://127.0.0.1:8793/");
  await waitFor("cron", "http://127.0.0.1:8794/", { expected: 404 });

  const docs = await request("developer documentation HTML", "/developers");
  if (!String(docs.body).includes("NoxConnect API")) throw new Error("Developer documentation is missing its title");
  await request("OpenAPI contract", "/openapi.json");
  await request("developer documentation JavaScript", "/developers.js");
  const rpc = await request("private RPC contracts for all product services", "http://127.0.0.1:8793/");
  for (const service of ["spot", "cue", "feed", "ticket"]) {
    if (rpc.body?.[service]?.contract !== "nox.service-manifest" || rpc.body[service].version !== 1) throw new Error(`Invalid ${service} RPC contract`);
  }

  await request("protected API rejects an anonymous caller", "/api/v1/services", {}, 401);
  const gh = spawnSync("gh", ["auth", "token"], { encoding: "utf8", env: process.env });
  const token = gh.status === 0 ? gh.stdout.trim() : "";
  if (!token) {
    if (!allowAuthSkip) throw new Error("GitHub CLI authentication is required. Run gh auth login, or pass --allow-auth-skip for public-only checks.");
    print("! Authenticated API checks skipped (--allow-auth-skip)");
    return;
  }

  const loginResult = spawnSync("gh", ["api", "user", "--jq", ".login"], { encoding: "utf8", env: process.env });
  const githubLogin = loginResult.status === 0 ? loginResult.stdout.trim() : "";
  if (!githubLogin) throw new Error("Could not resolve the authenticated GitHub login");
  const userIdResult = spawnSync("gh", ["api", "user", "--jq", ".id"], { encoding: "utf8", env: process.env });
  const githubUserId = Number(userIdResult.status === 0 ? userIdResult.stdout.trim() : "");
  if (!Number.isSafeInteger(githubUserId)) throw new Error("Could not resolve the authenticated GitHub user ID");
  const connectionId = `noxic_local_${randomBytes(8).toString("hex")}`;
  const encryptedGitHubToken = await encryptToken(token, encryptionKey);
  const authFixtureSql = [
    `INSERT OR IGNORE INTO org_admins (org_id, login, granted_by_login) VALUES (910004, '${githubLogin.replaceAll("'", "''")}', '${githubLogin.replaceAll("'", "''")}');`,
    `INSERT INTO identity_connections (id, github_user_id, github_login, encrypted_access_token) VALUES ('${connectionId}', ${githubUserId}, '${githubLogin.replaceAll("'", "''")}', '${encryptedGitHubToken}');`,
  ].join(" ");
  run("seed a connector identity without creating a NoxConnect login session", wrangler, [
    "d1", "execute", "noxconnect", "--local", "--persist-to", persistence, "--command", authFixtureSql,
  ]);

  const sessionAuth = {
    credentialType: "session", credentialId: "local-session", principalId: `github:${githubUserId}`,
    userLogin: githubLogin, userId: githubUserId, orgId: 910004, orgLogin: org,
    isAdmin: true, projectId: null, scopes: [], connectionId,
  };
  const projectAuth = {
    ...sessionAuth, credentialType: "api_token", credentialId: "local-project-token",
    projectId, scopes: ["services:read", "noxfeed:read", "noxspot:write", "noxcue:write"], connectionId: null,
  };
  await request("signed NoxHere session authenticates without exposing a provider bearer", "/api/v1/services", signedOptions(sessionAuth));
  await request("GitHub provider bearer is not a NoxConnect API credential", "/api/v1/services", { headers: { Authorization: `Bearer ${token}` } }, 401);
  await request("signed NoxHere session reads its organization role", "/api/v1/me", signedOptions(sessionAuth));
  await request("signed NoxHere session reads integration readiness", "/api/v1/integrations/status", signedOptions(sessionAuth));
  await request("signed NoxHere session reads bootstrap status", "/api/v1/bootstrap-status", signedOptions(sessionAuth));
  await request("signed NoxHere session reads detailed events", "/api/v1/events?limit=1", signedOptions(sessionAuth));
  await request("signed NoxHere session reads engineer counts", "/api/v1/engineer-stats", signedOptions(sessionAuth));
  await request("signed NoxHere session searches its organization", "/api/v1/search?q=allowed", signedOptions(sessionAuth));
  await request("signed NoxHere session reads members", "/api/v1/members", signedOptions(sessionAuth));
  await request("signed NoxHere session reads Slack health without receiving credentials", "/api/v1/slack/status", signedOptions(sessionAuth));
  await request("signed NoxHere admin reads its bound default prompt", "/api/v1/noxfeed/release-notes-prompt", signedOptions(sessionAuth));
  await request("project-scoped NoxHere credential reads the service catalog", "/api/v1/services", signedOptions(projectAuth));
  const scopedFeed = await request("project credential reads only its own feed", "/api/v1/feed", signedOptions(projectAuth));
  if (scopedFeed.body?.events?.length !== 1 || scopedFeed.body.events[0]?.summary !== "allowed project event") {
    throw new Error("Project token crossed its feed project boundary");
  }
  await request("project credential cannot select another project", "/api/v1/feed", signedOptions(projectAuth, { headers: { "X-Project-ID": otherProjectId } }), 404);
  await request("project credential cannot read organization-level configuration", "/api/v1/services/noxfeed/config", signedOptions(projectAuth), 403);
  const serviceSwitchConfig = await request("read service switches before disabled-service check", "/api/v1/services/noxconnect/config", signedOptions(sessionAuth));
  const disabledServiceConfig = await request("disable NoxSpot for the service gate check", "/api/v1/services/noxconnect/config", signedOptions(sessionAuth, {
    method: "PATCH",
    headers: { "If-Match": serviceSwitchConfig.response.headers.get("etag") },
    body: JSON.stringify({ enabledServices: { noxspot: false, noxfeed: false } }),
  }));
  const disabledService = await request("disabled service returns the standard project API error", "/api/spots/sites", signedOptions(projectAuth), 409);
  if (disabledService.body?.error !== "NoxSpot is not enabled. Enable it in NoxConnect before trying again.") {
    throw new Error("Disabled service response did not use the standard message");
  }
  const disabledV1Service = await request("disabled v1 service returns the coded enablement error", "/api/v1/feed", signedOptions(projectAuth), 409);
  if (disabledV1Service.body?.error?.code !== "service_not_enabled" || disabledV1Service.body.error.message !== "NoxFeed is not enabled. Enable it in NoxConnect before trying again.") {
    throw new Error("Disabled v1 service response did not use the standard error contract");
  }
  await request("disabled NoxFeed blocks its canonical issue API", "/api/v1/issues", signedOptions(projectAuth), 403);
  await request("restore NoxSpot after the service gate check", "/api/v1/services/noxconnect/config", signedOptions(sessionAuth, {
    method: "PATCH",
    headers: { "If-Match": disabledServiceConfig.response.headers.get("etag") },
    body: JSON.stringify({ enabledServices: { noxspot: true, noxfeed: true } }),
  }));
  await request("configure project-scoped NoxCue GitHub incident routing", "/api/v1/cues/github-issues", signedOptions(sessionAuth, {
    method: "PUT",
    body: JSON.stringify({
      projectId, enabled: false, environments: ["production", "staging"],
      commentOnRepeat: false, repeatIntervalMinutes: 360,
    }),
  }));
  const incidentSettings = await request("read NoxCue GitHub incident routing", "/api/v1/cues/github-issues", signedOptions(sessionAuth));
  if (!incidentSettings.body?.projects?.some((project) => project.projectId === projectId
      && project.environments?.includes("staging"))) {
    throw new Error("NoxCue GitHub incident settings were not persisted");
  }
  const ownSource = await request("project credential creates a source in its implicit project", "/api/v1/cues/sources", signedOptions(projectAuth, {
    method: "POST",
    body: JSON.stringify({ name: "Token project", enabled: true, timezone: "UTC", digestEnabled: false, digestTimeLocal: "00:30", allowedOrigins: [], healthEnabled: false, healthUrl: null, slackChannelId: null, slackConnectionId: null }),
  }), 201);
  if (ownSource.body?.projectId !== projectId) throw new Error("Token-created source was not assigned to the token project");
  const ownSite = await request("project credential creates a site in its implicit project", "/api/v1/spots/sites", signedOptions(projectAuth, {
    method: "POST", body: JSON.stringify({ name: "Token project", widgetMode: "development" }),
  }), 201);
  if (ownSite.body?.site?.projectId !== projectId) throw new Error("Token-created site was not assigned to the token project");
  const otherSource = await request("create another project's NoxCue source as a NoxHere admin", "/api/v1/cues/sources", signedOptions(sessionAuth, {
    method: "POST",
    body: JSON.stringify({ name: "Other project", projectId: otherProjectId, enabled: true, timezone: "UTC", digestEnabled: false, digestTimeLocal: "00:30", allowedOrigins: [], healthEnabled: false, healthUrl: null, slackChannelId: null, slackConnectionId: null }),
  }), 201);
  await request("project credential cannot read another project's source", `/api/v1/cues/sources/${otherSource.body.id}`, signedOptions(projectAuth), 404);
  await request("project credential cannot read another project's metrics", `/api/v1/cues/metrics?sourceId=${encodeURIComponent(otherSource.body.id)}&days=1`, signedOptions(projectAuth), 404);
  await request("project credential cannot create a source for another project", "/api/v1/cues/sources", signedOptions(projectAuth, {
    method: "POST",
    body: JSON.stringify({ name: "Cross-project source", projectId: otherProjectId, enabled: true, timezone: "UTC", digestEnabled: false, digestTimeLocal: "00:30", allowedOrigins: [], healthEnabled: false, healthUrl: null, slackChannelId: null, slackConnectionId: null }),
  }), 404);
  const scopedSources = await request("project credential lists only its own sources", "/api/v1/cues/sources", signedOptions(projectAuth));
  if (!scopedSources.body?.sources?.length || scopedSources.body.sources.some((source) => source.projectId !== projectId)) {
    throw new Error("NoxCue source collection crossed the token project boundary");
  }
  const otherSite = await request("create another project's NoxSpot site as a NoxHere admin", "/api/v1/spots/sites", signedOptions(sessionAuth, {
    method: "POST", body: JSON.stringify({ name: "Other project", projectId: otherProjectId, widgetMode: "development" }),
  }), 201);
  await request("project credential cannot change another project's site", `/api/v1/spots/sites/${otherSite.body.site.id}`, signedOptions(projectAuth, {
    method: "PATCH", body: JSON.stringify({ name: "Cross-project change" }),
  }), 404);
  await request("project credential cannot create a site for another project", "/api/v1/spots/sites", signedOptions(projectAuth, {
    method: "POST", body: JSON.stringify({ name: "Cross-project site", projectId: otherProjectId, widgetMode: "development" }),
  }), 404);
  const scopedSites = await request("project credential lists only its own sites", "/api/v1/spots/sites", signedOptions(projectAuth));
  if (!scopedSites.body?.sites?.length || scopedSites.body.sites.some((site) => site.projectId !== projectId)) {
    throw new Error("NoxSpot site collection crossed the token project boundary");
  }
  const catalog = await request("authenticated service catalog using a NoxHere session assertion", "/api/v1/services", signedOptions(sessionAuth));
  if (!Array.isArray(catalog.body?.services) || catalog.body.services.length !== 5) throw new Error("Expected all five service families");
  for (const service of ["noxconnect", "noxticket", "noxfeed", "noxspot", "noxcue"]) {
    await request(`${service} setup contract`, `/api/v1/services/${service}/setup`, signedOptions(sessionAuth));
    await request(`${service} health contract`, `/api/v1/services/${service}/health`, signedOptions(sessionAuth));
    await request(`${service} config contract`, `/api/v1/services/${service}/config`, signedOptions(sessionAuth));
  }

  const currentConfig = await request("read versioned config and ETag", "/api/v1/services/noxconnect/config", signedOptions(sessionAuth));
  const etag = currentConfig.response.headers.get("etag");
  if (!etag) throw new Error("Config response did not return ETag");
  await request("config write requires If-Match", "/api/v1/services/noxconnect/config", signedOptions(sessionAuth, {
    method: "PATCH", body: JSON.stringify({ newRepositoryPolicy: "exclude" }),
  }), 428);
  await request("stale config write is rejected", "/api/v1/services/noxconnect/config", signedOptions(sessionAuth, {
    method: "PATCH", headers: { "If-Match": '"stale"' }, body: JSON.stringify({ newRepositoryPolicy: "exclude" }),
  }), 412);
  const updated = await request("config compare-and-swap update", "/api/v1/services/noxconnect/config", signedOptions(sessionAuth, {
    method: "PATCH", headers: { "If-Match": etag }, body: JSON.stringify({ newRepositoryPolicy: "exclude" }),
  }));
  await request("restore config after compare-and-swap check", "/api/v1/services/noxconnect/config", signedOptions(sessionAuth, {
    method: "PATCH", headers: { "If-Match": updated.response.headers.get("etag") }, body: JSON.stringify({ newRepositoryPolicy: "include" }),
  }));

  const projects = await request("project discovery from local installation fixture", "/api/v1/projects", signedOptions(sessionAuth));
  if (!projects.body?.projects?.some((project) => project.id === projectId)) throw new Error("Fixture project was not returned");
  const legacyProjects = await request("compatibility project discovery remains available during migration", "/api/projects", signedOptions(sessionAuth));
  const canonicalProjectIds = projects.body.projects.map((project) => project.id).sort();
  const legacyProjectIds = legacyProjects.body?.projects?.map((project) => project.id).sort();
  if (JSON.stringify(canonicalProjectIds) !== JSON.stringify(legacyProjectIds)) {
    throw new Error("Canonical and legacy project discovery returned different resources");
  }

  const source = await request("create a NoxCue source through the control API", "/api/v1/cues/sources", signedOptions(sessionAuth, {
    method: "POST",
    body: JSON.stringify({ name: "Local E2E", projectId, enabled: true, timezone: "UTC", digestEnabled: false, digestTimeLocal: "00:30", allowedOrigins: [], healthEnabled: false, healthUrl: null, slackChannelId: null, slackConnectionId: null }),
  }), 201);
  const sourceId = source.body.id;
  const key = await request("create a one-time NoxCue ingest key", `/api/v1/cues/sources/${sourceId}/keys`, signedOptions(sessionAuth, {
    method: "POST", body: JSON.stringify({ name: "Local E2E", kind: "secret" }),
  }), 201);
  const keyId = key.body.key.id;
  const keyValue = key.body.key.value;
  const event = await request("ingest a real NoxCue event through the NoxConnect binding", "/api/v1/cues/public/events", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Nox-Ingest-Key": keyValue },
    body: JSON.stringify({ version: 1, type: "user.registered", userId: "local-e2e-user", idempotencyKey: "local-e2e-registration" }),
  }, 202);
  if (!event.body?.accepted || event.body?.stored !== true) throw new Error("NoxCue did not persist the event");
  const duplicate = await request("NoxCue ingestion is idempotent", "/api/v1/cues/public/events", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Nox-Ingest-Key": keyValue },
    body: JSON.stringify({ version: 1, type: "user.registered", userId: "local-e2e-user", idempotencyKey: "local-e2e-registration" }),
  }, 202);
  if (duplicate.body?.duplicate !== true) throw new Error("NoxCue duplicate was not detected");
  const metrics = await request("read persisted NoxCue metrics", `/api/v1/cues/metrics?sourceId=${encodeURIComponent(sourceId)}&days=1`, signedOptions(sessionAuth));
  if (!Array.isArray(metrics.body?.days)) throw new Error("NoxCue metrics response is malformed");
  await request("revoke the NoxCue ingest key", `/api/v1/cues/sources/${sourceId}/keys/${keyId}`, signedOptions(sessionAuth, { method: "DELETE" }));
  await request("revoked NoxCue key is rejected", "/api/v1/cues/public/events", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Nox-Ingest-Key": keyValue },
    body: JSON.stringify({ version: 1, type: "user.active", userId: "local-e2e-user" }),
  }, 401);

  const site = await request("create a NoxSpot site through the control API", "/api/v1/spots/sites", signedOptions(sessionAuth, {
    method: "POST", body: JSON.stringify({ name: "Local E2E", projectId, widgetMode: "development", autoErrorLogging: true }),
  }), 201);
  const siteId = site.body.site.id;
  const publicConfig = await request("read NoxSpot public widget config", `http://127.0.0.1:8790/api/spots/public/v1/sites/${siteId}/config`);
  if (publicConfig.body?.siteId !== siteId) throw new Error("NoxSpot config did not use the shared D1 state");
  const report = await request("queue a real NoxSpot public report", "http://127.0.0.1:8790/api/spots/public/v1/reports", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ siteId, title: "Local E2E feedback", description: "Disposable local queue smoke test" }),
  });
  if (!report.body?.queued) throw new Error("NoxSpot did not enqueue the report");

  const pingBody = JSON.stringify({ zen: "local e2e" });
  await request("reject an invalid GitHub webhook signature", "/api/webhook", {
    method: "POST", headers: { "Content-Type": "application/json", "X-GitHub-Event": "ping", "X-GitHub-Delivery": "local-e2e-bad", "X-Hub-Signature-256": `sha256=${"0".repeat(64)}` }, body: pingBody,
  }, 401);
  const signature = `sha256=${createHmac("sha256", webhookSecret).update(pingBody).digest("hex")}`;
  const ping = await request("accept a correctly signed GitHub webhook", "/api/webhook", {
    method: "POST", headers: { "Content-Type": "application/json", "X-GitHub-Event": "ping", "X-GitHub-Delivery": "local-e2e-good", "X-Hub-Signature-256": signature }, body: pingBody,
  });
  if (ping.body?.message !== "pong") throw new Error("Webhook ping did not return pong");

  print(`\nPASS: ${results.length} end-to-end checks completed.`);
  print("Provider delivery note: GitHub App installation calls, Slack delivery, and AI narration require disposable sandbox provider credentials and are intentionally not attempted with production credentials.");
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    failed = true;
    await stopChildren();
    process.exit(130);
  });
}

try {
  await main();
} catch (error) {
  failed = true;
  process.stderr.write(`\nFAIL: ${error instanceof Error ? error.message : String(error)}\n`);
  for (const { name, logPath } of children) {
    process.stderr.write(`\n--- ${name} (${logPath}) ---\n${tail(logPath)}\n`);
  }
  process.exitCode = 1;
} finally {
  await stopChildren();
  if (keepState || failed) {
    print(`Local state retained at ${stateRoot}`);
  } else {
    rmSync(stateRoot, { recursive: true, force: true });
    print(`Removed disposable local state ${stateRoot}`);
  }
}
