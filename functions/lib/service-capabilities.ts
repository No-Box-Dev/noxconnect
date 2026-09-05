export const SERVICE_IDS = ["noxconnect", "noxticket", "noxfeed", "noxspot", "noxcue"] as const;

export type ServiceId = (typeof SERVICE_IDS)[number];
type OptionalServiceId = Exclude<ServiceId, "noxconnect">;
type ProviderId = "github" | "slack";
type CapabilityAccess = "member" | "admin";
type CapabilityState = "ready" | "blocked" | "disabled";
type SetupState = "ready" | "needs_setup" | "disabled";
type ConnectionState = "ready" | "connecting" | "disconnected" | "degraded" | "unavailable";

interface IntegrationStatus {
  github: {
    configured: boolean;
    connected: boolean;
    bootstrapping: boolean;
    health: string;
  };
  slack: {
    configured: boolean;
    connected: boolean;
    needsReconnect: boolean;
    health: string;
  };
}

interface CatalogInput {
  enabledApps: Record<OptionalServiceId, boolean>;
  integrations: IntegrationStatus;
}

interface CapabilityDefinition {
  id: string;
  name: string;
  description: string;
  access: CapabilityAccess;
  requires?: ProviderId[];
  operations: CapabilityOperation[];
}

interface CapabilityOperation {
  id: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  authentication: "member" | "admin" | "public" | "ingest_key";
  description: string;
}

interface SetupSectionDefinition {
  id: string;
  name: string;
  capabilityIds: string[];
}

interface ServiceDefinition {
  id: ServiceId;
  name: string;
  kind: "foundation" | "product";
  focus: string;
  description: string;
  requiredConnections: ProviderId[];
  optionalConnections: ProviderId[];
  capabilities: CapabilityDefinition[];
  setupSections: SetupSectionDefinition[];
}

const SERVICE_DEFINITIONS: ServiceDefinition[] = [
  {
    id: "noxconnect",
    name: "NoxConnect",
    kind: "foundation",
    focus: "Connections and shared workspace control",
    description: "Connects the organization to GitHub and Slack and provides identity, repositories, people, routing, and delivery infrastructure to every Nox service.",
    requiredConnections: ["github"],
    optionalConnections: ["slack"],
    capabilities: [
      { id: "connections", name: "Connections", description: "Connect and inspect GitHub organizations and Slack workspaces.", access: "admin", operations: [
        { id: "list_connections", method: "GET", path: "/api/integrations/connections", authentication: "member", description: "Inspect credential-free provider connection state." },
        { id: "start_connection", method: "POST", path: "/api/integrations/connections/{provider}/start", authentication: "admin", description: "Start a GitHub or Slack connection flow." },
        { id: "disconnect_connection", method: "POST", path: "/api/integrations/connections/{provider}/disconnect", authentication: "admin", description: "Disconnect a provider or return its provider-managed action." },
      ] },
      { id: "people", name: "People", description: "Manage the people and identities used throughout the workspace.", access: "admin", operations: [
        { id: "list_people", method: "GET", path: "/api/actors", authentication: "member", description: "List organization identities and voice overlays." },
        { id: "get_person", method: "GET", path: "/api/actors/{actorId}", authentication: "member", description: "Read one organization identity." },
        { id: "update_person", method: "PATCH", path: "/api/actors/{actorId}", authentication: "admin", description: "Update one organization identity overlay." },
      ] },
      { id: "repositories", name: "Repositories", description: "Discover repositories and choose which projects Nox tracks.", access: "admin", requires: ["github"], operations: [
        { id: "list_repositories", method: "GET", path: "/api/repos", authentication: "member", description: "List tracked or discovered repositories." },
        { id: "list_projects", method: "GET", path: "/api/projects", authentication: "member", description: "List project scopes backed by GitHub repositories." },
        { id: "acknowledge_repositories", method: "POST", path: "/api/repos/acknowledge", authentication: "admin", description: "Acknowledge newly discovered repositories." },
        { id: "set_project_archived", method: "POST", path: "/api/projects/{projectId}/archive", authentication: "admin", description: "Stop tracking a project without deleting it." },
        { id: "restore_project", method: "DELETE", path: "/api/projects/{projectId}/archive", authentication: "admin", description: "Resume tracking an eligible project." },
      ] },
      { id: "shared_delivery", name: "Shared delivery", description: "Choose Slack workspaces and fallback destinations used by Nox services.", access: "admin", requires: ["slack"], operations: [
        { id: "get_slack_routing", method: "GET", path: "/api/integrations/slack/routing", authentication: "admin", description: "Read shared and service-specific Slack routes." },
        { id: "patch_slack_routing", method: "PATCH", path: "/api/integrations/slack/routing", authentication: "admin", description: "Partially update Slack routes." },
        { id: "test_slack_route", method: "POST", path: "/api/integrations/slack/test", authentication: "admin", description: "Verify a saved or candidate Slack destination." },
      ] },
    ],
    setupSections: [
      { id: "connections", name: "Connections", capabilityIds: ["connections"] },
      { id: "workspace", name: "Workspace", capabilityIds: ["people", "repositories"] },
      { id: "delivery", name: "Delivery", capabilityIds: ["shared_delivery"] },
    ],
  },
  {
    id: "noxticket",
    name: "NoxTicket",
    kind: "product",
    focus: "Plan and organize delivery work",
    description: "Turns GitHub issues into a feature backlog, workflow board, and connected specification system.",
    requiredConnections: ["github"],
    optionalConnections: ["slack"],
    capabilities: [
      { id: "features", name: "Features", description: "Create, prioritize, assign, move, and close product features backed by GitHub issues.", access: "member", requires: ["github"], operations: [
        { id: "list_features", method: "GET", path: "/api/features", authentication: "member", description: "List the organization's feature backlog." },
        { id: "create_feature", method: "POST", path: "/api/features", authentication: "member", description: "Create a GitHub-backed feature." },
        { id: "update_feature", method: "PATCH", path: "/api/features/{number}", authentication: "member", description: "Update feature state, ownership, or metadata." },
        { id: "close_feature", method: "DELETE", path: "/api/features/{number}", authentication: "member", description: "Close a feature." },
      ] },
      { id: "workflow", name: "Workflow", description: "Configure the stages used by the feature board.", access: "admin", requires: ["github"], operations: [
        { id: "get_ticket_config", method: "GET", path: "/api/v1/services/noxticket/config", authentication: "member", description: "Read the feature repository and workflow stages." },
        { id: "patch_ticket_config", method: "PATCH", path: "/api/v1/services/noxticket/config", authentication: "admin", description: "Update the feature repository or workflow stages with If-Match." },
      ] },
      { id: "specs", name: "Specifications", description: "Create specifications, link them to features, and attach supporting files.", access: "member", requires: ["github"], operations: [
        { id: "list_specs", method: "GET", path: "/api/specs", authentication: "member", description: "List specifications." },
        { id: "create_spec", method: "POST", path: "/api/specs", authentication: "member", description: "Create a specification." },
        { id: "get_spec", method: "GET", path: "/api/specs/{specId}", authentication: "member", description: "Read one specification." },
        { id: "update_spec", method: "PATCH", path: "/api/specs/{specId}", authentication: "member", description: "Update or relink a specification." },
        { id: "archive_spec", method: "POST", path: "/api/specs/{specId}/archive", authentication: "admin", description: "Archive a specification." },
        { id: "restore_spec", method: "DELETE", path: "/api/specs/{specId}/archive", authentication: "admin", description: "Restore a specification." },
        { id: "list_spec_attachments", method: "GET", path: "/api/specs/{specId}/attachments", authentication: "member", description: "List specification attachments." },
        { id: "upload_spec_attachment", method: "POST", path: "/api/specs/{specId}/attachments", authentication: "member", description: "Attach a bounded document to a specification." },
        { id: "download_spec_attachment", method: "GET", path: "/api/specs/{specId}/attachments/{attachmentId}", authentication: "member", description: "Download a specification attachment." },
        { id: "delete_spec_attachment", method: "DELETE", path: "/api/specs/{specId}/attachments/{attachmentId}", authentication: "member", description: "Delete a specification attachment." },
      ] },
      { id: "ticket_delivery", name: "Slack delivery", description: "Send feature and backlog activity to a chosen Slack destination.", access: "admin", requires: ["github", "slack"], operations: [
        { id: "patch_ticket_route", method: "PATCH", path: "/api/integrations/slack/routing", authentication: "admin", description: "Set the noxticket Slack route." },
        { id: "test_ticket_route", method: "POST", path: "/api/integrations/slack/test", authentication: "admin", description: "Test the noxticket Slack route." },
      ] },
    ],
    setupSections: [
      { id: "workflow", name: "Workflow", capabilityIds: ["features", "workflow"] },
      { id: "storage", name: "Storage", capabilityIds: ["specs"] },
      { id: "delivery", name: "Delivery", capabilityIds: ["ticket_delivery"] },
    ],
  },
  {
    id: "noxfeed",
    name: "NoxFeed",
    kind: "product",
    focus: "Understand and communicate current work",
    description: "Combines GitHub issues, pull requests, engineering activity, narratives, and release notes into one team feed.",
    requiredConnections: ["github"],
    optionalConnections: ["slack"],
    capabilities: [
      { id: "current_work", name: "Current work", description: "See active pull requests, reviews, and issues across tracked repositories.", access: "member", requires: ["github"], operations: [
        { id: "get_feed", method: "GET", path: "/api/v1/feed", authentication: "member", description: "Read the normalized current-work feed." },
        { id: "list_issues", method: "GET", path: "/api/issues", authentication: "member", description: "List tracked GitHub issues." },
        { id: "get_issue", method: "GET", path: "/api/issues/{repo}/{number}", authentication: "member", description: "Read one tracked issue." },
        { id: "list_pull_requests", method: "GET", path: "/api/prs", authentication: "member", description: "List tracked pull requests." },
        { id: "get_pull_request", method: "GET", path: "/api/prs/{repo}/{number}", authentication: "member", description: "Read one tracked pull request." },
        { id: "close_pull_request", method: "POST", path: "/api/prs/close", authentication: "admin", description: "Close a pull request through GitHub." },
      ] },
      { id: "activity", name: "Engineering activity", description: "Browse normalized project and engineer activity over time.", access: "member", requires: ["github"], operations: [
        { id: "get_engineer_activity", method: "GET", path: "/api/engineer-activity", authentication: "member", description: "Read one engineer's normalized monthly activity." },
      ] },
      { id: "narratives", name: "Posts and release notes", description: "Create readable engineering updates and release narratives from GitHub events.", access: "admin", requires: ["github"], operations: [
        { id: "get_feed_narratives", method: "GET", path: "/api/v1/feed", authentication: "member", description: "Read generated posts and release notes." },
        { id: "patch_feed_config", method: "PATCH", path: "/api/v1/services/noxfeed/config", authentication: "admin", description: "Update project scope or the release-notes prompt with If-Match." },
        { id: "put_ai_settings", method: "PUT", path: "/api/llm-settings", authentication: "admin", description: "Choose the organization AI execution mode." },
      ] },
      { id: "feed_delivery", name: "Slack delivery", description: "Route posts and release notes to separate Slack destinations.", access: "admin", requires: ["github", "slack"], operations: [
        { id: "patch_feed_routes", method: "PATCH", path: "/api/integrations/slack/routing", authentication: "admin", description: "Set separate posts and release-notes routes." },
        { id: "test_feed_route", method: "POST", path: "/api/integrations/slack/test", authentication: "admin", description: "Test a NoxFeed Slack route." },
      ] },
    ],
    setupSections: [
      { id: "feed", name: "Feed", capabilityIds: ["current_work", "activity"] },
      { id: "narration", name: "Narration", capabilityIds: ["narratives"] },
      { id: "delivery", name: "Delivery", capabilityIds: ["feed_delivery"] },
    ],
  },
  {
    id: "noxspot",
    name: "NoxSpot",
    kind: "product",
    focus: "Capture actionable website feedback",
    description: "Adds a website feedback widget that captures reports, screenshots, page context, and delivery details for the team.",
    requiredConnections: ["github"],
    optionalConnections: ["slack"],
    capabilities: [
      { id: "sites", name: "Sites", description: "Register websites and manage their NoxSpot installation.", access: "admin", requires: ["github"], operations: [
        { id: "list_sites", method: "GET", path: "/api/spots/sites", authentication: "member", description: "List NoxSpot sites." },
        { id: "create_site", method: "POST", path: "/api/spots/sites", authentication: "admin", description: "Register a NoxSpot site." },
        { id: "update_site", method: "PATCH", path: "/api/spots/sites/{siteId}", authentication: "admin", description: "Update a site and its installation settings." },
        { id: "delete_site", method: "DELETE", path: "/api/spots/sites/{siteId}", authentication: "admin", description: "Delete a site and its screenshots." },
      ] },
      { id: "widget", name: "Feedback widget", description: "Configure how feedback is captured and which environments enable it.", access: "admin", requires: ["github"], operations: [
        { id: "get_widget_config", method: "GET", path: "https://api.noxspot.dev/api/spots/public/v1/sites/{siteId}/config", authentication: "public", description: "Resolve origin-bound public widget configuration." },
        { id: "update_widget_config", method: "PATCH", path: "/api/spots/sites/{siteId}", authentication: "admin", description: "Update environments, fields, and widget behavior." },
      ] },
      { id: "reports", name: "Reports and screenshots", description: "Turn captured feedback and browser context into actionable reports.", access: "member", requires: ["github"], operations: [
        { id: "submit_report", method: "POST", path: "https://api.noxspot.dev/api/spots/public/v1/reports", authentication: "public", description: "Submit bounded website feedback from an allowed origin." },
        { id: "submit_browser_errors", method: "POST", path: "https://api.noxspot.dev/api/spots/public/v1/errors", authentication: "public", description: "Submit a bounded batch of automatic browser errors." },
      ] },
      { id: "spot_delivery", name: "Slack delivery", description: "Route each site's feedback to its own Slack destination or the shared fallback.", access: "admin", requires: ["github", "slack"], operations: [
        { id: "update_site_delivery", method: "PATCH", path: "/api/spots/sites/{siteId}", authentication: "admin", description: "Set a site's Slack workspace and channel override." },
        { id: "retry_site_deliveries", method: "POST", path: "/api/spots/sites/{siteId}/retry-deliveries", authentication: "admin", description: "Retry blocked delivery for a site." },
      ] },
    ],
    setupSections: [
      { id: "sites", name: "Sites", capabilityIds: ["sites"] },
      { id: "capture", name: "Capture", capabilityIds: ["widget", "reports"] },
      { id: "delivery", name: "Delivery", capabilityIds: ["spot_delivery"] },
    ],
  },
  {
    id: "noxcue",
    name: "NoxCue",
    kind: "product",
    focus: "Monitor daily customer health",
    description: "Accepts bounded customer lifecycle and error events, derives daily health metrics, and delivers scheduled summaries to Slack.",
    requiredConnections: ["slack"],
    optionalConnections: [],
    capabilities: [
      { id: "sources", name: "Event sources", description: "Create sources for customer lifecycle and application error events.", access: "admin", requires: ["slack"], operations: [
        { id: "list_sources", method: "GET", path: "/api/cues/sources", authentication: "admin", description: "List NoxCue sources." },
        { id: "create_source", method: "POST", path: "/api/cues/sources", authentication: "admin", description: "Create a NoxCue source." },
        { id: "update_source", method: "PUT", path: "/api/cues/sources/{sourceId}", authentication: "admin", description: "Replace one source's configuration." },
        { id: "delete_source", method: "DELETE", path: "/api/cues/sources/{sourceId}", authentication: "admin", description: "Delete a source." },
      ] },
      { id: "ingest_keys", name: "Ingest keys", description: "Create and revoke scoped keys used by applications to submit events.", access: "admin", requires: ["slack"], operations: [
        { id: "create_ingest_key", method: "POST", path: "/api/cues/sources/{sourceId}/keys", authentication: "admin", description: "Create a one-time source ingest key." },
        { id: "revoke_ingest_key", method: "DELETE", path: "/api/cues/sources/{sourceId}/keys/{keyId}", authentication: "admin", description: "Revoke an ingest key." },
        { id: "ingest_event", method: "POST", path: "/api/cues/public/v1/events", authentication: "ingest_key", description: "Submit a bounded, idempotency-aware source event through the stable NoxConnect gateway." },
      ] },
      { id: "health_metrics", name: "Health metrics", description: "View registrations, active users, errors, and derived daily health history.", access: "admin", requires: ["slack"], operations: [
        { id: "list_cue_events", method: "GET", path: "/api/cues/events", authentication: "admin", description: "List recent normalized events and delivery state." },
        { id: "get_cue_metrics", method: "GET", path: "/api/cues/metrics", authentication: "admin", description: "Read daily customer-health metrics." },
      ] },
      { id: "cue_delivery", name: "Scheduled Slack delivery", description: "Choose the destination, timezone, and local delivery time for each source.", access: "admin", requires: ["slack"], operations: [
        { id: "configure_cue_delivery", method: "PUT", path: "/api/cues/sources/{sourceId}", authentication: "admin", description: "Set timezone, local digest time, workspace, and channel." },
        { id: "test_cue_route", method: "POST", path: "/api/integrations/slack/test", authentication: "admin", description: "Test the noxcue Slack route." },
      ] },
    ],
    setupSections: [
      { id: "sources", name: "Sources", capabilityIds: ["sources", "ingest_keys"] },
      { id: "health", name: "Health", capabilityIds: ["health_metrics"] },
      { id: "delivery", name: "Delivery", capabilityIds: ["cue_delivery"] },
    ],
  },
];

export function buildServiceCatalog({ enabledApps, integrations }: CatalogInput) {
  const connections = {
    github: githubState(integrations.github),
    slack: slackState(integrations.slack),
  } satisfies Record<ProviderId, ConnectionState>;

  return SERVICE_DEFINITIONS.map((definition) => {
    const enabled = definition.id === "noxconnect" || enabledApps[definition.id];
    const requiredBlockers = definition.requiredConnections.filter((provider) => connections[provider] !== "ready");
    const setupState: SetupState = !enabled
      ? "disabled"
      : requiredBlockers.length > 0
        ? "needs_setup"
        : "ready";

    return {
      id: definition.id,
      name: definition.name,
      kind: definition.kind,
      focus: definition.focus,
      description: definition.description,
      enabled,
      setup: {
        state: setupState,
        blockers: requiredBlockers.map((provider) => ({
          type: "connection" as const,
          provider,
          state: connections[provider],
        })),
        connections: [
          ...definition.requiredConnections.map((provider) => ({
            provider,
            requirement: "required" as const,
            state: connections[provider],
          })),
          ...definition.optionalConnections.map((provider) => ({
            provider,
            requirement: "optional" as const,
            state: connections[provider],
          })),
        ],
        sections: definition.setupSections,
      },
      capabilities: definition.capabilities.map((capability) => {
        const blockers = (capability.requires ?? []).filter((provider) => connections[provider] !== "ready");
        const state: CapabilityState = !enabled ? "disabled" : blockers.length > 0 ? "blocked" : "ready";
        return {
          id: capability.id,
          name: capability.name,
          description: capability.description,
          access: capability.access,
          state,
          requires: capability.requires ?? [],
          blockers,
          operations: capability.operations,
        };
      }),
      links: {
        self: `/api/v1/services/${definition.id}`,
        setup: `/api/v1/services/${definition.id}/setup`,
        config: `/api/v1/services/${definition.id}/config`,
        health: `/api/v1/services/${definition.id}/health`,
      },
    };
  });
}

export function isServiceId(value: string): value is ServiceId {
  return (SERVICE_IDS as readonly string[]).includes(value);
}

export function parseServiceId(value: unknown): ServiceId | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  return isServiceId(normalized) ? normalized : null;
}

function githubState(github: IntegrationStatus["github"]): ConnectionState {
  if (!github.configured) return "unavailable";
  if (!github.connected) return "disconnected";
  if (github.bootstrapping) return "connecting";
  if (github.health === "silent") return "degraded";
  return "ready";
}

function slackState(slack: IntegrationStatus["slack"]): ConnectionState {
  if (!slack.configured) return "unavailable";
  if (!slack.connected) return "disconnected";
  if (slack.needsReconnect || slack.health === "degraded") return "degraded";
  return "ready";
}
