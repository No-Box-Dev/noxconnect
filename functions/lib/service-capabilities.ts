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

export interface CapabilityDefinition {
  id: string;
  name: string;
  description: string;
  access: CapabilityAccess;
  requires?: ProviderId[];
  operations: CapabilityOperation[];
}

export interface CapabilityOperation {
  id: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  authentication: "member" | "admin" | "public" | "ingest_key";
  description: string;
}

export interface SetupSectionDefinition {
  id: string;
  name: string;
  capabilityIds: string[];
}

export interface ServiceDefinition {
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

export const SERVICE_DEFINITIONS: ServiceDefinition[] = [
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
        { id: "list_connections", method: "GET", path: "/api/v1/integrations/connections", authentication: "member", description: "Inspect credential-free provider connection state." },
        { id: "start_connection", method: "POST", path: "/api/v1/integrations/connections/{provider}/start", authentication: "admin", description: "Start a GitHub or Slack connection flow." },
        { id: "disconnect_connection", method: "POST", path: "/api/v1/integrations/connections/{provider}/disconnect", authentication: "admin", description: "Disconnect a provider or return its provider-managed action." },
      ] },
      { id: "people", name: "People", description: "Manage the people and identities used throughout the workspace.", access: "admin", operations: [
        { id: "get_current_member", method: "GET", path: "/api/v1/me", authentication: "member", description: "Read the current organization membership and NoxConnect role." },
        { id: "list_members", method: "GET", path: "/api/v1/members", authentication: "member", description: "List connected GitHub organization members." },
        { id: "list_teams", method: "GET", path: "/api/v1/teams", authentication: "member", description: "List connected GitHub organization teams." },
        { id: "list_people", method: "GET", path: "/api/v1/actors", authentication: "member", description: "List organization identities and voice overlays." },
        { id: "get_person", method: "GET", path: "/api/v1/actors/{actorId}", authentication: "member", description: "Read one organization identity." },
        { id: "update_person", method: "PATCH", path: "/api/v1/actors/{actorId}", authentication: "admin", description: "Update one organization identity overlay." },
      ] },
      { id: "repositories", name: "Repositories", description: "Discover repositories and choose which projects Nox tracks.", access: "admin", requires: ["github"], operations: [
        { id: "list_repositories", method: "GET", path: "/api/v1/repos", authentication: "member", description: "List tracked or discovered repositories." },
        { id: "list_projects", method: "GET", path: "/api/v1/projects", authentication: "member", description: "List project scopes backed by GitHub repositories." },
        { id: "acknowledge_repositories", method: "POST", path: "/api/v1/repos/acknowledge", authentication: "admin", description: "Acknowledge newly discovered repositories." },
        { id: "set_project_archived", method: "POST", path: "/api/v1/projects/{projectId}/archive", authentication: "admin", description: "Stop tracking a project without deleting it." },
        { id: "restore_project", method: "DELETE", path: "/api/v1/projects/{projectId}/archive", authentication: "admin", description: "Resume tracking an eligible project." },
        { id: "get_sync_status", method: "GET", path: "/api/v1/sync", authentication: "member", description: "Read GitHub synchronization freshness." },
        { id: "sync_github_data", method: "POST", path: "/api/v1/sync", authentication: "admin", description: "Synchronize bounded GitHub data." },
      ] },
      { id: "shared_delivery", name: "Shared delivery", description: "Choose Slack workspaces and fallback destinations used by Nox services.", access: "admin", requires: ["slack"], operations: [
        { id: "get_slack_routing", method: "GET", path: "/api/v1/integrations/slack/routing", authentication: "admin", description: "Read shared and service-specific Slack routes." },
        { id: "patch_slack_routing", method: "PATCH", path: "/api/v1/integrations/slack/routing", authentication: "admin", description: "Partially update Slack routes." },
        { id: "test_slack_route", method: "POST", path: "/api/v1/integrations/slack/test", authentication: "admin", description: "Verify a saved or candidate Slack destination." },
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
        { id: "list_features", method: "GET", path: "/api/v1/features", authentication: "member", description: "List the organization's feature backlog." },
        { id: "create_feature", method: "POST", path: "/api/v1/features", authentication: "member", description: "Create a GitHub-backed feature." },
        { id: "update_feature", method: "PATCH", path: "/api/v1/features/{number}", authentication: "member", description: "Update feature state, ownership, or metadata." },
        { id: "assign_feature", method: "POST", path: "/api/v1/assign", authentication: "member", description: "Assign a feature's backing GitHub issue." },
        { id: "set_feature_state", method: "POST", path: "/api/v1/issue-state", authentication: "member", description: "Open or close a feature's backing GitHub issue." },
        { id: "close_feature", method: "DELETE", path: "/api/v1/features/{number}", authentication: "member", description: "Close a feature." },
      ] },
      { id: "workflow", name: "Workflow", description: "Configure the stages used by the feature board.", access: "admin", requires: ["github"], operations: [
        { id: "get_ticket_config", method: "GET", path: "/api/v1/services/noxticket/config", authentication: "member", description: "Read the feature repository and workflow stages." },
        { id: "patch_ticket_config", method: "PATCH", path: "/api/v1/services/noxticket/config", authentication: "admin", description: "Update the feature repository or workflow stages with If-Match." },
      ] },
      { id: "specs", name: "Specifications", description: "Create specifications, link them to features, and attach supporting files.", access: "member", requires: ["github"], operations: [
        { id: "list_specs", method: "GET", path: "/api/v1/specs", authentication: "member", description: "List specifications." },
        { id: "create_spec", method: "POST", path: "/api/v1/specs", authentication: "member", description: "Create a specification." },
        { id: "get_spec", method: "GET", path: "/api/v1/specs/{specId}", authentication: "member", description: "Read one specification." },
        { id: "update_spec", method: "PATCH", path: "/api/v1/specs/{specId}", authentication: "member", description: "Update or relink a specification." },
        { id: "archive_spec", method: "POST", path: "/api/v1/specs/{specId}/archive", authentication: "admin", description: "Archive a specification." },
        { id: "restore_spec", method: "DELETE", path: "/api/v1/specs/{specId}/archive", authentication: "admin", description: "Restore a specification." },
        { id: "list_spec_attachments", method: "GET", path: "/api/v1/specs/{specId}/attachments", authentication: "member", description: "List specification attachments." },
        { id: "upload_spec_attachment", method: "POST", path: "/api/v1/specs/{specId}/attachments", authentication: "member", description: "Attach a bounded document to a specification." },
        { id: "download_spec_attachment", method: "GET", path: "/api/v1/specs/{specId}/attachments/{attachmentId}", authentication: "member", description: "Download a specification attachment." },
        { id: "delete_spec_attachment", method: "DELETE", path: "/api/v1/specs/{specId}/attachments/{attachmentId}", authentication: "member", description: "Delete a specification attachment." },
      ] },
      { id: "ticket_delivery", name: "Slack delivery", description: "Send feature and backlog activity to a chosen Slack destination.", access: "admin", requires: ["github", "slack"], operations: [
        { id: "patch_ticket_route", method: "PATCH", path: "/api/v1/integrations/slack/routing", authentication: "admin", description: "Set the noxticket Slack route." },
        { id: "test_ticket_route", method: "POST", path: "/api/v1/integrations/slack/test", authentication: "admin", description: "Test the noxticket Slack route." },
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
        { id: "list_issues", method: "GET", path: "/api/v1/issues", authentication: "member", description: "List tracked GitHub issues." },
        { id: "get_issue", method: "GET", path: "/api/v1/issues/{repo}/{number}", authentication: "member", description: "Read one tracked issue." },
        { id: "list_pull_requests", method: "GET", path: "/api/v1/prs", authentication: "member", description: "List tracked pull requests." },
        { id: "get_pull_request", method: "GET", path: "/api/v1/prs/{repo}/{number}", authentication: "member", description: "Read one tracked pull request." },
        { id: "list_detailed_events", method: "GET", path: "/api/v1/events", authentication: "member", description: "List detailed feed events for native and web clients." },
        { id: "search_current_work", method: "GET", path: "/api/v1/search", authentication: "member", description: "Search tracked work and people." },
        { id: "get_github_details", method: "GET", path: "/api/v1/github/details", authentication: "member", description: "Read live details for a tracked issue or pull request." },
        { id: "get_pull_request_comments", method: "GET", path: "/api/v1/github/comments", authentication: "member", description: "Read comments for a tracked pull request." },
        { id: "close_pull_request", method: "POST", path: "/api/v1/prs/close", authentication: "admin", description: "Close a pull request through GitHub." },
      ] },
      { id: "activity", name: "Engineering activity", description: "Browse normalized project and engineer activity over time.", access: "member", requires: ["github"], operations: [
        { id: "get_engineer_stats", method: "GET", path: "/api/v1/engineer-stats", authentication: "member", description: "Read current work counts by engineer." },
        { id: "get_engineer_activity", method: "GET", path: "/api/v1/engineer-activity", authentication: "member", description: "Read one engineer's normalized monthly activity." },
      ] },
      { id: "narratives", name: "Posts and release notes", description: "Create readable engineering updates and release narratives from GitHub events.", access: "admin", requires: ["github"], operations: [
        { id: "get_feed_narratives", method: "GET", path: "/api/v1/feed", authentication: "member", description: "Read generated posts and release notes." },
        { id: "get_default_release_prompt", method: "GET", path: "/api/v1/noxfeed/release-notes-prompt", authentication: "admin", description: "Read the server-owned default release-notes prompt." },
        { id: "patch_feed_config", method: "PATCH", path: "/api/v1/services/noxfeed/config", authentication: "admin", description: "Update project scope or the release-notes prompt with If-Match." },
        { id: "put_ai_settings", method: "PUT", path: "/api/v1/llm-settings", authentication: "admin", description: "Choose the organization AI execution mode." },
      ] },
      { id: "feed_delivery", name: "Slack delivery", description: "Route posts and release notes to separate Slack destinations.", access: "admin", requires: ["github", "slack"], operations: [
        { id: "patch_feed_routes", method: "PATCH", path: "/api/v1/integrations/slack/routing", authentication: "admin", description: "Set separate posts and release-notes routes." },
        { id: "test_feed_route", method: "POST", path: "/api/v1/integrations/slack/test", authentication: "admin", description: "Test a NoxFeed Slack route." },
      ] },
      { id: "feed_maintenance", name: "History maintenance", description: "Recover or regenerate bounded project history.", access: "admin", requires: ["github"], operations: [
        { id: "backfill_project_pull_requests", method: "POST", path: "/api/v1/projects/{projectId}/backfill-prs", authentication: "admin", description: "Queue bounded pull-request history for one project." },
      ] },
    ],
    setupSections: [
      { id: "feed", name: "Feed", capabilityIds: ["current_work", "activity", "feed_maintenance"] },
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
        { id: "list_sites", method: "GET", path: "/api/v1/spots/sites", authentication: "member", description: "List NoxSpot sites." },
        { id: "create_site", method: "POST", path: "/api/v1/spots/sites", authentication: "admin", description: "Register a NoxSpot site." },
        { id: "update_site", method: "PATCH", path: "/api/v1/spots/sites/{siteId}", authentication: "admin", description: "Update a site and its installation settings." },
        { id: "delete_site", method: "DELETE", path: "/api/v1/spots/sites/{siteId}", authentication: "admin", description: "Delete a site and its screenshots." },
      ] },
      { id: "widget", name: "Feedback widget", description: "Configure how feedback is captured and which environments enable it.", access: "admin", requires: ["github"], operations: [
        { id: "get_widget_config", method: "GET", path: "https://api.noxspot.dev/api/spots/public/v1/sites/{siteId}/config", authentication: "public", description: "Resolve origin-bound public widget configuration." },
        { id: "update_widget_config", method: "PATCH", path: "/api/v1/spots/sites/{siteId}", authentication: "admin", description: "Update environments, fields, and widget behavior." },
      ] },
      { id: "reports", name: "Reports and screenshots", description: "Turn captured feedback and browser context into actionable reports.", access: "member", requires: ["github"], operations: [
        { id: "submit_report", method: "POST", path: "https://api.noxspot.dev/api/spots/public/v1/reports", authentication: "public", description: "Submit bounded website feedback from an allowed origin." },
        { id: "submit_browser_errors", method: "POST", path: "https://api.noxspot.dev/api/spots/public/v1/errors", authentication: "public", description: "Submit a bounded batch of automatic browser errors." },
      ] },
      { id: "spot_sharing", name: "External project sharing", description: "Create password-protected project portals without exposing NoxConnect credentials.", access: "admin", requires: ["github"], operations: [
        { id: "upsert_spot_share", method: "POST", path: "/api/v1/spots/shares", authentication: "admin", description: "Create or rotate a password-protected project share." },
        { id: "delete_spot_share", method: "DELETE", path: "/api/v1/spots/shares/{shareId}", authentication: "admin", description: "Disable a project share and revoke its sessions." },
      ] },
      { id: "spot_delivery", name: "Slack delivery", description: "Route each site's feedback to its own Slack destination or the shared fallback.", access: "admin", requires: ["github", "slack"], operations: [
        { id: "update_site_delivery", method: "PATCH", path: "/api/v1/spots/sites/{siteId}", authentication: "admin", description: "Set a site's Slack workspace and channel override." },
        { id: "retry_site_deliveries", method: "POST", path: "/api/v1/spots/sites/{siteId}/retry-deliveries", authentication: "admin", description: "Retry blocked delivery for a site." },
      ] },
    ],
    setupSections: [
      { id: "sites", name: "Sites", capabilityIds: ["sites"] },
      { id: "capture", name: "Capture", capabilityIds: ["widget", "reports", "spot_sharing"] },
      { id: "delivery", name: "Delivery", capabilityIds: ["spot_delivery"] },
    ],
  },
  {
    id: "noxcue",
    name: "NoxCue",
    kind: "product",
    focus: "Monitor daily customer health",
    description: "Accepts bounded customer lifecycle and error events, derives daily health metrics, delivers scheduled summaries to Slack, and can route incidents into project GitHub issues.",
    requiredConnections: ["slack"],
    optionalConnections: ["github"],
    capabilities: [
      { id: "sources", name: "Event sources", description: "Create sources for customer lifecycle and application error events.", access: "admin", requires: ["slack"], operations: [
        { id: "list_sources", method: "GET", path: "/api/v1/cues/sources", authentication: "admin", description: "List NoxCue sources." },
        { id: "create_source", method: "POST", path: "/api/v1/cues/sources", authentication: "admin", description: "Create a NoxCue source." },
        { id: "update_source", method: "PUT", path: "/api/v1/cues/sources/{sourceId}", authentication: "admin", description: "Replace one source's configuration." },
        { id: "delete_source", method: "DELETE", path: "/api/v1/cues/sources/{sourceId}", authentication: "admin", description: "Delete a source." },
        { id: "test_source_health", method: "POST", path: "/api/v1/cues/sources/{sourceId}/health/test", authentication: "admin", description: "Test the source's configured health destination." },
      ] },
      { id: "ingest_keys", name: "Ingest keys", description: "Create and revoke scoped keys used by applications to submit events.", access: "admin", requires: ["slack"], operations: [
        { id: "create_ingest_key", method: "POST", path: "/api/v1/cues/sources/{sourceId}/keys", authentication: "admin", description: "Create a one-time source ingest key." },
        { id: "revoke_ingest_key", method: "DELETE", path: "/api/v1/cues/sources/{sourceId}/keys/{keyId}", authentication: "admin", description: "Revoke an ingest key." },
        { id: "ingest_event", method: "POST", path: "/api/v1/cues/public/events", authentication: "ingest_key", description: "Submit a bounded, idempotency-aware source event through the stable NoxConnect gateway." },
      ] },
      { id: "health_metrics", name: "Health metrics", description: "View registrations, active users, errors, and derived daily health history.", access: "admin", requires: ["slack"], operations: [
        { id: "list_cue_events", method: "GET", path: "/api/v1/cues/events", authentication: "admin", description: "List recent normalized events and delivery state." },
        { id: "get_cue_metrics", method: "GET", path: "/api/v1/cues/metrics", authentication: "admin", description: "Read daily customer-health metrics." },
      ] },
      { id: "github_incidents", name: "GitHub incidents", description: "Route qualifying NoxCue incidents into the GitHub repository linked to each project.", access: "admin", requires: ["github"], operations: [
        { id: "get_cue_github_incident_settings", method: "GET", path: "/api/v1/cues/github-issues", authentication: "admin", description: "List project repository mappings, incident policy, and open incident counts." },
        { id: "put_cue_github_incident_settings", method: "PUT", path: "/api/v1/cues/github-issues", authentication: "admin", description: "Set the environments, repeat policy, and enabled state for one project's GitHub incidents." },
      ] },
      { id: "cue_sharing", name: "Customer-health sharing", description: "Create password-protected customer-health dashboards without exposing NoxConnect credentials.", access: "admin", operations: [
        { id: "list_cue_shares", method: "GET", path: "/api/v1/cues/shares", authentication: "admin", description: "List active customer-health dashboard shares." },
        { id: "upsert_cue_share", method: "POST", path: "/api/v1/cues/shares", authentication: "admin", description: "Create or rotate a customer-health dashboard share." },
        { id: "delete_cue_share", method: "DELETE", path: "/api/v1/cues/shares/{shareId}", authentication: "admin", description: "Disable a customer-health dashboard share and revoke its sessions." },
      ] },
      { id: "cue_delivery", name: "Scheduled Slack delivery", description: "Choose the destination, timezone, and local delivery time for each source.", access: "admin", requires: ["slack"], operations: [
        { id: "configure_cue_delivery", method: "PUT", path: "/api/v1/cues/sources/{sourceId}", authentication: "admin", description: "Set timezone, local digest time, workspace, and channel." },
        { id: "test_cue_route", method: "POST", path: "/api/v1/integrations/slack/test", authentication: "admin", description: "Test the noxcue Slack route." },
      ] },
    ],
    setupSections: [
      { id: "sources", name: "Sources", capabilityIds: ["sources", "ingest_keys"] },
      { id: "health", name: "Health", capabilityIds: ["health_metrics", "cue_sharing"] },
      { id: "incidents", name: "GitHub incidents", capabilityIds: ["github_incidents"] },
      { id: "delivery", name: "Delivery", capabilityIds: ["cue_delivery"] },
    ],
  },
];

export function buildServiceCatalog({
  enabledApps,
  integrations,
  definitions = SERVICE_DEFINITIONS,
  runtimeStates = {},
}: CatalogInput & {
  definitions?: ServiceDefinition[];
  runtimeStates?: Partial<Record<ServiceId, { state: "ready" | "unavailable"; source: "binding" | "snapshot" }>>;
}) {
  const connections = {
    github: githubState(integrations.github),
    slack: slackState(integrations.slack),
  } satisfies Record<ProviderId, ConnectionState>;

  return definitions.map((definition) => {
    const enabled = definition.id === "noxconnect" || enabledApps[definition.id];
    const runtime = runtimeStates[definition.id] ?? {
      state: definition.id === "noxconnect" ? "ready" as const : "unavailable" as const,
      source: definition.id === "noxconnect" ? "binding" as const : "snapshot" as const,
    };
    const runtimeReady = runtime.state === "ready";
    const requiredBlockers = definition.requiredConnections.filter((provider) => connections[provider] !== "ready");
    const setupState: SetupState = !enabled
      ? "disabled"
      : !runtimeReady || requiredBlockers.length > 0
        ? "needs_setup"
        : "ready";

    return {
      id: definition.id,
      name: definition.name,
      kind: definition.kind,
      focus: definition.focus,
      description: definition.description,
      runtime,
      enabled,
      setup: {
        state: setupState,
        blockers: [
          ...(!runtimeReady ? [{ type: "runtime" as const, state: runtime.state }] : []),
          ...requiredBlockers.map((provider) => ({
            type: "connection" as const,
            provider,
            state: connections[provider],
          })),
        ],
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
        const state: CapabilityState = !enabled
          ? "disabled"
          : !runtimeReady || blockers.length > 0
            ? "blocked"
            : "ready";
        return {
          id: capability.id,
          name: capability.name,
          description: capability.description,
          access: capability.access,
          state,
          requires: capability.requires ?? [],
          blockers: runtimeReady ? blockers : ["service_runtime", ...blockers],
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
