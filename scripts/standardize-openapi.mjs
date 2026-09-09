import { readFile, writeFile } from "node:fs/promises";

const target = new URL("../public/openapi.json", import.meta.url);
const original = await readFile(target, "utf8");
const document = JSON.parse(original);

// The first API inventory documented existing UI routes in place. Promote all
// first-party operations into the canonical v1 namespace while leaving the
// old handlers deployed as compatibility adapters. NoxSpot's anonymous
// capture API stays on its separately isolated public origin.
for (const [path, pathItem] of Object.entries(document.paths)) {
  const canonicalPath = canonicalApiPath(path);
  if (canonicalPath === path) continue;
  if (document.paths[canonicalPath]) {
    throw new Error(`Cannot promote ${path}: ${canonicalPath} already exists`);
  }
  document.paths[canonicalPath] = pathItem;
  delete document.paths[path];
}

document.servers = [{ url: "https://app.noxhere.com", description: "Hosted NoxConnect API" }];
document.tags = [
  { name: "NoxConnect", description: "Connections, identity, repositories, projects, and shared delivery." },
  { name: "NoxTicket", description: "Features, workflow, specifications, and attachments." },
  { name: "NoxFeed", description: "Current work, engineering activity, and narratives." },
  { name: "NoxSpot", description: "Sites, website feedback capture, and screenshots." },
  { name: "NoxCue", description: "Event sources, ingest keys, customer-health events, and metrics." },
];
document.components.schemas.JsonValue = {
  description: "Legacy response whose stable typed schema has not yet been promoted into API v1.",
  oneOf: [
    { type: "null" },
    { type: "boolean" },
    { type: "number" },
    { type: "string" },
    { type: "array", items: { "$ref": "#/components/schemas/JsonValue" } },
    { type: "object", additionalProperties: { "$ref": "#/components/schemas/JsonValue" } },
  ],
};
document.components.schemas.NoxSpotErrorBatch = {
  type: "object",
  additionalProperties: false,
  required: ["siteId", "errors"],
  properties: {
    siteId: { type: "string", minLength: 1 },
    errors: {
      type: "array",
      minItems: 1,
      maxItems: 10,
      items: {
        type: "object",
        additionalProperties: true,
        required: ["message"],
        properties: {
          message: { type: "string", minLength: 1, maxLength: 2000 },
          title: { type: "string", maxLength: 200 },
          url: { type: "string", format: "uri", maxLength: 2048 },
        },
      },
    },
  },
};
document.components.schemas.NoxCueIngestResponse = {
  type: "object",
  required: ["accepted", "stored", "eventId", "queued"],
  properties: {
    accepted: { const: true },
    stored: { type: "boolean" },
    eventId: { type: "string" },
    queued: { type: "boolean" },
    duplicate: { type: "boolean" },
    notificationSuppressed: { type: "boolean" },
    period: { type: "string" },
  },
};
document.components.schemas.NoxCueGitHubIssueSettingsUpdate = {
  type: "object",
  additionalProperties: false,
  required: ["projectId", "enabled", "environments"],
  properties: {
    projectId: { type: "string", minLength: 1, maxLength: 200 },
    enabled: { type: "boolean" },
    environments: {
      type: "array", minItems: 1, maxItems: 6, uniqueItems: true,
      items: { type: "string", enum: ["production", "staging", "development", "preview", "test", "local"] },
    },
    commentOnRepeat: { type: "boolean", default: false },
    repeatIntervalMinutes: { type: "integer", minimum: 15, maximum: 10080, default: 360 },
  },
};
document.components.schemas.ApiTokenCreate = {
  type: "object",
  additionalProperties: false,
  required: ["name", "projectId", "scopes"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: 80 },
    environment: { type: "string", enum: ["live", "test"], default: "live" },
    projectId: { type: "string", minLength: 1, maxLength: 240, description: "One enabled NoxConnect project. The token cannot access resources assigned to another project." },
    scopes: { type: "array", minItems: 1, maxItems: 12, uniqueItems: true, items: { type: "string", pattern: "^(services:read|(noxfeed|noxspot|noxcue):(read|write))$" } },
    expiresInDays: { type: "integer", minimum: 1, maximum: 365, default: 90 },
  },
};

document.components.securitySchemes.browserSession = {
  type: "apiKey", in: "cookie", name: "__Host-nox_session",
  description: "Opaque HttpOnly session created by GitHub OAuth for the first-party web application. Browser mutations also require X-CSRF-Token.",
};
document.components.securitySchemes.noxApiToken = {
  type: "http", scheme: "bearer", bearerFormat: "nox_sk_{environment}_…",
  description: "Organization- and project-bound, service-scoped NoxConnect automation token. Store as a secret; the value is shown only once.",
};
document.components.securitySchemes.nativeSession = {
  type: "http", scheme: "bearer", bearerFormat: "nox_at_…",
  description: "Short-lived first-party native application session. Refresh with a rotating nox_rt_ credential; provider credentials remain encrypted in NoxConnect.",
};
delete document.components.securitySchemes.bearerAuth;
document.components.responses.Unauthorized.description = "Missing, invalid, or expired supported credential";
document.security = [
  { browserSession: [], organization: [] },
  { nativeSession: [], organization: [] },
  { noxApiToken: [] },
];

for (const pathItem of Object.values(document.paths)) {
  for (const operation of Object.values(pathItem)) {
    if (!operation || typeof operation !== "object" || !Array.isArray(operation.security)) continue;
    operation.security = operation.security.filter((requirement) => !("bearerAuth" in requirement));
  }
}

document.paths["/api/v1/auth/native/device/start"] = {
  post: nativeAuthOperation("startNativeDeviceAuthorization", "Start native GitHub authorization", {
    type: "object", additionalProperties: false, required: ["client"],
    properties: { client: { const: "noxfeed-mac" } },
  }, "Returns an opaque NoxConnect device handle plus the GitHub verification URI and user code."),
};
document.paths["/api/v1/auth/native/device/poll"] = {
  post: nativeAuthOperation("pollNativeDeviceAuthorization", "Poll native GitHub authorization", {
    type: "object", additionalProperties: false, required: ["client", "device_code"],
    properties: { client: { const: "noxfeed-mac" }, device_code: { type: "string", pattern: "^noxdc_" } },
  }, "NoxConnect completes the GitHub exchange server-side and returns its own short-lived access and rotating refresh credentials."),
};
document.paths["/api/v1/auth/native/refresh"] = {
  post: nativeAuthOperation("refreshNativeSession", "Rotate a native session", {
    type: "object", additionalProperties: false, required: ["refresh_token"],
    properties: { refresh_token: { type: "string", pattern: "^nox_rt_", writeOnly: true } },
  }, "Rotates both native credentials. The previous access and refresh values stop working immediately."),
};
document.paths["/api/v1/auth/native/exchange"] = {
  post: nativeAuthOperation("exchangeLegacyNativeCredential", "Upgrade a legacy native session", {
    type: "object", additionalProperties: false, required: ["client", "access_token"],
    properties: {
      client: { const: "noxfeed-mac" },
      access_token: { type: "string", writeOnly: true },
      refresh_token: { type: "string", writeOnly: true },
    },
  }, "Temporary one-time migration route for older NoxFeed releases. Normal sign-in uses the brokered device flow."),
};
document.paths["/api/v1/auth/native/revoke"] = {
  post: {
    operationId: "revokeNativeSession",
    summary: "Revoke the current native session",
    description: "Send the rotating refresh credential so sign-out can revoke the server session even after the short-lived access credential expires. A valid access bearer remains supported for older clients.",
    security: [],
    requestBody: {
      required: true,
      content: { "application/json": { schema: {
        type: "object", additionalProperties: false, required: ["refresh_token"],
        properties: { refresh_token: { type: "string", pattern: "^nox_rt_", writeOnly: true } },
      } } },
    },
    "x-native-refresh": true,
    responses: { "200": { description: "Session revoked" }, "401": { description: "Invalid or expired session" } },
  },
};

// First-party clients use the same versioned boundary as external consumers.
// These routes retain their established response payloads while gaining the
// v1 error, cache, discovery, authentication, and service-gating contract.
const clientRouteContracts = [
  ["/api/v1/auth/profile", [["get", "getIdentityProfile", "Read the signed-in GitHub identity and organizations", "member", false]]],
  ["/api/v1/app-activity", [["post", "recordAppActivity", "Record bounded first-party app activity", "member"]]],
  ["/api/v1/assign", [["post", "assignIssue", "Assign a tracked GitHub issue", "member"]]],
  ["/api/v1/bootstrap-status", [["get", "getBootstrapStatus", "Read initial GitHub synchronization status", "member"]]],
  ["/api/v1/config/{key}", [
    ["get", "getWorkspaceConfig", "Read one shared workspace configuration document", "member"],
    ["put", "putWorkspaceConfig", "Replace one shared workspace configuration document", "admin"],
  ]],
  ["/api/v1/cues/shares", [
    ["get", "listNoxCueDashboardShares", "List active NoxCue dashboard shares", "admin"],
    ["post", "upsertNoxCueDashboardShare", "Create or rotate a NoxCue dashboard share", "admin"],
  ]],
  ["/api/v1/cues/shares/{shareId}", [["delete", "deleteNoxCueDashboardShare", "Disable a NoxCue dashboard share", "admin"]]],
  ["/api/v1/cues/sources/{sourceId}/health/test", [["post", "testNoxCueSource", "Test a NoxCue source destination", "admin"]]],
  ["/api/v1/engineer-stats", [["get", "getEngineerStats", "Read current work counts by engineer", "member"]]],
  ["/api/v1/events", [["get", "listFeedEvents", "List detailed NoxFeed events", "member"]]],
  ["/api/v1/events/{id}", [["get", "getFeedEvent", "Read one detailed NoxFeed event", "member"]]],
  ["/api/v1/github/comments", [["get", "getGitHubComments", "Read comments for a tracked pull request", "member"]]],
  ["/api/v1/github/details", [["get", "getGitHubDetails", "Read live details for a tracked issue or pull request", "member"]]],
  ["/api/v1/github/rate-limit", [["get", "getGitHubRateLimit", "Read the connected GitHub installation rate limit", "member"]]],
  ["/api/v1/integrations/status", [["get", "getIntegrationStatus", "Read credential-free integration readiness", "member"]]],
  ["/api/v1/issue-state", [["post", "setIssueState", "Open or close a tracked GitHub issue", "member"]]],
  ["/api/v1/me", [["get", "getCurrentMember", "Read membership and NoxConnect role for the current organization", "member"]]],
  ["/api/v1/members", [["get", "listMembers", "List members visible through the connected GitHub organization", "member"]]],
  ["/api/v1/noxfeed/release-notes-prompt", [["get", "getNoxFeedDefaultPrompt", "Read the server-owned NoxFeed release-notes prompt", "admin"]]],
  ["/api/v1/op-failures", [["get", "listOperationFailures", "List recent background-operation failures", "admin"]]],
  ["/api/v1/operator/usage", [["get", "getOperatorUsage", "Read platform-wide operator usage", "platform_operator", false]]],
  ["/api/v1/projects/{projectId}/backfill-prs", [["post", "backfillProjectPullRequests", "Queue bounded NoxFeed pull-request history", "admin"]]],
  ["/api/v1/recover-repo-history", [["post", "recoverRepositoryHistory", "Recover bounded repository history", "admin"]]],
  ["/api/v1/search", [["get", "searchWorkspace", "Search tracked work and people", "member"]]],
  ["/api/v1/slack/disconnect", [["post", "disconnectSlackWorkspace", "Disconnect one Slack workspace", "admin"]]],
  ["/api/v1/slack/status", [["get", "getSlackStatus", "Read Slack connections and delivery health", "member"]]],
  ["/api/v1/slack/test", [["post", "testSlackDestination", "Send a test message to a Slack destination", "admin"]]],
  ["/api/v1/spots/shares", [["post", "upsertNoxSpotProjectShare", "Create or rotate a NoxSpot project share", "admin"]]],
  ["/api/v1/spots/shares/{shareId}", [["delete", "deleteNoxSpotProjectShare", "Disable a NoxSpot project share", "admin"]]],
  ["/api/v1/sync", [
    ["get", "getSyncStatus", "Read GitHub synchronization freshness", "member"],
    ["post", "syncGitHubData", "Synchronize bounded GitHub data", "admin"],
  ]],
  ["/api/v1/sync-events", [["post", "syncGitHubEvents", "Backfill bounded GitHub activity events", "admin"]]],
  ["/api/v1/teams", [["get", "listGitHubTeams", "List teams visible through the connected GitHub organization", "member"]]],
];
delete document.paths["/api/v1/cues/shares/{id}"];
delete document.paths["/api/v1/spots/shares/{id}"];
for (const [path, methods] of clientRouteContracts) {
  document.paths[path] ??= {};
  const pathParameters = [...path.matchAll(/\{([^}]+)\}/g)].map(([, name]) => ({
    name, in: "path", required: true, schema: { type: "string", minLength: 1 },
  }));
  if (pathParameters.length) document.paths[path].parameters ??= pathParameters;
  for (const [method, operationId, summary, role, organization = true] of methods) {
    document.paths[path][method] ??= firstPartyClientOperation(operationId, summary, role, organization, method);
  }
}

document.paths["/api/v1/cues/github-issues"] = {
  get: {
    operationId: "getNoxCueGitHubIssueSettings",
    summary: "List project GitHub-incident settings",
    description: "Returns each active project's repository mapping, routing policy, and open NoxCue incident count.",
    "x-required-role": "admin",
    responses: { "200": { description: "Project incident settings" } },
  },
  put: {
    operationId: "putNoxCueGitHubIssueSettings",
    summary: "Update project GitHub-incident settings",
    description: "Controls whether NoxCue opens or updates a GitHub issue for incidents in the selected project and environments.",
    "x-required-role": "admin",
    requestBody: {
      required: true,
      content: { "application/json": { schema: { "$ref": "#/components/schemas/NoxCueGitHubIssueSettingsUpdate" } } },
    },
    responses: {
      "200": { description: "Project incident settings updated" },
      "404": { description: "Active project not found" },
      "409": { description: "Project has no linked GitHub repository" },
    },
  },
};

function acceptsProjectToken(path, method) {
  if (method === "get" && /^\/api\/v1\/services(?:\/[^/]+(?:\/(?:setup|health))?)?$/.test(path)) return true;
  if (method === "get" && path === "/api/v1/feed") return true;
  path = compatibilityApiPath(path);
  if (method === "get" && /^\/api\/(?:issues|prs)(?:\/|$)/.test(path)) return true;
  if (method === "post" && /^\/api\/projects\/[^/]+\/backfill-prs$/.test(path)) return true;
  if (/^\/api\/spots\/sites(?:\/|$)/.test(path)) return true;
  if (/^\/api\/cues\/sources(?:\/|$)/.test(path)) return true;
  if (method === "get" && (path === "/api/cues/events" || path === "/api/cues/metrics")) return true;
  if (/^\/api\/cues\/projects\/[^/]+\/metrics$/.test(path)) return true;
  return false;
}

document.paths["/api/v1/api-tokens"] = {
  get: apiTokenOperation("listApiTokens", "List redacted API-token metadata", "200"),
  post: {
    ...apiTokenOperation("createApiToken", "Create a scoped API token", "201"),
    requestBody: { required: true, content: { "application/json": { schema: { "$ref": "#/components/schemas/ApiTokenCreate" } } } },
  },
};
document.paths["/api/v1/api-tokens/{id}"] = {
  parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
  delete: apiTokenOperation("revokeApiToken", "Revoke an API token", "200"),
};
document.paths["/api/v1/api-tokens/{id}/rotate"] = {
  parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
  post: apiTokenOperation("rotateApiToken", "Rotate an API token and return its replacement once", "201"),
};

const oldCuePath = document.paths["/v1/events"];
if (oldCuePath) {
  document.paths["/api/v1/cues/public/events"] = oldCuePath;
  delete document.paths["/v1/events"];
}
const cueIngest = document.paths["/api/v1/cues/public/events"].post;
delete cueIngest.servers;
cueIngest.summary = "Submit one standardized NoxCue event through the stable NoxConnect gateway";
cueIngest.description = "Authenticated by X-Nox-Ingest-Key. Supply eventId or idempotencyKey when retrying error and feature events. User lifecycle facts are intrinsically deduplicated by source, user, type, and period.";
cueIngest.responses["202"].content = { "application/json": { schema: { "$ref": "#/components/schemas/NoxCueIngestResponse" } } };
cueIngest.responses["413"] = { description: "Payload exceeds 32 KiB", content: { "application/json": { schema: { "$ref": "#/components/schemas/LegacyError" } } } };
cueIngest.responses["415"] = { description: "Content-Type must be application/json", content: { "application/json": { schema: { "$ref": "#/components/schemas/LegacyError" } } } };

const browserErrors = document.paths["/api/spots/public/v1/errors"].post;
browserErrors.requestBody = {
  required: true,
  content: { "application/json": { schema: { "$ref": "#/components/schemas/NoxSpotErrorBatch" } } },
};

const queryParameters = {
  "/api/v1/feed": [
    parameter("mode", { type: "string", enum: ["opened", "merged", "release-notes"], default: "merged" }, "Feed event mode"),
    parameter("repo", { type: "string", maxLength: 200 }, "Repository name"),
    parameter("actor", { type: "string", maxLength: 100 }, "GitHub login"),
    parameter("limit", { type: "integer", minimum: 1, maximum: 200, default: 25 }, "Maximum events"),
    parameter("before", { type: "string", maxLength: 200 }, "Composite cursor returned by the previous page"),
  ],
  "/api/v1/issues": [
    parameter("state", { type: "string" }, "Issue state filter"),
    parameter("repo", { type: "string" }, "Repository name"),
    parameter("page", { type: "integer", minimum: 1, default: 1 }, "Page number"),
    parameter("page_size", { type: "integer", minimum: 1, maximum: 5000, default: 30 }, "Results per page"),
    parameter("sort", { type: "string" }, "Sort field"),
    parameter("sort_dir", { type: "string", enum: ["asc", "desc"] }, "Sort direction"),
  ],
  "/api/v1/prs": [
    parameter("state", { type: "string" }, "Pull-request state filter"),
    parameter("author", { type: "string" }, "GitHub author login"),
    parameter("repo", { type: "string" }, "Repository name"),
    parameter("page", { type: "integer", minimum: 1, default: 1 }, "Page number"),
    parameter("page_size", { type: "integer", minimum: 1, maximum: 500, default: 100 }, "Results per page"),
  ],
  "/api/v1/cues/events": [
    parameter("sourceId", { type: "string", format: "uuid" }, "Optional source filter"),
    parameter("limit", { type: "integer", minimum: 1, maximum: 100, default: 25 }, "Maximum recent events"),
  ],
};
for (const [path, parameters] of Object.entries(queryParameters)) {
  document.paths[path].get.parameters = parameters;
}

document.components.schemas.NoxFeedConfigPatch.properties.projectScope.description = "Null selects all projects; otherwise use the ID of an active project returned by GET /api/v1/projects.";

for (const [path, pathItem] of Object.entries(document.paths)) {
  for (const [method, operation] of Object.entries(pathItem)) {
    if (!new Set(["get", "post", "put", "patch", "delete"]).has(method)) continue;
    const isV1 = path.startsWith("/api/v1/");
    if (isV1) {
      for (const status of Object.keys(operation.responses)) {
        if (/^[45]/.test(status) || status === "default") {
          operation.responses[status] = { "$ref": "#/components/responses/V1Error" };
        }
      }
      for (const status of ["400", "401", "403", "429"]) {
        operation.responses[status] ??= { "$ref": "#/components/responses/V1Error" };
      }
    }
    operation.tags = [serviceTag(path)];
    operation["x-authentication"] = authenticationFor(operation);
    if (!isV1 && ["member", "admin"].includes(operation["x-authentication"])) {
      operation.responses["401"] ??= { description: "Authentication required" };
      operation.responses["403"] ??= { description: "Insufficient access or service not enabled" };
    }
    if (["member", "admin"].includes(operation["x-authentication"])
        && !operation["x-browser-session-only"]
        && !operation["x-organization-optional"]
        && !acceptsProjectToken(path, method)) {
      operation.security = [
        { browserSession: [], organization: [] },
        { nativeSession: [], organization: [] },
      ];
    }
    operation["x-change-safety"] = changeSafety(method, operation.operationId);
    for (const [status, response] of Object.entries(operation.responses)) {
      if (response.$ref || status === "204" || response.content) continue;
      const schema = path.includes("/attachments/{attachmentId}") && method === "get" && status.startsWith("2")
        ? { type: "string", format: "binary" }
        : { "$ref": status.startsWith("2") ? "#/components/schemas/JsonValue" : "#/components/schemas/LegacyError" };
      const mediaType = schema.format === "binary" ? "application/octet-stream" : "application/json";
      response.content = { [mediaType]: { schema } };
    }
  }
}

const formatted = `${JSON.stringify(document, null, 2)}\n`;
if (process.argv.includes("--check")) {
  if (formatted !== original) {
    console.error("public/openapi.json is not standardized; run npm run openapi:standardize");
    process.exitCode = 1;
  }
} else {
  await writeFile(target, formatted);
}

function parameter(name, schema, description) {
  return { name, in: "query", required: false, description, schema };
}

function apiTokenOperation(operationId, summary, successStatus) {
  return {
    operationId,
    summary,
    description: "Requires an authenticated organization-admin browser session. API tokens cannot manage other API tokens.",
    security: [{ browserSession: [], organization: [] }],
    responses: {
      [successStatus]: { description: "Success", content: { "application/json": { schema: { "$ref": "#/components/schemas/JsonValue" } } } },
    },
    "x-required-role": "admin",
    "x-browser-session-only": true,
  };
}

function nativeAuthOperation(operationId, summary, requestSchema, description) {
  return {
    operationId,
    summary,
    description,
    security: [],
    requestBody: { required: true, content: { "application/json": { schema: requestSchema } } },
    responses: {
      "200": { description: "Success", content: { "application/json": { schema: { "$ref": "#/components/schemas/JsonValue" } } } },
      "202": { description: "Authorization is still pending" },
      "400": { description: "Invalid, expired, or rejected authorization" },
      "401": { description: "Invalid or expired credential" },
      "429": { description: "Polling faster than the advertised interval" },
      "503": { description: "Authentication provider temporarily unavailable" },
    },
  };
}

function firstPartyClientOperation(operationId, summary, role, organization, method) {
  const requestBody = ["post", "put", "patch"].includes(method);
  const security = role === "platform_operator"
    ? [{ browserSession: [] }, { nativeSession: [] }]
    : organization === false
      ? [{ browserSession: [] }, { nativeSession: [] }]
      : undefined;
  return {
    operationId,
    summary,
    description: "Canonical first-party client operation. Its established success payload remains compatible while all failures use the API v1 error envelope.",
    ...(security ? { security } : {}),
    ...(requestBody ? { requestBody: {
      required: false,
      content: { "application/json": { schema: { "$ref": "#/components/schemas/JsonValue" } } },
    } } : {}),
    responses: { "200": { description: "Success" } },
    "x-required-role": role,
    "x-first-party-client": true,
    "x-organization-optional": !organization,
  };
}

function serviceTag(path) {
  const compatibilityPath = compatibilityApiPath(path);
  if (/^\/api\/(?:features|specs|assign|issue-state)(?:\/|$)/.test(compatibilityPath)) return "NoxTicket";
  if (path === "/api/v1/feed"
      || /^\/api\/(?:issues|prs|events|engineer-activity|engineer-stats|search|llm-settings|noxfeed)(?:\/|$)/.test(compatibilityPath)
      || /^\/api\/github\/(?:comments|details)$/.test(compatibilityPath)) return "NoxFeed";
  if (compatibilityPath.startsWith("/api/spots")) return "NoxSpot";
  if (compatibilityPath.startsWith("/api/cues")) return "NoxCue";
  return "NoxConnect";
}

function canonicalApiPath(path) {
  if (path.startsWith("/api/v1/")) return path;
  if (path.startsWith("/api/spots/public/v1/")) return path;
  if (path === "/api/cues/public/v1/events") return "/api/v1/cues/public/events";
  if (path === "/api/projects/routing/{projectId}") return "/api/v1/projects/{projectId}/routing";
  if (path.startsWith("/api/")) return path.replace(/^\/api\//, "/api/v1/");
  return path;
}

function compatibilityApiPath(path) {
  if (!path.startsWith("/api/v1/")) return path;
  if (/^\/api\/v1\/(?:services|api-tokens|feed)(?:\/|$)/.test(path)) return path;
  if (/^\/api\/v1\/projects\/[^/]+\/routing$/.test(path)) return path.replace(
    /^\/api\/v1\/projects\/([^/]+)\/routing$/,
    "/api/projects/routing/$1",
  );
  if (path === "/api/v1/cues/public/events") return "/api/cues/public/v1/events";
  return path.replace(/^\/api\/v1\//, "/api/");
}

function authenticationFor(operation) {
  if (operation["x-required-role"] === "platform_operator") return "platform_operator";
  if (operation["x-native-refresh"]) return "native_refresh";
  if (Array.isArray(operation.security) && operation.security.length === 0) return "public";
  if (operation.security?.some((entry) => Object.hasOwn(entry, "noxCueKey"))) return "ingest_key";
  if (operation.security?.length === 1 && Object.hasOwn(operation.security[0], "nativeSession")) return "native_session";
  const adminOperations = new Set([
    "startConnection", "disconnectConnection", "assignSlackConnectionProject",
    "getSlackRouting", "patchSlackRouting", "testSlackRoute", "archiveProject",
    "restoreProject", "acknowledgeRepositories", "updateActor", "archiveSpec",
    "restoreSpec", "closePullRequest", "getLlmSettings", "putLlmSettings",
    "createNoxSpotSite", "updateNoxSpotSite", "deleteNoxSpotSite",
    "retryNoxSpotDeliveries", "listNoxCueSources", "createNoxCueSource",
    "updateNoxCueSource", "deleteNoxCueSource", "createNoxCueKey",
    "revokeNoxCueKey", "listNoxCueEvents", "getNoxCueDailyHealth",
    "patchNoxServiceConfig",
    "getNoxCueGitHubIssueSettings", "putNoxCueGitHubIssueSettings",
  ]);
  return operation["x-required-role"] === "admin" || adminOperations.has(operation.operationId) ? "admin" : "member";
}

function changeSafety(method, operationId) {
  if (method === "get") return "safe_read";
  if (operationId === "patchNoxServiceConfig") return "conditional_write";
  if (operationId === "ingestNoxCueEvent") return "idempotent_with_event_key";
  if (method === "delete" || /disconnect|archive|close|revoke|delete/i.test(operationId)) return "destructive";
  return "write_not_safe_to_retry";
}
