import { getCtx, jsonResponse, errorResponse } from "../../lib/db";
import { validateBoardStages } from "../../lib/board-stages.js";
import { extractStatusFromLabels } from "../../lib/feature-issues.js";
import { actionableSlackError, getSlackChannel, resolveSlackInstall } from "../../lib/slack.js";
import { recoverOutboxDeliveries } from "../../lib/delivery-outbox.js";
import { LEGACY_NOXTICKET_SOURCE, normalizeNoxSettings } from "../../lib/naming-compat.js";
import { requireAdmin } from "../../lib/access.js";

const VALID_KEYS = ["features", "people", "settings"];
const SLACK_CHANNEL_KEYS = [
  "fallbackChannelId",
  "noxCueChannelId",
  "noxTicketChannelId",
  "noxFeedChannelId",
  // Accepted during the compatibility window for older clients.
  "postsChannelId",
  "releaseNotesChannelId",
  "dailySummaryChannelId",
];
const SLACK_ROUTES = [
  ["fallbackChannelId", "fallbackConnectionId"],
  ["noxCueChannelId", "noxCueConnectionId"],
  ["noxTicketChannelId", "noxTicketConnectionId"],
  ["postsChannelId", "postsConnectionId"],
  ["releaseNotesChannelId", "releaseNotesConnectionId"],
  ["dailySummaryChannelId", "dailySummaryConnectionId"],
  ["noxFeedChannelId", null],
];
const OPTIONAL_APP_KEYS = ["noxticket", "noxfeed", "noxspot", "noxcue"];
const APP_DELIVERY_SOURCES = {
  noxticket: ["noxticket", LEGACY_NOXTICKET_SOURCE],
  noxfeed: ["posts", "release_notes", "noxfeed_daily_summary"],
  noxspot: ["noxspot"],
  noxcue: ["noxcue"],
};

const DEFAULTS = {
  features: [],
  people: [],
  settings: null,
};

// GET /api/config/:key
export async function onRequestGet(context) {
  const key = context.params.key;
  if (!VALID_KEYS.includes(key)) {
    return errorResponse(`Invalid config key: ${key}`, 400);
  }

  const { orgId } = getCtx(context);
  const row = await context.env.DB
    .prepare("SELECT data FROM config WHERE org_id = ? AND key = ?")
    .bind(orgId, key)
    .first();

  if (!row) {
    return jsonResponse(DEFAULTS[key]);
  }

  try {
    const parsed = JSON.parse(row.data);
    return jsonResponse(key === "settings" ? normalizeNoxSettings(parsed) : parsed);
  } catch (err) {
    // Returning the default silently masked real corruption — drafts
    // re-appeared, custom noxTicketRepo names reverted to "noxconnect".
    // Fail loud so the user sees a clear error and fixes the row.
    console.error(`[noxconnect] Corrupt config data for key "${key}" (org ${orgId}):`, err?.message ?? err);
    return errorResponse(`Corrupt config row for "${key}" — repair before continuing`, 500);
  }
}

// PUT /api/config/:key — max 256KB body
const MAX_BODY_BYTES = 256 * 1024;

export async function onRequestPut(context) {
  const key = context.params.key;
  if (!VALID_KEYS.includes(key)) {
    return errorResponse(`Invalid config key: ${key}`, 400);
  }
  if (key === "settings" || key === "people") {
    const accessError = requireAdmin(context);
    if (accessError) return accessError;
  }

  // Cap body size to keep config rows from blowing up D1 storage / per-row limits.
  const contentLength = Number(context.request.headers.get("Content-Length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return errorResponse("Config payload too large (max 256KB)", 413);
  }

  const { orgId, orgLogin } = getCtx(context);
  let body;
  try { body = await context.request.json(); } catch {
    return errorResponse("Invalid JSON body", 400);
  }
  if (key === "settings") body = normalizeNoxSettings(body);

  if (key === "settings" && body && typeof body === "object" && body.releaseNotesPrompt !== undefined) {
    if (typeof body.releaseNotesPrompt !== "string") {
      return errorResponse("Release-notes prompt must be text.", 422);
    }
    if (body.releaseNotesPrompt.length > 20_000) {
      return errorResponse("Release-notes prompt must be at most 20,000 characters.", 422);
    }
    if (!body.releaseNotesPrompt.trim()) delete body.releaseNotesPrompt;
  }

  if (key === "settings" && body && typeof body === "object" && body.noxfeedDailySummary !== undefined) {
    const summary = body.noxfeedDailySummary;
    if (!summary || typeof summary !== "object" || Array.isArray(summary)) {
      return errorResponse("Daily summary settings must be an object.", 422);
    }
    if (typeof summary.enabled !== "boolean") {
      return errorResponse("Choose whether the daily summary is on or off.", 422);
    }
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(summary.timeLocal ?? "")) {
      return errorResponse("Choose a valid daily summary time.", 422);
    }
    try {
      new Intl.DateTimeFormat("en", { timeZone: summary.timezone }).format();
    } catch {
      return errorResponse("Choose a valid daily summary timezone.", 422);
    }
  }

  const slackWasSupplied = key === "settings"
    && body
    && typeof body === "object"
    && Object.prototype.hasOwnProperty.call(body, "slack");
  const appsWereSupplied = key === "settings"
    && body
    && typeof body === "object"
    && Object.prototype.hasOwnProperty.call(body, "apps");

  if (key === "settings" && body && typeof body === "object" && body.apps !== undefined) {
    if (!body.apps || typeof body.apps !== "object" || Array.isArray(body.apps)) {
      return errorResponse("apps must be an object", 422);
    }
    for (const [appId, enabled] of Object.entries(body.apps)) {
      if (!OPTIONAL_APP_KEYS.includes(appId) || typeof enabled !== "boolean") {
        return errorResponse(`Invalid app setting: ${appId}`, 422);
      }
    }
  }

  // Board-stages validation runs before the row write so a malformed config
  // can't get persisted and break the kanban for everyone in the org.
  if (key === "settings" && body && typeof body === "object" && body.boardStages !== undefined) {
    const result = validateBoardStages(body.boardStages);
    if (!result.ok) return errorResponse(result.error, 422);

    // Block the save if any open feature is sitting in a stage that's about
    // to disappear — otherwise it would silently vanish from the board.
    const newIds = new Set(body.boardStages.map((s) => s.id));
    const { results: openFeatures } = await context.env.DB
      .prepare(
        "SELECT number, title, labels_json FROM features WHERE org_id = ? AND state = 'open'",
      )
      .bind(orgId)
      .all();
    const orphans = [];
    for (const row of openFeatures ?? []) {
      const labels = JSON.parse(row.labels_json || "[]");
      const status = extractStatusFromLabels(labels);
      if (!newIds.has(status)) {
        orphans.push({ number: row.number, title: row.title, status });
      }
    }
    if (orphans.length > 0) {
      return jsonResponse(
        {
          error: `Cannot remove stages: ${orphans.length} feature${orphans.length === 1 ? " is" : "s are"} still in a stage being removed`,
          orphans,
        },
        409,
      );
    }
  }

  if (slackWasSupplied && body?.slack && typeof body.slack === "object") {
    const routes = SLACK_ROUTES.flatMap(([channelKey, connectionKey]) => {
      const channelId = typeof body.slack[channelKey] === "string" ? body.slack[channelKey].trim() : "";
      const connectionId = connectionKey && typeof body.slack[connectionKey] === "string"
        ? body.slack[connectionKey].trim() : null;
      return channelId ? [{ channelId, connectionId }] : [];
    });
    if (routes.length > 0) {
      try {
        for (const { channelId, connectionId } of routes) {
          const install = await resolveSlackInstall(context.env, orgId, connectionId);
          if (!install) return errorResponse("Connect the selected Slack workspace before choosing a channel", 409);
          const channel = await getSlackChannel(install.botToken, channelId);
          if (!channel || channel.is_archived) return errorResponse("This Slack channel is archived or unavailable. Choose an active channel, then save again.", 409);
          if (channel.is_private && !channel.is_member) return errorResponse("NoxConnect is not in this private channel. Invite @NoxConnect in Slack, then save again.", 409);
        }
      } catch (error) {
        return errorResponse(actionableSlackError(error, "Slack could not verify this channel. Review the workspace and channel, then save again."), 409);
      }
    }
  }

  const serialized = JSON.stringify(body);
  // Measure UTF-8 byte length, not UTF-16 string length — multi-byte chars
  // (emojis, CJK) would otherwise pass a code-unit check and still bust D1.
  const byteLength = new TextEncoder().encode(serialized).byteLength;
  if (byteLength > MAX_BODY_BYTES) {
    return errorResponse("Config payload too large (max 256KB)", 413);
  }

  const compareAndSwap = context.data?.configCompareAndSwap;
  const configStatement = compareAndSwap
    ? compareAndSwap.expectedRaw == null
      ? context.env.DB.prepare(
          `INSERT INTO config (org_id, key, data, updated_at)
           VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
           ON CONFLICT(org_id, key) DO NOTHING`,
        ).bind(orgId, key, serialized)
      : context.env.DB.prepare(
          `UPDATE config SET data = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
           WHERE org_id = ? AND key = ? AND data = ?`,
        ).bind(serialized, orgId, key, compareAndSwap.expectedRaw)
    : context.env.DB.prepare(
        `INSERT INTO config (org_id, key, data, updated_at)
         VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
         ON CONFLICT(org_id, key) DO UPDATE SET
           data = excluded.data,
           updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`
      )
      .bind(orgId, key, serialized);

  const dependentStatements = [];
  // A CAS miss must not mutate dependent outbox rows. Every repair is guarded
  // by the desired config value and runs in the same D1 batch as the setting.
  const configGuard = compareAndSwap
    ? " AND EXISTS (SELECT 1 FROM config config_guard WHERE config_guard.org_id = ? AND config_guard.key = ? AND config_guard.data = ?)"
    : "";
  const configGuardBinds = compareAndSwap ? [orgId, key, serialized] : [];
  if (slackWasSupplied) {
    const slack = body?.slack && typeof body.slack === "object" ? body.slack : {};
    const clean = (value) => typeof value === "string" ? value.trim() : "";
    const fallbackChannelId = clean(slack.fallbackChannelId);
    const fallbackConnectionId = clean(slack.fallbackConnectionId) || null;
    const routes = [
      { sources: ["posts"], channelId: clean(slack.postsChannelId) || clean(slack.noxFeedChannelId) || fallbackChannelId, connectionId: clean(slack.postsConnectionId) || fallbackConnectionId },
      { sources: ["release_notes"], channelId: clean(slack.releaseNotesChannelId) || clean(slack.noxFeedChannelId) || fallbackChannelId, connectionId: clean(slack.releaseNotesConnectionId) || clean(slack.postsConnectionId) || fallbackConnectionId },
      { sources: ["noxfeed_daily_summary"], channelId: clean(slack.dailySummaryChannelId), connectionId: clean(slack.dailySummaryConnectionId) || null },
      { sources: ["noxcue"], channelId: clean(slack.noxCueChannelId) || fallbackChannelId, connectionId: clean(slack.noxCueConnectionId) || fallbackConnectionId },
      { sources: ["noxticket", LEGACY_NOXTICKET_SOURCE], channelId: clean(slack.noxTicketChannelId) || fallbackChannelId, connectionId: clean(slack.noxTicketConnectionId) || fallbackConnectionId },
    ];
    for (const { sources, channelId, connectionId } of routes) {
      const placeholders = sources.map(() => "?").join(",");
      if (channelId) {
        dependentStatements.push(context.env.DB.prepare(
          `UPDATE delivery_outbox SET channel_id = ?, slack_connection_id = ?, status = 'pending',
             last_error_code = NULL, last_error = NULL, next_attempt_at = NULL,
             updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
           WHERE org_id = ? AND source IN (${placeholders})
             AND destination = 'slack' AND status != 'delivered'${configGuard}`,
        ).bind(channelId, connectionId, orgId, ...sources, ...configGuardBinds));
      } else {
        dependentStatements.push(context.env.DB.prepare(
          `UPDATE delivery_outbox SET status = 'blocked_configuration',
             last_error_code = 'alerts_disabled', last_error = 'No Slack channel is configured for this service',
             updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
           WHERE org_id = ? AND source IN (${placeholders})
             AND destination = 'slack' AND status != 'delivered'${configGuard}`,
        ).bind(orgId, ...sources, ...configGuardBinds));
      }
    }

    // NoxSpot keeps its per-site override. Only captures from sites without
    // one follow the organization fallback.
    if (fallbackChannelId) {
      dependentStatements.push(context.env.DB.prepare(
        `UPDATE delivery_outbox SET channel_id = ?, slack_connection_id = ?, status = 'pending',
           last_error_code = NULL, last_error = NULL, next_attempt_at = NULL,
           updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
         WHERE org_id = ? AND source = 'noxspot' AND destination = 'slack'
           AND status != 'delivered' AND site_id IN (
             SELECT id FROM spot_sites WHERE org_id = ? AND slack_channel_id IS NULL
           )${configGuard}`,
      ).bind(fallbackChannelId, fallbackConnectionId, orgId, orgId, ...configGuardBinds));
    } else {
      dependentStatements.push(context.env.DB.prepare(
        `UPDATE delivery_outbox SET status = 'blocked_configuration',
           last_error_code = 'alerts_disabled', last_error = 'No NoxSpot site or organization fallback channel is configured',
           updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
         WHERE org_id = ? AND source = 'noxspot' AND destination = 'slack'
           AND status != 'delivered' AND site_id IN (
             SELECT id FROM spot_sites WHERE org_id = ? AND slack_channel_id IS NULL
           )${configGuard}`,
      ).bind(orgId, orgId, ...configGuardBinds));
    }
  }

  if (appsWereSupplied) {
    for (const [appId, sources] of Object.entries(APP_DELIVERY_SOURCES)) {
      const placeholders = sources.map(() => "?").join(",");
      if (body.apps?.[appId] === false) {
        dependentStatements.push(context.env.DB.prepare(
          `UPDATE delivery_outbox SET status = 'blocked_service_disabled',
             last_error_code = 'service_disabled', last_error = ?, next_attempt_at = NULL,
             updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
           WHERE org_id = ? AND source IN (${placeholders})
             AND destination = 'slack' AND status != 'delivered'${configGuard}`,
        ).bind(`${appId} is off for this organization`, orgId, ...sources, ...configGuardBinds));
      } else {
        dependentStatements.push(context.env.DB.prepare(
          `UPDATE delivery_outbox SET status = 'pending',
             last_error_code = NULL, last_error = NULL, next_attempt_at = NULL,
             updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
           WHERE org_id = ? AND source IN (${placeholders})
             AND destination = 'slack' AND status = 'blocked_service_disabled'${configGuard}`,
        ).bind(orgId, ...sources, ...configGuardBinds));
      }
    }
  }

  const [configResult] = dependentStatements.length > 0
    ? await context.env.DB.batch([configStatement, ...dependentStatements])
    : [await configStatement.run()];
  if (compareAndSwap && !configResult.meta?.changes) {
    // An INSERT retry can lose its race to an identical desired value. Its
    // guarded repairs are safe and idempotent, so treat that as success rather
    // than telling an agent to retry forever. Raw equality is deliberately
    // conservative: equivalent JSON with different key order returns 409 and
    // asks the caller to refetch instead of guessing. A different stored value
    // is a genuine conflict.
    const current = await context.env.DB.prepare(
      "SELECT data FROM config WHERE org_id = ? AND key = ?",
    ).bind(orgId, key).first();
    if (String(current?.data ?? "") !== serialized) {
      return errorResponse("Settings changed concurrently; fetch routing and retry", 409);
    }
  }

  if (slackWasSupplied || appsWereSupplied) {
    await recoverOutboxDeliveries(context.env);
  }

  return jsonResponse({ ok: true });
}
