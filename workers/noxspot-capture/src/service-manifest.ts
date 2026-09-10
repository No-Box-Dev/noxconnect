export const NOXSPOT_SERVICE_MANIFEST = {
  contract: "nox.service-manifest",
  version: 1,
  service: {
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
  configuration: {
    schemaVersion: 1,
    mode: "resource",
    writable: false,
    writableFields: [],
  },
} as const;
