import { LEGACY_NOXTICKET_SOURCE } from "./naming-compat.js";
import { compatibilityApiPath } from "./api-paths.js";

export const OPTIONAL_APP_IDS = ["noxticket", "noxfeed", "noxspot", "noxcue"];

const APP_SET = new Set(OPTIONAL_APP_IDS);

export function parseAppSettings(rawSettings) {
  let settings = rawSettings;
  if (typeof rawSettings === "string") {
    try { settings = JSON.parse(rawSettings); }
    catch { settings = null; }
  }
  const apps = settings && typeof settings === "object" && !Array.isArray(settings)
    ? settings.apps
    : null;
  return Object.fromEntries(OPTIONAL_APP_IDS.map((appId) => [
    appId,
    !(apps && typeof apps === "object" && !Array.isArray(apps) && apps[appId] === false),
  ]));
}

/** @param {string | null} [projectId] */
export async function getEnabledApps(db, orgId, projectId = null) {
  if (projectId) {
    const projectRow = await db.prepare(
      "SELECT data FROM project_config WHERE org_id = ? AND project_id = ? AND key = 'settings'",
    ).bind(orgId, projectId).first();
    if (projectRow) return parseAppSettings(projectRow.data);
  }
  const row = await db.prepare(
    "SELECT data FROM config WHERE org_id = ? AND key = 'settings'",
  ).bind(orgId).first();
  return parseAppSettings(row?.data);
}

/** @param {string | null} [projectId] */
export async function isAppEnabled(db, orgId, appId, projectId = null) {
  if (!APP_SET.has(appId)) return true;
  const apps = await getEnabledApps(db, orgId, projectId);
  return apps[appId] !== false;
}

/** @param {string | null} [projectId] */
export async function isAppEnabledForOwner(db, ownerId, appId, projectId = null) {
  const org = await db.prepare(
    "SELECT id FROM orgs WHERE github_login = ? LIMIT 1",
  ).bind(ownerId).first();
  return org?.id ? isAppEnabled(db, org.id, appId, projectId) : true;
}

export function appForApiPath(pathname) {
  pathname = compatibilityApiPath(pathname);
  if (/^\/api\/config(?:\/|$)/.test(pathname)) return "noxconnect";
  if (/^\/api\/(?:features|specs|assign|issue-state)(?:\/|$)/.test(pathname)) {
    return "noxticket";
  }
  if (pathname === "/api/v1/feed"
      || /^\/api\/(?:issues|prs|events|engineer-activity|engineer-stats|search|llm-settings|noxfeed)(?:\/|$)/.test(pathname)
      || /^\/api\/github\/(?:comments|details)$/.test(pathname)
      || /^\/api\/projects\/[^/]+\/backfill-prs$/.test(pathname)) {
    return "noxfeed";
  }
  if (/^\/api\/spots(?:\/|$)/.test(pathname)) return "noxspot";
  if (/^\/api\/cues(?:\/|$)/.test(pathname)) return "noxcue";
  return null;
}

export function appForDeliverySource(source) {
  if (source === "noxticket" || source === LEGACY_NOXTICKET_SOURCE) return "noxticket";
  if (source === "posts" || source === "release_notes" || source === "noxfeed_daily_summary") return "noxfeed";
  if (source === "noxspot") return "noxspot";
  if (source === "noxcue") return "noxcue";
  return null;
}

export function appForSlackKind(kind) {
  if (kind === "noxticket") return "noxticket";
  if (kind === "noxfeed" || kind === "noxfeed_posts" || kind === "noxfeed_release_notes" || kind === "noxfeed_daily_summary" || kind === "narrative" || kind === "release_notes") {
    return "noxfeed";
  }
  if (kind === "noxspot") return "noxspot";
  if (kind === "noxcue" || kind === "noxcue_alerts") return "noxcue";
  return null;
}

export function serviceDisabledResponse(appId) {
  const names = { noxticket: "NoxTicket", noxfeed: "NoxFeed", noxspot: "NoxSpot", noxcue: "NoxCue" };
  const name = names[appId] ?? appId;
  return new Response(JSON.stringify({
    error: `${name} is not enabled. Enable it in NoxConnect before trying again.`,
    code: "service_not_enabled",
    service: appId,
    remediation: { action: "enable_service", href: `/api/v1/services/${appId}/config` },
  }), {
    status: 409,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
