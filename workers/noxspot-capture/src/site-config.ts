import { DEFAULT_NOXSPOT_BLOCKS } from "../../../shared/noxspot-defaults";

export type WidgetMode = "development" | "release";

export interface WidgetEnvironment {
  name: string;
  url: string;
  buttonColor?: string | null;
  buttonText?: string | null;
  widgetMode?: WidgetMode | null;
  enabled?: boolean;
}

export interface WidgetBlock {
  id?: string;
  type?: string;
  environments?: string[];
  [key: string]: unknown;
}

export interface WidgetConfig {
  buttonColor?: string;
  buttonText?: string;
  widgetMode?: WidgetMode;
  autoErrorLogging?: boolean;
  environments?: WidgetEnvironment[];
  blocks?: WidgetBlock[];
}

export interface CaptureSite {
  id: string;
  org_id: number;
  project_id: string | null;
  repo: string;
  site_name: string;
  widget_config: string | null;
  slack_channel_id: string | null;
  slack_connection_id: string | null;
  github_login: string;
  // Optional keeps older fixtures and local callers compatible. Only an
  // explicit zero disables a service; missing settings remain on.
  noxspot_enabled?: number;
  noxalert_enabled?: number;
}

export function parseWidgetConfig(value: string | null | undefined): WidgetConfig {
  try {
    const parsed: unknown = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as WidgetConfig : {};
  } catch {
    return {};
  }
}

export async function getCaptureSite(db: D1Database, siteId: string): Promise<CaptureSite | null> {
  return db.prepare(
    `SELECT site.id, site.org_id, site.project_id, site.repo, site.name AS site_name,
            site.widget_config, site.slack_channel_id, site.slack_connection_id,
            org.github_login,
            CASE
              WHEN settings.data IS NULL OR json_valid(settings.data) = 0 THEN 1
              WHEN json_extract(settings.data, '$.apps.noxspot') = 0 THEN 0
              ELSE 1
            END AS noxspot_enabled,
            CASE
              WHEN settings.data IS NULL OR json_valid(settings.data) = 0 THEN 1
              WHEN json_extract(settings.data, '$.apps.noxalert') = 0 THEN 0
              ELSE 1
            END AS noxalert_enabled
       FROM spot_sites site
       JOIN orgs org ON org.id = site.org_id
       LEFT JOIN config settings ON settings.org_id = site.org_id AND settings.key = 'settings'
      WHERE site.id = ?`,
  ).bind(siteId).first<CaptureSite>();
}

function configuredHost(value: string): { hostname: string; port: string } | null {
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    return { hostname: url.hostname.toLowerCase(), port: url.port };
  } catch {
    return null;
  }
}

export function requestOrigin(request: Request): string | null {
  const origin = request.headers.get("Origin");
  if (origin && origin !== "null") {
    try { return new URL(origin).origin; } catch { return null; }
  }
  const referer = request.headers.get("Referer");
  if (!referer) return null;
  try { return new URL(referer).origin; } catch { return null; }
}

export function environmentForOrigin(config: WidgetConfig, origin: string | null): WidgetEnvironment | null {
  const environments = Array.isArray(config.environments) ? config.environments : [];
  if (!environments.length || !origin) return null;

  let current: URL;
  try { current = new URL(origin); } catch { return null; }
  const currentHost = current.hostname.toLowerCase();
  return environments.find((environment) => {
    if (!environment || typeof environment.url !== "string") return false;
    const configured = configuredHost(environment.url);
    if (!configured) return false;
    const hostMatches = currentHost === configured.hostname || currentHost.endsWith(`.${configured.hostname}`);
    return hostMatches && (!configured.port || configured.port === current.port);
  }) ?? null;
}

export function originAllowed(config: WidgetConfig, origin: string | null): boolean {
  const environments = Array.isArray(config.environments) ? config.environments : [];
  if (!environments.length) return true;
  const environment = environmentForOrigin(config, origin);
  return Boolean(environment && environment.enabled !== false);
}

export function publicWidgetConfig(site: CaptureSite, origin: string | null) {
  const stored = parseWidgetConfig(site.widget_config);
  const matched = environmentForOrigin(stored, origin);
  const environmentName = matched?.name ?? null;
  const configuredBlocks: readonly WidgetBlock[] = Array.isArray(stored.blocks) && stored.blocks.length
    ? stored.blocks
    : DEFAULT_NOXSPOT_BLOCKS;
  const blocks = configuredBlocks.filter((block) =>
    !Array.isArray(block.environments) || block.environments.length === 0 ||
    (environmentName !== null && block.environments.includes(environmentName)),
  );

  return {
    version: 1,
    siteId: site.id,
    buttonColor: matched?.buttonColor || stored.buttonColor || "#FE795D",
    buttonText: matched?.buttonText || stored.buttonText || "Report issue",
    widgetMode: matched?.widgetMode || (stored.widgetMode === "release" ? "release" : "development"),
    autoErrorLogging: stored.autoErrorLogging === true,
    environment: environmentName,
    // The current widget matches environments client-side. Return only the
    // effective environment instead of exposing every internal/dev hostname.
    environments: matched ? [matched] : [],
    blocks,
  };
}

export function legacyWidgetConfig(site: CaptureSite) {
  const stored = parseWidgetConfig(site.widget_config);
  return {
    version: 1,
    siteId: site.id,
    buttonColor: stored.buttonColor || "#FE795D",
    buttonText: stored.buttonText || "Report issue",
    widgetMode: stored.widgetMode === "release" ? "release" : "development",
    autoErrorLogging: stored.autoErrorLogging === true,
    environments: Array.isArray(stored.environments) ? stored.environments : [],
    blocks: Array.isArray(stored.blocks) && stored.blocks.length ? stored.blocks : DEFAULT_NOXSPOT_BLOCKS,
  };
}
