import { readFile, writeFile } from "node:fs/promises";

const target = new URL("../public/openapi.json", import.meta.url);
const original = await readFile(target, "utf8");
const document = JSON.parse(original);

document.servers = [{ url: "https://app.unticket.ai", description: "Hosted NoxConnect API" }];
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
  type: "http", scheme: "bearer", bearerFormat: "nox_sk_live_…",
  description: "Organization- and project-bound, service-scoped NoxConnect automation token. Store as a secret; the value is shown only once.",
};
document.components.securitySchemes.nativeSession = {
  type: "http", scheme: "bearer", bearerFormat: "nox_at_…",
  description: "Short-lived first-party native application session. Refresh with a rotating nox_rt_ credential; provider credentials remain encrypted in NoxConnect.",
};
document.components.securitySchemes.bearerAuth.description = "Deprecated GitHub bearer compatibility for local development and one-time native migration. It will be removed after supported native clients have upgraded.";
document.security = [
  { browserSession: [], organization: [] },
  { nativeSession: [], organization: [] },
  { noxApiToken: [] },
  { bearerAuth: [], organization: [] },
];

document.paths["/api/auth/native/device/start"] = {
  post: nativeAuthOperation("startNativeDeviceAuthorization", "Start native GitHub authorization", {
    type: "object", additionalProperties: false, required: ["client"],
    properties: { client: { const: "noxfeed-mac" } },
  }, "Returns an opaque NoxConnect device handle plus the GitHub verification URI and user code."),
};
document.paths["/api/auth/native/device/poll"] = {
  post: nativeAuthOperation("pollNativeDeviceAuthorization", "Poll native GitHub authorization", {
    type: "object", additionalProperties: false, required: ["client", "device_code"],
    properties: { client: { const: "noxfeed-mac" }, device_code: { type: "string", pattern: "^noxdc_" } },
  }, "NoxConnect completes the GitHub exchange server-side and returns its own short-lived access and rotating refresh credentials."),
};
document.paths["/api/auth/native/refresh"] = {
  post: nativeAuthOperation("refreshNativeSession", "Rotate a native session", {
    type: "object", additionalProperties: false, required: ["refresh_token"],
    properties: { refresh_token: { type: "string", pattern: "^nox_rt_", writeOnly: true } },
  }, "Rotates both native credentials. The previous access and refresh values stop working immediately."),
};
document.paths["/api/auth/native/exchange"] = {
  post: nativeAuthOperation("exchangeLegacyNativeCredential", "Upgrade a legacy native session", {
    type: "object", additionalProperties: false, required: ["client", "access_token"],
    properties: {
      client: { const: "noxfeed-mac" },
      access_token: { type: "string", writeOnly: true },
      refresh_token: { type: "string", writeOnly: true },
    },
  }, "Temporary one-time migration route for older NoxFeed releases. Normal sign-in uses the brokered device flow."),
};
document.paths["/api/auth/native/revoke"] = {
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

document.paths["/api/cues/github-issues"] = {
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
  document.paths["/api/cues/public/v1/events"] = oldCuePath;
  delete document.paths["/v1/events"];
}
const cueIngest = document.paths["/api/cues/public/v1/events"].post;
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
  "/api/issues": [
    parameter("state", { type: "string" }, "Issue state filter"),
    parameter("repo", { type: "string" }, "Repository name"),
    parameter("page", { type: "integer", minimum: 1, default: 1 }, "Page number"),
    parameter("page_size", { type: "integer", minimum: 1, maximum: 5000, default: 30 }, "Results per page"),
    parameter("sort", { type: "string" }, "Sort field"),
    parameter("sort_dir", { type: "string", enum: ["asc", "desc"] }, "Sort direction"),
  ],
  "/api/prs": [
    parameter("state", { type: "string" }, "Pull-request state filter"),
    parameter("author", { type: "string" }, "GitHub author login"),
    parameter("repo", { type: "string" }, "Repository name"),
    parameter("page", { type: "integer", minimum: 1, default: 1 }, "Page number"),
    parameter("page_size", { type: "integer", minimum: 1, maximum: 500, default: 100 }, "Results per page"),
  ],
  "/api/cues/events": [
    parameter("sourceId", { type: "string", format: "uuid" }, "Optional source filter"),
    parameter("limit", { type: "integer", minimum: 1, maximum: 100, default: 25 }, "Maximum recent events"),
  ],
};
for (const [path, parameters] of Object.entries(queryParameters)) {
  document.paths[path].get.parameters = parameters;
}

document.components.schemas.NoxFeedConfigPatch.properties.projectScope.description = "Null selects all projects; otherwise use the ID of an active project returned by GET /api/projects.";

for (const [path, pathItem] of Object.entries(document.paths)) {
  for (const [method, operation] of Object.entries(pathItem)) {
    if (!new Set(["get", "post", "put", "patch", "delete"]).has(method)) continue;
    const isV1 = path.startsWith("/api/v1/");
    if (isV1) {
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
    if (["member", "admin"].includes(operation["x-authentication"]) && !acceptsProjectToken(path, method)) {
      operation.security = [
        { browserSession: [], organization: [] },
        { nativeSession: [], organization: [] },
        { bearerAuth: [], organization: [] },
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

function serviceTag(path) {
  if (path.startsWith("/api/features") || path.startsWith("/api/specs")) return "NoxTicket";
  if (path === "/api/v1/feed" || path.startsWith("/api/issues") || path.startsWith("/api/prs") || path.startsWith("/api/engineer-activity") || path.startsWith("/api/llm-settings")) return "NoxFeed";
  if (path.startsWith("/api/spots")) return "NoxSpot";
  if (path.startsWith("/api/cues")) return "NoxCue";
  return "NoxConnect";
}

function authenticationFor(operation) {
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
