// Slack posting for every Nox product via shared NoxConnect installations.
//
// Per-org install: each workspace's bot token + team metadata lives in the
// `slack_connections` table (tokens encrypted with ENCRYPTION_KEY). The
// Integrations JSON carries only public workspace + channel selections.
//
// Auth model: the admin clicks "Connect Slack" in Integrations → OAuth dance →
// callback stores the bot token. Posting uses `chat.postMessage` against
// that token rather than the webhook URLs the v1 of this feature used.

import { z } from "zod";
import { decryptToken, encryptToken } from "./crypto";
import { normalizeNoxSettings } from "./naming-compat.js";

const SLACK_API = "https://slack.com";
const TIMEOUT_MS = 5000;

// Max age (seconds) for a Slack Events API request. Slack recommends 5min
// — anything older is a replay attempt and we drop it.
const EVENTS_MAX_AGE_S = 60 * 5;

export class SlackApiError extends Error {
  constructor(message, { code = "slack_error", status = null, retryAfter = null } = {}) {
    super(message);
    this.name = "SlackApiError";
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export function actionableSlackError(error, fallback = "Check the selected Slack workspace and channel, then try again.") {
  const code = String(error?.code ?? "").toLowerCase();
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const normalized = `${code} ${raw}`.toLowerCase();

  if (normalized.includes("channel_not_found")) return "Slack could not find this channel in the selected workspace. Choose a channel from that workspace, save the route, then try again.";
  if (normalized.includes("not_in_channel")) return "NoxConnect is not a member of this channel. In Slack, invite @NoxConnect to the channel, then try again.";
  if (normalized.includes("is_archived")) return "This Slack channel is archived. Choose an active channel, save the route, then try again.";
  if (normalized.includes("invalid_auth") || normalized.includes("token_revoked") || normalized.includes("account_inactive") || normalized.includes("credentials could not be decrypted")) {
    return "This Slack workspace authorization is no longer usable. Reconnect the affected workspace, then send a test message.";
  }
  if (normalized.includes("missing_scope")) return "NoxConnect is missing a required Slack permission. Reconnect the affected workspace to grant the current permissions, then try again.";
  if (normalized.includes("no_permission")) return "NoxConnect does not have permission to post in this channel. Invite @NoxConnect if the channel is private, or choose another channel, then try again.";
  if (normalized.includes("workspace_mismatch")) return "The saved Slack authorization belongs to a different workspace. Reconnect the affected workspace, reselect its channel, then send a test message.";
  if (normalized.includes("app_mismatch")) return "This workspace uses an older Slack connection. Reconnect it with NoxConnect, then send a test message.";
  if (normalized.includes("rate_limited") || error?.status === 429 || normalized.includes("http 429")) {
    const retryAfter = Number(error?.retryAfter);
    const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? ` Wait ${retryAfter} seconds` : " Wait a moment";
    return `Slack is temporarily rate-limiting requests.${wait}, then try again.`;
  }
  if (normalized.includes("abort") || normalized.includes("timeout") || /^http_5\d\d$/.test(code) || /slack http 5\d\d/.test(normalized)) {
    return "Slack is temporarily unavailable or took too long to respond. Wait a moment, then try again.";
  }
  if (normalized.includes("slack not connected")) return "Slack is not connected for this organization. Connect a workspace in NoxConnect, choose a channel, then try again.";
  return fallback;
}

// ---------- Storage ----------

/**
 * Load the encrypted bot token for an org and decrypt in memory. Returns:
 *   { teamId, teamName, botUserId, botToken } — fully provisioned
 *   null                                      — not connected OR no key
 *
 * A corrupt row is treated as "not connected" so a single bad install
 * never wedges the feed.
 */
/** @param {string | null} connectionId */
export async function resolveSlackInstall(env, orgId, connectionId = null) {
  const db = env?.DB;
  if (!db || !orgId) return null;
  const row = await db
    .prepare(
      `SELECT id, app_id, team_id, team_name, bot_user_id, encrypted_bot_token, is_default
         FROM slack_connections
        WHERE org_id = ? AND (? IS NULL OR id = ?)
        ORDER BY is_default DESC, installed_at
        LIMIT 1`,
    )
    .bind(orgId, connectionId, connectionId)
    .first()
    .catch(() => null);
  if (!row?.encrypted_bot_token) return null;
  if (!env.ENCRYPTION_KEY) return null;
  try {
    const botToken = await decryptToken(row.encrypted_bot_token, env.ENCRYPTION_KEY);
    if (!botToken) return null;
    return {
      id: row.id,
      isDefault: Boolean(row.is_default),
      appId: row.app_id ?? null,
      teamId: row.team_id,
      teamName: row.team_name ?? null,
      botUserId: row.bot_user_id ?? null,
      botToken,
    };
  } catch {
    return null;
  }
}

export async function saveSlackInstall(env, orgId, install, projectId = null) {
  if (!env.ENCRYPTION_KEY) throw new Error("ENCRYPTION_KEY missing");
  const encrypted = await encryptToken(install.botToken, env.ENCRYPTION_KEY);

  const existing = await env.DB
    .prepare("SELECT id, project_id FROM slack_connections WHERE org_id = ? AND team_id = ?")
    .bind(orgId, install.teamId)
    .first()
    .catch(() => null);
  const connectionId = existing?.id ?? crypto.randomUUID();
  const defaultRow = await env.DB.prepare(
    "SELECT id FROM slack_connections WHERE org_id = ? AND is_default = 1 LIMIT 1",
  ).bind(orgId).first().catch(() => null);

  await env.DB.prepare(
    `INSERT INTO slack_connections
       (id, org_id, app_id, team_id, team_name, bot_user_id, encrypted_bot_token,
       installed_by, installed_at, is_default, project_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), ?, ?)
     ON CONFLICT(org_id, team_id) DO UPDATE SET
       app_id = excluded.app_id,
       team_name = excluded.team_name,
       bot_user_id = excluded.bot_user_id,
       encrypted_bot_token = excluded.encrypted_bot_token,
       installed_by = excluded.installed_by,
       installed_at = excluded.installed_at,
       project_id = COALESCE(excluded.project_id, slack_connections.project_id),
       health_status = 'unknown',
       last_checked_at = NULL,
       last_error = NULL`,
  )
    .bind(connectionId, orgId, install.appId ?? null, install.teamId, install.teamName ?? null, install.botUserId ?? null, encrypted, install.installedBy, defaultRow ? 0 : 1, projectId ?? existing?.project_id ?? null)
    .run();
  return connectionId;
}

export async function listSlackConnections(env, orgId) {
  if (!env?.DB || !orgId) return [];
  const { results } = await env.DB.prepare(
    `SELECT connection.id, connection.team_id, connection.team_name,
            connection.bot_user_id, connection.is_default,
            connection.health_status, connection.last_checked_at,
            connection.last_error, connection.app_id, connection.project_id,
            project.name AS project_name
       FROM slack_connections connection
       LEFT JOIN projects project ON project.id = connection.project_id
      WHERE connection.org_id = ?
      ORDER BY is_default DESC, lower(COALESCE(team_name, team_id))`,
  ).bind(orgId).all();
  return (results ?? []).map((row) => ({
    id: row.id, teamId: row.team_id, teamName: row.team_name ?? row.team_id,
    botUserId: row.bot_user_id ?? null, isDefault: Boolean(row.is_default),
    health: row.health_status ?? "unknown", lastCheckedAt: row.last_checked_at ?? null,
    lastError: row.last_error ?? null, appId: row.app_id ?? null,
    projectId: row.project_id ?? null, projectName: row.project_name ?? null,
  }));
}

export async function deleteSlackInstall(env, orgId, connectionId = null) {
  const install = await resolveSlackInstall(env, orgId, connectionId);
  if (!install) return;
  await clearSlackChannelsForConnection(env.DB, orgId, install.id, install.isDefault);
  await env.DB.prepare("DELETE FROM slack_connections WHERE org_id = ? AND id = ?")
    .bind(orgId, install.id).run();
  const next = await env.DB.prepare(
    "SELECT id FROM slack_connections WHERE org_id = ? ORDER BY is_default DESC, installed_at LIMIT 1",
  ).bind(orgId).first();
  if (next?.id) await env.DB.prepare(
    "UPDATE slack_connections SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END WHERE org_id = ?",
  ).bind(next.id, orgId).run();
}

// ---------- Per-org settings.slack.* (channels) ----------

export async function resolveSlackChannels(db, orgId) {
  if (!db || !orgId) return emptySlackChannels();
  const row = await db
    .prepare("SELECT data FROM config WHERE org_id = ? AND key = 'settings'")
    .bind(orgId)
    .first()
    .catch(() => null);
  if (!row?.data) return emptySlackChannels();
  let settings;
  try { settings = normalizeNoxSettings(JSON.parse(row.data)); } catch { return emptySlackChannels(); }
  const slack = settings?.slack;
  if (!slack || typeof slack !== "object") return emptySlackChannels();
  // The first central-routing release briefly combined both NoxFeed streams.
  // Use that selection for either stream only when its dedicated route is
  // empty, so existing organizations keep receiving messages without a data
  // migration and can split the routes on their next save.
  const noxFeedChannelId = channelId(slack.noxFeedChannelId);
  const postsChannelId = channelId(slack.postsChannelId) || noxFeedChannelId;
  const releaseNotesChannelId = channelId(slack.releaseNotesChannelId) || noxFeedChannelId;
  return {
    fallbackChannelId: channelId(slack.fallbackChannelId),
    fallbackConnectionId: channelId(slack.fallbackConnectionId),
    noxCueChannelId: channelId(slack.noxCueChannelId),
    noxCueConnectionId: channelId(slack.noxCueConnectionId),
    noxTicketChannelId: channelId(slack.noxTicketChannelId),
    noxTicketConnectionId: channelId(slack.noxTicketConnectionId),
    // Retained for clients released during the combined-route window.
    noxFeedChannelId: noxFeedChannelId || postsChannelId || releaseNotesChannelId,
    postsChannelId,
    postsConnectionId: channelId(slack.postsConnectionId),
    releaseNotesChannelId,
    releaseNotesConnectionId: channelId(slack.releaseNotesConnectionId),
    dailySummaryChannelId: channelId(slack.dailySummaryChannelId),
    dailySummaryConnectionId: channelId(slack.dailySummaryConnectionId),
    noxFeedProjectId: channelId(slack.noxFeedProjectId),
  };
}

export function resolveSlackConnectionId(channels, service, siteConnectionId = "") {
  const fallback = channelId(channels?.fallbackConnectionId);
  switch (service) {
    case "noxcue": return channelId(channels?.noxCueConnectionId) || fallback;
    case "noxspot": return channelId(siteConnectionId) || fallback;
    case "noxticket": return channelId(channels?.noxTicketConnectionId) || fallback;
    case "noxfeed_posts": return channelId(channels?.postsConnectionId) || fallback;
    case "noxfeed_release_notes": return channelId(channels?.releaseNotesConnectionId) || fallback;
    case "noxfeed_daily_summary": return channelId(channels?.dailySummaryConnectionId);
    default: return fallback;
  }
}

export function resolveSlackRoute(channels, service, siteChannelId = "") {
  const fallback = channelId(channels?.fallbackChannelId);
  switch (service) {
    case "noxcue":
      return channelId(channels?.noxCueChannelId) || fallback;
    case "noxspot":
      return channelId(siteChannelId) || fallback;
    case "noxticket":
      return channelId(channels?.noxTicketChannelId) || fallback;
    case "noxfeed_posts":
      return channelId(channels?.postsChannelId)
        || channelId(channels?.noxFeedChannelId)
        || fallback;
    case "noxfeed_release_notes":
      return channelId(channels?.releaseNotesChannelId)
        || channelId(channels?.noxFeedChannelId)
        || fallback;
    case "noxfeed_daily_summary":
      return channelId(channels?.dailySummaryChannelId);
    case "noxfeed":
      return channelId(channels?.noxFeedChannelId)
        || channelId(channels?.postsChannelId)
        || channelId(channels?.releaseNotesChannelId)
        || fallback;
    default:
      return fallback;
  }
}

function emptySlackChannels() {
  return {
    fallbackChannelId: "",
    fallbackConnectionId: "",
    noxCueChannelId: "",
    noxCueConnectionId: "",
    noxTicketChannelId: "",
    noxTicketConnectionId: "",
    noxFeedChannelId: "",
    postsChannelId: "",
    postsConnectionId: "",
    releaseNotesChannelId: "",
    releaseNotesConnectionId: "",
    dailySummaryChannelId: "",
    dailySummaryConnectionId: "",
    noxFeedProjectId: "",
  };
}

function channelId(value) {
  return typeof value === "string" ? value.trim() : "";
}

// ---------- Slack Web API client ----------

async function slackPost(token, endpoint, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${SLACK_API}/api/${endpoint}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new SlackApiError(`Slack HTTP ${res.status} ${res.statusText}`, {
    code: res.status === 429 ? "rate_limited" : `http_${res.status}`,
    status: res.status,
    retryAfter: res.headers.get("Retry-After"),
  });
  // Slack Web API always returns 200 with `ok: false` on logical errors.
  const data = await res.json();
  if (!data.ok) {
    throw new SlackApiError(`Slack ${endpoint}: ${data.error ?? "unknown error"}`, {
      code: data.error ?? "unknown_error",
      status: res.status,
    });
  }
  return data;
}

async function slackGet(token, endpoint, params = {}) {
  const url = new URL(`${SLACK_API}/api/${endpoint}`);
  for (const [k, v] of Object.entries(params)) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url.toString(), {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new SlackApiError(`Slack HTTP ${res.status} ${res.statusText}`, {
    code: res.status === 429 ? "rate_limited" : `http_${res.status}`,
    status: res.status,
    retryAfter: res.headers.get("Retry-After"),
  });
  const data = await res.json();
  if (!data.ok) throw new SlackApiError(`Slack ${endpoint}: ${data.error ?? "unknown error"}`, {
    code: data.error ?? "unknown_error",
    status: res.status,
  });
  return data;
}

// Post a Block Kit message to a channel. Throws on Slack error.
export function postSlackMessage(token, channelId, payload) {
  return slackPost(token, "chat.postMessage", { channel: channelId, ...payload });
}

export function updateSlackMessage(token, channelId, messageTs, payload) {
  return slackPost(token, "chat.update", { channel: channelId, ts: messageTs, ...payload });
}

export function openSlackModal(token, triggerId, view) {
  return slackPost(token, "views.open", { trigger_id: triggerId, view });
}

export async function getSlackChannel(token, channelId) {
  const data = await slackGet(token, "conversations.info", { channel: channelId });
  return data.channel ?? null;
}

// Existing Blindspot installs predate app identity tracking. Keep support
// explicit and temporary: a missing app ID may be accepted by configuration,
// while a known install for a different Slack app is always rejected.
export function slackInstallNeedsReconnect(env, install) {
  if (!install || !env?.SLACK_APP_ID) return false;
  if (!install.appId) return env.SLACK_ACCEPT_LEGACY_INSTALLS !== "true";
  return install.appId !== env.SLACK_APP_ID;
}

export async function checkSlackOrgHealth(env, orgId, connectionId = null) {
  const install = await resolveSlackInstall(env, orgId, connectionId);
  if (!install) {
    const row = await env.DB.prepare("SELECT 1 FROM slack_connections WHERE org_id = ?").bind(orgId).first();
    if (!row) return { status: "disconnected", recovered: false };
    if (connectionId) await writeSlackHealth(env.DB, orgId, connectionId, "degraded", "Slack credentials could not be decrypted");
    return { status: "degraded", recovered: false };
  }
  const previous = await env.DB.prepare(
    "SELECT health_status FROM slack_connections WHERE org_id = ? AND id = ?",
  ).bind(orgId, install.id).first();
  try {
    if (slackInstallNeedsReconnect(env, install)) {
      throw new SlackApiError("Reconnect Slack with the currently configured app", {
        code: "app_mismatch",
      });
    }
    const auth = await slackPost(install.botToken, "auth.test", {});
    if (auth.team_id && install.teamId && auth.team_id !== install.teamId) {
      throw new SlackApiError("Slack token belongs to a different workspace", { code: "workspace_mismatch" });
    }
    await writeSlackHealth(env.DB, orgId, install.id, "ok", null);
    return { status: "ok", recovered: previous?.health_status !== "ok" };
  } catch (error) {
    await writeSlackHealth(env.DB, orgId, install.id, "degraded", error instanceof Error ? error.message : String(error));
    return { status: "degraded", recovered: false, error };
  }
}

async function writeSlackHealth(db, orgId, connectionId, status, error) {
  await db.prepare(
    `UPDATE slack_connections SET health_status = ?, last_error = ?,
       last_checked_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE org_id = ? AND id = ?`,
  ).bind(status, error ? String(error).slice(0, 1000) : null, orgId, connectionId).run();
}

// Attach Block Kit unfurls to a Slack message. `unfurls` is a map keyed by
// the original URL that was shared. Slack accepts an empty `unfurls: {}`
// as a no-op which we use when nothing in the shared list matches an
// noxconnect URL.
export function unfurlSlackLinks(token, { channel, ts, unfurls }) {
  return slackPost(token, "chat.unfurl", { channel, ts, unfurls });
}

// Look up a Slack install by workspace ID. link_shared events arrive with
// team_id, not org_id, so this is the reverse of resolveSlackInstall().
// Returns { orgId, botToken } or null. A missing / corrupt row → null so
// a stale workspace never wedges the endpoint.
export async function resolveInstallByTeamId(env, teamId) {
  const db = env?.DB;
  if (!db || !teamId) return null;
  const row = await db
    .prepare("SELECT org_id, encrypted_bot_token FROM slack_connections WHERE team_id = ? ORDER BY is_default DESC LIMIT 1")
    .bind(teamId)
    .first()
    .catch(() => null);
  if (!row?.encrypted_bot_token) return null;
  if (!env.ENCRYPTION_KEY) return null;
  try {
    const botToken = await decryptToken(row.encrypted_bot_token, env.ENCRYPTION_KEY);
    if (!botToken) return null;
    return { orgId: row.org_id, botToken };
  } catch {
    return null;
  }
}

// Verify a Slack Events API request per the Signing Secret protocol:
// https://api.slack.com/authentication/verifying-requests-from-slack
// - Reject requests older than EVENTS_MAX_AGE_S (replay protection)
// - Reject if the HMAC-SHA256 of `v0:{ts}:{rawBody}` doesn't match the
//   `X-Slack-Signature` header. Constant-time comparison so a mismatch
//   in a leading byte doesn't leak the correct byte via timing.
export async function verifySlackSignature({ signingSecret, timestamp, signature, rawBody }) {
  if (!signingSecret || !timestamp || !signature) return false;
  const now = Math.floor(Date.now() / 1000);
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > EVENTS_MAX_AGE_S) return false;
  const base = `v0:${timestamp}:${rawBody}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(base));
  const expected = "v0=" + [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (signature.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < signature.length; i++) diff |= signature.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

// List public + private channels the bot has access to. Auto-paginates up
// to 1000 channels (Slack's default page is 100). Returns
//   [{ id, name, is_private, is_archived, is_member }, ...]
export async function listSlackChannels(token) {
  const out = [];
  let cursor;
  for (let page = 0; page < 10; page++) {
    const data = await slackGet(token, "conversations.list", {
      types: "public_channel,private_channel",
      limit: 200,
      exclude_archived: true,
      cursor,
    });
    for (const c of data.channels ?? []) {
      out.push({
        id: c.id,
        name: c.name,
        is_private: !!c.is_private,
        is_archived: !!c.is_archived,
        is_member: !!c.is_member,
      });
    }
    cursor = data.response_metadata?.next_cursor;
    if (!cursor) break;
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// ---------- OAuth helpers ----------

const REDIRECT_PATH = "/api/slack/oauth/callback";
// NoxConnect is owned by central Nox. Every product starts OAuth here and the
// code exchange must use this exact allowlisted URI as well; Slack rejects a
// callback when the authorize and exchange redirect URIs differ.
export const SLACK_OAUTH_REDIRECT_URI = "https://app.noxhere.com/api/slack/oauth/callback";

// NoxConnect has one OAuth owner and one callback. Ignore the retired
// SLACK_OAUTH_REDIRECT_URI deployment variable so an old NoxSpot/Blindspot
// compatibility value can never drift from the versioned Slack manifest.
export function resolveSlackOAuthRedirectUri() {
  return SLACK_OAUTH_REDIRECT_URI;
}
// `links:read` + `links:write` power the link-shared unfurl handler at
// /api/slack/events. Existing installs that didn't get these scopes will
// stop unfurling until an admin re-runs the Connect flow.
export const SLACK_BOT_SCOPES = ["channels:read", "groups:read", "chat:write", "chat:write.public", "links:read", "links:write"];

// Slack team IDs look like T08B8C3E91N. Validated everywhere a `team` value
// enters the OAuth flow so a crafted value can only ever be dropped, never
// injected into the authorize URL.
export function isSlackTeamId(value) {
  return typeof value === "string" && /^T[A-Z0-9]{5,20}$/.test(value);
}

// The `team` request param, shared by /api/slack/oauth/start (body) and
// /api/slack/oauth/handoff (query). Trimmed; an empty string means "leave
// the workspace choice to Slack's picker" and anything else must be a team
// ID. Non-strings are rejected by the schema rather than coerced —
// String(["T..."]) would otherwise forge a valid-looking ID.
export const SlackTeamParamSchema = z
  .string()
  .trim()
  .refine((value) => value === "" || isSlackTeamId(value), {
    message: "Invalid Slack team id",
  });

export const SlackProjectParamSchema = z
  .string()
  .trim()
  .min(1, "Project is required")
  .max(240, "Invalid project id");

export function buildOAuthAuthorizeUrl(
  clientId,
  origin,
  state,
  redirectUri = `${origin}${REDIRECT_PATH}`,
  team = "",
) {
  const u = new URL(`${SLACK_API}/oauth/v2/authorize`);
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("scope", SLACK_BOT_SCOPES.join(","));
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("state", state);
  // Without `team`, Slack defaults the authorize page to whatever workspace
  // the admin's browser session last used — the wrong one more often than not.
  // Pinning it makes reconnects land in the org's workspace; an empty value
  // deliberately leaves the choice to Slack's own workspace picker.
  if (team) u.searchParams.set("team", team);
  return u.toString();
}

// Exchange the OAuth code for a bot token + team metadata. Throws on any
// Slack-side failure so the callback can surface a clean error page.
// Credentials go in the form-encoded body, not the URL, so intermediaries
// don't log the client_secret in access logs. Wraps the fetch in the same
// 5s AbortController pattern the rest of this file uses.
export async function exchangeOAuthCode({ clientId, clientSecret, code, redirectUri }) {
  const params = new URLSearchParams();
  params.set("client_id", clientId);
  params.set("client_secret", clientSecret);
  params.set("code", code);
  params.set("redirect_uri", redirectUri);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${SLACK_API}/api/oauth.v2.access`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`Slack HTTP ${res.status}`);
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack oauth.v2.access: ${data.error ?? "unknown"}`);
  if (!data.access_token || !data.team?.id) {
    throw new Error("Slack oauth.v2.access returned no bot token / team id");
  }
  return {
    appId: data.app_id ?? null,
    botToken: data.access_token,
    botUserId: data.bot_user_id ?? null,
    teamId: data.team.id,
    teamName: data.team.name ?? null,
  };
}

// HMAC-SHA256 the state payload with the Slack client secret so a callback
// can't be tricked into trusting a forged orgId. The cookie comparison
// alone is fine for CSRF (HttpOnly + Lax), but signing the payload is a
// belt-and-braces gate against any future regression in cookie handling.
export async function signOAuthState(secret, payload) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Constant-time HMAC verify so a callback can recover orgId + user from a
// signed state without trusting the URL alone. Returns the parsed payload
// or null on mismatch / malformed input.
/** @param {number | null} maxAgeMs */
export async function verifyOAuthState(secret, state, maxAgeMs = null) {
  if (typeof state !== "string") return null;
  const idx = state.lastIndexOf(".");
  if (idx <= 0) return null;
  const payload = state.slice(0, idx);
  const sig = state.slice(idx + 1);
  const expected = await signOAuthState(secret, payload);
  if (sig.length !== expected.length) return null;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  if (diff !== 0) return null;
  // Current payload format:
  // `<nonce>:<orgId>:<encodedUserLogin>:<issuedAtMs>:<encodedProjectId>`.
  // Project is blank for an organization-wide first workspace.
  // The legacy three-part shape remains valid for callbacks already in flight,
  // but cannot pass a max-age check at the agent browser handoff.
  const parts = payload.split(":");
  if (parts.length < 3) return null;
  const orgId = Number(parts[1]);
  if (!Number.isFinite(orgId) || orgId <= 0) return null;
  if (parts.length === 4 || parts.length === 5) {
    const issuedAt = Number(parts[3]);
    if (!Number.isFinite(issuedAt) || issuedAt <= 0) return null;
    if (maxAgeMs != null && (Date.now() - issuedAt > maxAgeMs || issuedAt > Date.now() + 60_000)) return null;
    return {
      orgId,
      userLogin: parts[2],
      issuedAt,
      projectId: parts.length === 5 ? parts[4] : "",
    };
  }
  if (maxAgeMs != null) return null;
  return { orgId, userLogin: parts.slice(2).join(":") };
}

// Wipe channel selections from settings.slack when the install changes
// workspace OR is disconnected. Channel IDs are workspace-scoped — leaving
// them around after a switch would route narration to the wrong place.
export async function clearSlackChannelsForOrg(db, orgId) {
  if (!db || !orgId) return;
  // NoxSpot channel selections are workspace-scoped too. Clear them alongside
  // the feed defaults so switching/disconnecting Slack cannot retain a channel
  // id from the previous workspace.
  await db.prepare("UPDATE spot_sites SET slack_channel_id = NULL WHERE org_id = ?").bind(orgId).run();
  await db.prepare(
    `UPDATE delivery_outbox SET status = 'blocked_configuration',
       last_error_code = 'slack_not_connected', last_error = 'Slack was disconnected',
       updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
     WHERE org_id = ? AND destination = 'slack' AND status != 'delivered'`,
  ).bind(orgId).run().catch(() => null);
  const row = await db
    .prepare("SELECT data FROM config WHERE org_id = ? AND key = 'settings'")
    .bind(orgId)
    .first()
    .catch(() => null);
  if (!row?.data) return;
  let settings;
  try { settings = normalizeNoxSettings(JSON.parse(row.data)); } catch { return; }
  if (!settings?.slack) return;
  delete settings.slack.fallbackChannelId;
  delete settings.slack.fallbackConnectionId;
  delete settings.slack.noxCueChannelId;
  delete settings.slack.noxCueConnectionId;
  delete settings.slack.noxTicketChannelId;
  delete settings.slack.noxTicketConnectionId;
  delete settings.slack.noxFeedChannelId;
  delete settings.slack.postsChannelId;
  delete settings.slack.postsConnectionId;
  delete settings.slack.releaseNotesChannelId;
  delete settings.slack.releaseNotesConnectionId;
  delete settings.slack.dailySummaryChannelId;
  delete settings.slack.dailySummaryConnectionId;
  if (Object.keys(settings.slack).length === 0) {
    delete settings.slack;
  }
  await db
    .prepare(
      `INSERT INTO config (org_id, key, data, updated_at)
       VALUES (?, 'settings', ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
       ON CONFLICT(org_id, key) DO UPDATE SET data = excluded.data,
         updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`,
    )
    .bind(orgId, JSON.stringify(settings))
    .run();
}

async function clearSlackChannelsForConnection(db, orgId, connectionId, wasDefault) {
  if (!db || !orgId || !connectionId) return;
  await db.prepare(
    `UPDATE spot_sites SET slack_channel_id = NULL, slack_connection_id = NULL
      WHERE org_id = ? AND (slack_connection_id = ? OR (? = 1 AND slack_connection_id IS NULL))`,
  ).bind(orgId, connectionId, wasDefault ? 1 : 0).run();
  await db.prepare(
    `UPDATE delivery_outbox SET status = 'blocked_configuration',
       last_error_code = 'slack_not_connected', last_error = 'Selected Slack workspace was disconnected',
       updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
     WHERE org_id = ? AND destination = 'slack' AND status != 'delivered'
       AND (slack_connection_id = ? OR (? = 1 AND slack_connection_id IS NULL))`,
  ).bind(orgId, connectionId, wasDefault ? 1 : 0).run().catch(() => null);
  const row = await db.prepare("SELECT data FROM config WHERE org_id = ? AND key = 'settings'")
    .bind(orgId).first().catch(() => null);
  if (!row?.data) return;
  let settings;
  try { settings = normalizeNoxSettings(JSON.parse(row.data)); } catch { return; }
  if (!settings?.slack) return;
  const pairs = [
    ["fallbackConnectionId", "fallbackChannelId"],
    ["noxCueConnectionId", "noxCueChannelId"],
    ["noxTicketConnectionId", "noxTicketChannelId"],
    ["postsConnectionId", "postsChannelId"],
    ["releaseNotesConnectionId", "releaseNotesChannelId"],
    ["dailySummaryConnectionId", "dailySummaryChannelId"],
  ];
  for (const [connectionKey, channelKey] of pairs) {
    if (settings.slack[connectionKey] === connectionId || (wasDefault && !settings.slack[connectionKey])) {
      delete settings.slack[connectionKey];
      delete settings.slack[channelKey];
    }
  }
  if (Object.keys(settings.slack).length === 0) delete settings.slack;
  await db.prepare(
    `INSERT INTO config (org_id, key, data, updated_at)
     VALUES (?, 'settings', ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
     ON CONFLICT(org_id, key) DO UPDATE SET data = excluded.data,
       updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`,
  ).bind(orgId, JSON.stringify(settings)).run();
}
