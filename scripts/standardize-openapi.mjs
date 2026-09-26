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
document.components.schemas.ApiRecord = {
  type: "object",
  additionalProperties: true,
};
document.components.schemas.MutationReceipt = {
  type: "object",
  additionalProperties: true,
  properties: {
    ok: { type: "boolean" },
    status: { type: "string" },
    updatedAt: { type: "string", format: "date-time" },
  },
};
document.components.schemas.FeedActor = {
  type: "object",
  additionalProperties: false,
  required: ["login", "name", "avatarUrl"],
  properties: {
    login: { type: "string" },
    name: { type: ["string", "null"] },
    avatarUrl: { type: ["string", "null"], format: "uri" },
  },
};
document.components.schemas.FeedPullRequest = {
  type: "object",
  additionalProperties: false,
  required: ["number", "title", "url"],
  properties: {
    number: { type: "integer" },
    title: { type: "string" },
    url: { type: "string", format: "uri" },
  },
};
document.components.schemas.FeedEvent = {
  type: "object",
  additionalProperties: false,
  required: ["id", "type", "createdAt", "actor", "repo", "summary", "technicalSummary", "pr"],
  properties: {
    id: { type: "string" },
    type: { type: "string", enum: ["opened", "merged", "release-notes"] },
    createdAt: { type: "string", format: "date-time" },
    actor: { "$ref": "#/components/schemas/FeedActor" },
    repo: { type: "string" },
    summary: { type: "string" },
    technicalSummary: { type: "string" },
    pr: { oneOf: [{ "$ref": "#/components/schemas/FeedPullRequest" }, { type: "null" }] },
  },
};
document.components.schemas.FeedPage = {
  type: "object",
  additionalProperties: false,
  required: ["events", "nextCursor"],
  properties: {
    events: { type: "array", items: { "$ref": "#/components/schemas/FeedEvent" } },
    nextCursor: { type: ["string", "null"] },
  },
};
document.components.schemas.PaginatedRecords = {
  type: "object",
  additionalProperties: true,
  required: ["data", "totalCount", "page", "pageSize"],
  properties: {
    data: { type: "array", items: { "$ref": "#/components/schemas/ApiRecord" } },
    totalCount: { type: "integer", minimum: 0 },
    page: { type: "integer", minimum: 1 },
    pageSize: { type: "integer", minimum: 1 },
  },
};
document.components.schemas.RecordCollection = {
  oneOf: [
    { type: "array", items: { "$ref": "#/components/schemas/ApiRecord" } },
    { "$ref": "#/components/schemas/PaginatedRecords" },
    { "$ref": "#/components/schemas/ApiRecord" },
  ],
};
document.components.schemas.Feature = {
  allOf: [{ "$ref": "#/components/schemas/ApiRecord" }],
  description: "NoxTicket feature mirrored from its GitHub issue, including number, title, workflow status, owners, labels, and project.",
};
document.components.schemas.FeatureList = {
  type: "array",
  items: { "$ref": "#/components/schemas/Feature" },
};
document.components.schemas.Spec = {
  allOf: [{ "$ref": "#/components/schemas/ApiRecord" }],
  description: "NoxTicket specification with its project, workflow state, content, and archive metadata.",
};
document.components.schemas.SpecList = {
  type: "object",
  additionalProperties: false,
  required: ["specs"],
  properties: { specs: { type: "array", items: { "$ref": "#/components/schemas/Spec" } } },
};
document.components.schemas.SpecAttachment = {
  allOf: [{ "$ref": "#/components/schemas/ApiRecord" }],
  description: "Metadata for one specification attachment.",
};
document.components.schemas.SpecAttachmentList = {
  type: "object",
  additionalProperties: false,
  required: ["attachments"],
  properties: { attachments: { type: "array", items: { "$ref": "#/components/schemas/SpecAttachment" } } },
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
document.components.schemas.NoxSpotResolutionTemplate = {
  type: "object",
  additionalProperties: false,
  required: ["tone", "senderName", "subject", "acknowledgement", "reopenText", "buttonLabel", "closing", "replyTo", "appearance"],
  properties: {
    tone: { type: "string", enum: ["default", "warm", "formal", "concise"] },
    senderName: { type: "string", minLength: 1, maxLength: 80, description: "Display name shown next to the platform's verified sending address." },
    subject: { type: "string", minLength: 1, maxLength: 200 },
    acknowledgement: { type: "string", minLength: 1, maxLength: 500 },
    reopenText: { type: "string", minLength: 1, maxLength: 500 },
    buttonLabel: { type: "string", minLength: 1, maxLength: 60 },
    closing: { type: "string", minLength: 1, maxLength: 500 },
    replyTo: { type: ["string", "null"], format: "email", maxLength: 254 },
    appearance: {
      type: "object",
      additionalProperties: false,
      required: ["accentColor", "backgroundColor", "surfaceColor", "textColor", "mutedColor", "fontPreset"],
      properties: {
        accentColor: { type: "string", pattern: "^#[0-9A-Fa-f]{6}$" },
        backgroundColor: { type: "string", pattern: "^#[0-9A-Fa-f]{6}$" },
        surfaceColor: { type: "string", pattern: "^#[0-9A-Fa-f]{6}$" },
        textColor: { type: "string", pattern: "^#[0-9A-Fa-f]{6}$" },
        mutedColor: { type: "string", pattern: "^#[0-9A-Fa-f]{6}$" },
        fontPreset: { type: "string", enum: ["system", "playnist", "humanist", "editorial", "mono"], description: "Email-safe font stack. Custom fonts fall back safely when the recipient's client does not support them." },
      },
    },
  },
  description: "Site-level content and brand presentation for NoxSpot resolution emails. Every site can configure this in NoxConnect or with a project-scoped API token. Only {{report_title}} and {{site_name}} placeholders are accepted. NoxConnect owns the evidence rules, AI safety prompt, safe HTML rendering, verified sender address, and reopen behavior.",
};
document.components.schemas.NoxSpotResolutionTemplateDocument = {
  type: "object",
  additionalProperties: false,
  required: ["template", "defaults", "usingDefault", "revision"],
  properties: {
    template: { "$ref": "#/components/schemas/NoxSpotResolutionTemplate" },
    defaults: { "$ref": "#/components/schemas/NoxSpotResolutionTemplate" },
    usingDefault: { type: "boolean" },
    revision: { type: "string", pattern: "^[a-f0-9]{64}$" },
  },
};

const resolutionTemplatePath = "/api/v1/spots/sites/{siteId}/resolution-template";
const resolutionTemplateParameters = [{ name: "siteId", in: "path", required: true, schema: { type: "string", minLength: 1 } }];
document.paths[resolutionTemplatePath] = {
  get: {
    operationId: "getNoxSpotResolutionTemplate",
    summary: "Read the effective NoxSpot resolution email template",
    description: "Returns the site's custom content and appearance or the NoxConnect default plus a revision for conditional updates. Organization admins and project-scoped API tokens can use the same endpoint.",
    parameters: resolutionTemplateParameters,
    responses: { "200": { description: "Effective template", content: { "application/json": { schema: { "$ref": "#/components/schemas/NoxSpotResolutionTemplateDocument" } } } } },
    "x-required-role": "admin",
  },
  patch: {
    operationId: "updateNoxSpotResolutionTemplate",
    summary: "Update or reset a NoxSpot resolution email template",
    description: "Send the revision returned by GET as If-Match. Set template to null to restore the default. This is the self-service configuration used by the NoxConnect UI and is also available to project-scoped API tokens. Postmark is transport-only; NoxConnect validates, renders, and snapshots the template used for each resolution.",
    parameters: [...resolutionTemplateParameters, { name: "If-Match", in: "header", required: true, schema: { type: "string" } }],
    requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, required: ["template"], properties: { template: { oneOf: [{ "$ref": "#/components/schemas/NoxSpotResolutionTemplate" }, { type: "null" }] } } } } } },
    responses: {
      "200": { description: "Saved template", content: { "application/json": { schema: { "$ref": "#/components/schemas/NoxSpotResolutionTemplateDocument" } } } },
      "412": { description: "The template changed since it was read" },
      "428": { description: "If-Match is required" },
    },
    "x-required-role": "admin",
  },
};
document.paths[`${resolutionTemplatePath}/preview`] = {
  post: {
    operationId: "previewNoxSpotResolutionTemplate",
    summary: "Render a safe preview of a draft resolution email template",
    parameters: resolutionTemplateParameters,
    requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, required: ["template"], properties: { template: { "$ref": "#/components/schemas/NoxSpotResolutionTemplate" } } } } } },
    responses: { "200": { description: "Rendered preview" } },
    "x-required-role": "admin",
  },
};
document.paths[`${resolutionTemplatePath}/test`] = {
  post: {
    operationId: "testNoxSpotResolutionTemplate",
    summary: "Send a draft resolution email through NoxConnect and Postmark",
    description: "The draft does not need to be saved. NoxConnect renders the safe email and sends it through its private Postmark-backed email capability.",
    parameters: resolutionTemplateParameters,
    requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, required: ["recipient", "template"], properties: { recipient: { type: "string", format: "email", maxLength: 254 }, template: { "$ref": "#/components/schemas/NoxSpotResolutionTemplate" } } } } } },
    responses: { "200": { description: "Postmark accepted the test email" }, "503": { description: "Email delivery is unavailable" } },
    "x-required-role": "admin",
  },
};

document.components.securitySchemes.browserSession = {
  type: "apiKey", in: "cookie", name: "__Host-nox_session",
  description: "Opaque HttpOnly session created by an email magic link or GitHub OAuth. Browser mutations also require X-CSRF-Token.",
};
document.components.securitySchemes.csrfProof = {
  type: "apiKey", in: "header", name: "X-CSRF-Token",
  description: "Required with the nox_csrf cookie for unsafe browser-session requests. Native sessions and automation tokens do not use CSRF proof.",
};
document.components.securitySchemes.noxApiToken = {
  type: "http", scheme: "bearer", bearerFormat: "nox_sk_{environment}_…",
  description: "Organization- and project-bound, service-scoped NoxHere automation token. Store as a secret; the value is shown only once.",
};
document.components.securitySchemes.nativeSession = {
  type: "http", scheme: "bearer", bearerFormat: "nox_at_…",
  description: "Short-lived first-party native application session issued by NoxHere. Refresh with a rotating nox_rt_ credential; provider credentials remain encrypted in NoxConnect.",
};
document.components.parameters.projectContext = {
  name: "X-Project-ID",
  in: "header",
  required: false,
  description: "Optional project selector inside the authenticated organization. Omit it for organization-wide data. When supplied, it must match any project identifier in the URL and the project bound to an API token.",
  schema: { type: "string", minLength: 1, maxLength: 240 },
};
delete document.components.securitySchemes.bearerAuth;
document.components.responses.Unauthorized.description = "Missing, invalid, or expired supported credential";
document.security = [
  { browserSession: [], organization: [] },
  { nativeSession: [], organization: [] },
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
  ["/api/v1/auth/logout", [["post", "revokeBrowserSession", "Revoke the current browser session", "member", false]]],
  ["/api/v1/app-activity", [["post", "recordAppActivity", "Record bounded first-party app activity", "member"]]],
  ["/api/v1/assign", [["post", "assignIssue", "Assign a tracked GitHub issue", "member"]]],
  ["/api/v1/bootstrap-status", [["get", "getBootstrapStatus", "Read initial GitHub synchronization status", "member"]]],
  ["/api/v1/config/{key}", [
    ["get", "getWorkspaceConfig", "Read one shared workspace configuration document", "member"],
    ["put", "putWorkspaceConfig", "Replace one shared workspace configuration document", "admin"],
  ]],
  ["/api/v1/cues/project-overview", [["get", "getNoxCueProjectOverview", "Read a guest-safe NoxCue project overview", "member"]]],
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
  ["/api/v1/projects", [["post", "createProject", "Create an empty project scope", "admin"]]],
  ["/api/v1/projects/{projectId}/retrieval", [["get", "retrieveProject", "Search the selected project across Nox services", "member"]]],
  ["/api/v1/projects/{projectId}/cue/dashboard", [["get", "getProjectCueDashboard", "Read the selected project's NoxCue dashboard", "member"]]],
  ["/api/v1/projects/{projectId}/cue/stat-events", [["get", "listProjectCueStatEvents", "List accepted NoxCue events for the selected project", "member"]]],
  ["/api/v1/projects/{projectId}/cue/alerts", [["get", "listProjectCueAlerts", "List NoxCue alerts for the selected project", "member"]]],
  ["/api/v1/projects/{projectId}/cue/alert-rules", [["get", "listProjectCueAlertRules", "List effective NoxCue alert rules for the selected project", "member"]]],
  ["/api/v1/projects/{projectId}/backfill-prs", [["post", "backfillProjectPullRequests", "Queue bounded NoxFeed pull-request history", "admin"]]],
  ["/api/v1/recover-repo-history", [["post", "recoverRepositoryHistory", "Recover bounded repository history", "admin"]]],
  ["/api/v1/search", [["get", "searchWorkspace", "Search tracked work and people", "member"]]],
  ["/api/v1/slack/disconnect", [["post", "disconnectSlackWorkspace", "Disconnect one Slack workspace", "admin"]]],
  ["/api/v1/slack/status", [["get", "getSlackStatus", "Read Slack connections and delivery health", "member"]]],
  ["/api/v1/slack/test", [["post", "testSlackDestination", "Send a test message to a Slack destination", "admin"]]],
  ["/api/v1/spots/project-overview", [["get", "getNoxSpotProjectOverview", "Read a guest-safe NoxSpot project overview", "member"]]],
  ["/api/v1/feed/current-summary", [["get", "getCurrentWorkSummary", "Read per-person current-work counts for the selected project", "member"]]],
  ["/api/v1/sync", [
    ["get", "getSyncStatus", "Read GitHub synchronization freshness", "member"],
    ["post", "syncGitHubData", "Synchronize bounded GitHub data", "admin"],
  ]],
  ["/api/v1/sync-events", [["post", "syncGitHubEvents", "Backfill bounded GitHub activity events", "admin"]]],
  ["/api/v1/teams", [["get", "listGitHubTeams", "List teams visible through the connected GitHub organization", "member"]]],
];
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
document.paths["/api/v1/cues/project-overview"].get["x-guest-access"] = "read";
document.paths["/api/v1/spots/project-overview"].get["x-guest-access"] = "read";
document.paths["/api/v1/auth/logout"].post["x-browser-session-only"] = true;
document.paths["/api/v1/projects"].post.requestBody.required = true;
document.paths["/api/v1/projects"].post.responses["201"] ??= document.paths["/api/v1/projects"].post.responses["200"];
delete document.paths["/api/v1/projects"].post.responses["200"];
document.paths["/api/v1/feed/current-summary"].get.tags = ["NoxFeed"];
for (const path of ["dashboard", "stat-events", "alerts", "alert-rules"]) {
  document.paths[`/api/v1/projects/{projectId}/cue/${path}`].get.tags = ["NoxCue"];
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

function automationScope(path, method) {
  const access = method === "get" ? "read" : "write";
  if (method === "get" && path === "/api/v1/services") return "services:read";
  const service = path.match(/^\/api\/v1\/services\/(noxfeed|noxspot|noxcue)(?:\/(?:setup|health))?$/)?.[1];
  if (method === "get" && service) return `${service}:read`;
  if (method === "get" && path === "/api/v1/feed") return "noxfeed:read";
  path = compatibilityApiPath(path);
  if (method === "get" && /^\/api\/(?:issues|prs)(?:\/|$)/.test(path)) return "noxfeed:read";
  if (/^\/api\/spots\/sites(?:\/|$)/.test(path)) return `noxspot:${access}`;
  if (/^\/api\/cues\/sources(?:\/|$)/.test(path)) return `noxcue:${access}`;
  if (method === "get" && (path === "/api/cues/events" || path === "/api/cues/metrics")) return "noxcue:read";
  if (/^\/api\/cues\/projects\/[^/]+\/metrics$/.test(path)) return `noxcue:${access}`;
  return null;
}

document.paths["/api/v1/cues/errors/{sourceId}/{fingerprint}"] = {
  put: {
    operationId: "updateNoxCueErrorStatus",
    summary: "Update an error incident status",
    description: "Acknowledge, resolve, or reopen one NoxCue error group in the optional project context.",
    parameters: [
      { name: "sourceId", in: "path", required: true, schema: { type: "string" } },
      { name: "fingerprint", in: "path", required: true, schema: { type: "string" } },
    ],
    requestBody: {
      required: true,
      content: { "application/json": { schema: {
        type: "object", additionalProperties: false, required: ["status"],
        properties: { status: { type: "string", enum: ["open", "acknowledged", "resolved"] } },
      } } },
    },
    responses: { "200": { description: "Error incident status updated" }, "404": { description: "Error incident not found" } },
    "x-required-role": "admin",
  },
};

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

delete document.components.schemas.NoxFeedConfigPatch?.properties?.projectScope;
setJsonSuccessSchema("/api/v1/feed", "get", "FeedPage");
for (const path of ["/api/v1/issues", "/api/v1/prs"]) setJsonSuccessSchema(path, "get", "RecordCollection");
for (const path of ["/api/v1/issues/{repo}/{number}", "/api/v1/prs/{repo}/{number}", "/api/v1/engineer-activity", "/api/v1/engineer-stats", "/api/v1/events", "/api/v1/events/{id}", "/api/v1/github/comments", "/api/v1/github/details", "/api/v1/search"]) {
  setJsonSuccessSchema(path, "get", "ApiRecord");
}
setJsonSuccessSchema("/api/v1/noxfeed/release-notes-prompt", "get", "ApiRecord");
setJsonSuccessSchema("/api/v1/llm-settings", "get", "ApiRecord");
setJsonSuccessSchema("/api/v1/llm-settings", "put", "MutationReceipt");
setJsonSuccessSchema("/api/v1/prs/close", "post", "MutationReceipt");
setJsonSuccessSchema("/api/v1/features", "get", "FeatureList");
setJsonSuccessSchema("/api/v1/features", "post", "Feature");
setJsonSuccessSchema("/api/v1/features/{number}", "patch", "Feature");
setJsonSuccessSchema("/api/v1/features/{number}", "delete", "MutationReceipt");
setJsonSuccessSchema("/api/v1/specs", "get", "SpecList");
setJsonSuccessSchema("/api/v1/specs", "post", "Spec");
setJsonSuccessSchema("/api/v1/specs/{specId}", "get", "Spec");
setJsonSuccessSchema("/api/v1/specs/{specId}", "patch", "Spec");
setJsonSuccessSchema("/api/v1/specs/{specId}/archive", "post", "MutationReceipt");
setJsonSuccessSchema("/api/v1/specs/{specId}/archive", "delete", "MutationReceipt");
setJsonSuccessSchema("/api/v1/specs/{specId}/attachments", "get", "SpecAttachmentList");
setJsonSuccessSchema("/api/v1/specs/{specId}/attachments", "post", "SpecAttachment");
setJsonSuccessSchema("/api/v1/specs/{specId}/attachments/{attachmentId}", "delete", "MutationReceipt");
setJsonSuccessSchema("/api/v1/assign", "post", "ApiRecord");
setJsonSuccessSchema("/api/v1/issue-state", "post", "MutationReceipt");

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
      for (const status of ["400", "401", "403", "409", "429"]) {
        operation.responses[status] ??= { "$ref": "#/components/responses/V1Error" };
      }
    }
    operation.tags = [serviceTag(path)];
    operation["x-authentication"] = authenticationFor(operation);
    delete operation["x-project-scope"];
    delete operation["x-automation-scope"];
    if (acceptsOptionalProjectContext(operation)) {
      operation.parameters ??= [];
      if (!operation.parameters.some((entry) => entry?.$ref === "#/components/parameters/projectContext")) {
        operation.parameters.unshift({ "$ref": "#/components/parameters/projectContext" });
      }
      operation["x-project-scope"] = "optional";
    }
    if (!isV1 && ["member", "admin"].includes(operation["x-authentication"])) {
      operation.responses["401"] ??= { description: "Authentication required" };
      operation.responses["403"] ??= { description: "Insufficient access" };
      if (/^\/api\/(?:features|specs|spots|cues)(?:\/|$)/.test(path) || path === "/api/v1/feed") {
        operation.responses["409"] ??= { description: "Product service is not enabled" };
      }
    }
    if (["member", "admin"].includes(operation["x-authentication"])) {
      const organization = operation["x-organization-optional"] ? false : true;
      const browser = { browserSession: [], ...(organization ? { organization: [] } : {}), ...(!["get", "head", "options"].includes(method) ? { csrfProof: [] } : {}) };
      const native = { nativeSession: [], ...(organization ? { organization: [] } : {}) };
      const scope = !operation["x-browser-session-only"] ? automationScope(path, method) : null;
      operation.security = operation["x-browser-session-only"] ? [browser] : [browser, native, ...(scope ? [{ noxApiToken: [] }] : [])];
      if (scope) operation["x-automation-scope"] = scope;
    } else if (operation["x-authentication"] === "platform_operator") {
      operation.security = [
        { browserSession: [], ...(!["get", "head", "options"].includes(method) ? { csrfProof: [] } : {}) },
        { nativeSession: [] },
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

function setJsonSuccessSchema(path, method, schemaName) {
  const operation = document.paths[path]?.[method];
  if (!operation) throw new Error(`Missing ${method.toUpperCase()} ${path} while assigning ${schemaName}`);
  for (const [status, response] of Object.entries(operation.responses ?? {})) {
    if (!status.startsWith("2") || status === "204") continue;
    response.content = { "application/json": { schema: { "$ref": `#/components/schemas/${schemaName}` } } };
  }
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
  if (/^\/api\/v1\/feed(?:\/|$)/.test(path)
      || /^\/api\/(?:issues|prs|events|engineer-activity|engineer-stats|search|llm-settings|noxfeed)(?:\/|$)/.test(compatibilityPath)
      || /^\/api\/github\/(?:comments|details)$/.test(compatibilityPath)) return "NoxFeed";
  if (compatibilityPath.startsWith("/api/spots")) return "NoxSpot";
  if (compatibilityPath.startsWith("/api/cues") || /^\/api\/v1\/projects\/[^/]+\/cue(?:\/|$)/.test(path)) return "NoxCue";
  return "NoxConnect";
}

function acceptsOptionalProjectContext(operation) {
  if (operation["x-authentication"] === "public" || operation["x-organization-optional"]) return false;
  return ["member", "admin"].includes(operation["x-authentication"]);
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
  if (["patchNoxServiceConfig", "updateNoxSpotResolutionTemplate"].includes(operationId)) return "conditional_write";
  if (operationId === "ingestNoxCueEvent") return "idempotent_with_event_key";
  if (method === "delete" || /disconnect|archive|close|revoke|delete/i.test(operationId)) return "destructive";
  return "write_not_safe_to_retry";
}
