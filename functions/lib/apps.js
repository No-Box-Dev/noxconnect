import { LEGACY_NOXTICKET_SOURCE } from "./naming-compat.js";

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

export async function getEnabledApps(db, orgId) {
  const row = await db.prepare(
    "SELECT data FROM config WHERE org_id = ? AND key = 'settings'",
  ).bind(orgId).first();
  return parseAppSettings(row?.data);
}

export async function isAppEnabled(db, orgId, appId) {
  if (!APP_SET.has(appId)) return true;
  const apps = await getEnabledApps(db, orgId);
  return apps[appId] !== false;
}

export async function isAppEnabledForOwner(db, ownerId, appId) {
  const org = await db.prepare(
    "SELECT id FROM orgs WHERE github_login = ? LIMIT 1",
  ).bind(ownerId).first();
  return org?.id ? isAppEnabled(db, org.id, appId) : true;
}

export function appForApiPath(pathname) {
  if (/^\/api\/features(?:\/|$)/.test(pathname) || /^\/api\/specs(?:\/|$)/.test(pathname)) {
    return "noxticket";
  }
  if (pathname === "/api/v1/feed" || /^\/api\/projects\/[^/]+\/backfill-prs$/.test(pathname)) {
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
  }), {
    status: 403,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
