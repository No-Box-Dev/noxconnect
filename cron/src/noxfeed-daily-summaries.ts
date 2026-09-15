import { stageSlackDelivery, queueOutboxDelivery } from "../../functions/lib/delivery-outbox.js";
import { getActiveRepoNames } from "../../functions/lib/inactive-repos.js";
import { completeNarrative } from "../../functions/lib/llm.js";
import { resolveLlmConfig } from "../../functions/lib/llm-config.js";
import { localDateTime } from "./noxcue-digests.js";

const MAX_ORGS_PER_TICK = 100;
const MAX_EVENTS = 300;
const MAX_PROMPT_EVENTS = 60;
const LOOKBACK_MS = 36 * 60 * 60 * 1000;
const SUMMARY_MAX_CHARS = 1_800;

interface DailySummaryEnv {
  DB: D1Database;
  TASK_QUEUE: Queue;
  ANTHROPIC_API_KEY?: string;
}

interface DailySummaryOrg {
  id: number;
  project_id: string;
  project_name: string;
  github_login: string;
  timezone: string;
  time_local: string;
  channel_id: string;
  connection_id: string;
}

interface ActivityEvent {
  type: string;
  actor_id: string | null;
  repo: string;
  summary: string | null;
  created_at: string;
}

export function configuredMinutes(value: string) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value));
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

export function isSummaryDue(nowMs: number, timezone: string, timeLocal: string) {
  const configured = configuredMinutes(timeLocal);
  if (configured == null) return null;
  try {
    const local = localDateTime(nowMs, timezone);
    return local.minutes >= configured ? local.period : null;
  } catch {
    return null;
  }
}

function eventPeriod(event: ActivityEvent, timezone: string) {
  const raw = String(event.created_at);
  const normalized = raw.includes("T") ? raw : `${raw.replace(" ", "T")}Z`;
  const time = Date.parse(normalized);
  if (!Number.isFinite(time)) return null;
  return localDateTime(time, timezone).period;
}

function uniqueEvents(events: ActivityEvent[]) {
  const seen = new Set<string>();
  return events.filter((event) => {
    const key = [event.type, event.repo, event.summary ?? "", event.actor_id ?? ""].join("\u0000");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function activityCounts(events: ActivityEvent[]) {
  return {
    pullRequestsOpened: events.filter((event) => event.type === "github:pr:opened").length,
    pullRequestsMerged: events.filter((event) => event.type === "github:pr:merged").length,
    pullRequestsClosed: events.filter((event) => event.type === "github:pr:closed").length,
    pullRequestsReopened: events.filter((event) => event.type === "github:pr:reopened").length,
    reviews: events.filter((event) => event.type.startsWith("github:pr:review:")).length,
    issuesOpened: events.filter((event) => event.type === "github:issue:opened").length,
    issuesClosed: events.filter((event) => event.type === "github:issue:closed").length,
    releases: events.filter((event) => event.type === "github:release:published").length,
    pushes: events.filter((event) => event.type === "github:push").length,
  };
}

function buildPrompt(org: DailySummaryOrg, period: string, events: ActivityEvent[]) {
  const counts = activityCounts(events);
  return {
    system: [
      "You write a concise internal engineering daily summary for Slack.",
      "Use only the supplied GitHub activity. Emphasize shipped outcomes, active work, reviews, and blockers instead of listing every event.",
      "A release_notes item contains extra detail for its corresponding merged PR; do not count it as another change.",
      "Use plain Slack mrkdwn with short bullets when useful. Do not output JSON, a code fence, a title, or a preamble.",
      "Keep the complete response between 60 and 140 words. Never invent impact, status, or next steps.",
    ].join(" "),
    user: JSON.stringify({
      organization: org.github_login,
      localDate: period,
      counts,
      activityTruncated: events.length > MAX_PROMPT_EVENTS,
      activity: events.slice(0, MAX_PROMPT_EVENTS).map((event) => ({
        type: event.type,
        repository: event.repo,
        actor: event.actor_id,
        summary: event.summary?.slice(0, 500) ?? null,
      })),
    }),
    counts,
  };
}

function slackMessage(org: DailySummaryOrg, period: string, text: string, counts: ReturnType<typeof activityCounts>) {
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  return {
    text: `What happened today in ${org.github_login} — ${period}\n${text}`,
    blocks: [
      { type: "header", text: { type: "plain_text", text: "What happened today", emoji: true } },
      { type: "context", elements: [{ type: "mrkdwn", text: `*${org.github_login}* · ${period}` }] },
      { type: "section", text: { type: "mrkdwn", text } },
      { type: "context", elements: [{ type: "mrkdwn", text: `${total} GitHub ${total === 1 ? "event" : "events"} across tracked repositories` }] },
    ],
  };
}

async function createSummary(env: DailySummaryEnv, org: DailySummaryOrg, period: string, nowMs: number) {
  const sourceId = `daily-summary:${org.id}:${org.project_id}:${period}`;
  const existing = await env.DB.prepare(
    "SELECT id FROM delivery_outbox WHERE source = 'noxfeed_daily_summary' AND destination = 'slack' AND source_id = ?",
  ).bind(sourceId).first();
  if (existing) return { skipped: "already_created" };

  const activeRepos = await getActiveRepoNames(env.DB, org.id, org.github_login, org.project_id);
  if (activeRepos.length === 0) return { skipped: "no_active_repositories" };

  const since = new Date(nowMs - LOOKBACK_MS).toISOString();
  const placeholders = activeRepos.map(() => "?").join(",");
  const { results } = await env.DB.prepare(
    `SELECT type, actor_id, repo, summary, created_at
       FROM events
      WHERE owner_id = ? AND project_id = ? AND repo IN (${placeholders}) AND created_at >= ?
        AND type IN (
          'github:pr:opened', 'github:pr:merged', 'github:pr:closed', 'github:pr:reopened',
          'github:pr:review:approved', 'github:pr:review:changes_requested', 'github:pr:review:commented',
          'github:issue:opened', 'github:issue:closed', 'github:release:published', 'github:push',
          'release_notes'
        )
      ORDER BY created_at DESC
      LIMIT ?`,
  ).bind(org.github_login, org.project_id, ...activeRepos, since, MAX_EVENTS).all<ActivityEvent>();
  const events = uniqueEvents((results ?? []).filter((event) => eventPeriod(event, org.timezone) === period));
  if (events.length === 0) return { skipped: "no_activity" };

  const llm = await resolveLlmConfig(env, org.id, org.project_id);
  if (llm.status !== "ready") throw new Error(`NoxFeed AI unavailable (${llm.errorCode ?? llm.status})`);
  const prompt = buildPrompt(org, period, events);
  const generated = await completeNarrative(llm, prompt.system, prompt.user, {
    tag: "noxfeed-daily-summary",
    maxTokens: 700,
  });
  if (!generated) throw new Error("NoxFeed AI returned no daily summary");
  const text = generated.slice(0, SUMMARY_MAX_CHARS);
  const delivery = await stageSlackDelivery(env.DB, {
    orgId: org.id,
    projectId: org.project_id,
    source: "noxfeed_daily_summary",
    sourceId,
    siteId: null,
    connectionId: org.connection_id,
    channelId: org.channel_id,
    payload: { message: slackMessage(org, period, text, prompt.counts) },
  });
  if (!delivery?.id) throw new Error("NoxFeed daily summary outbox write failed");
  const queued = delivery.status === "delivered"
    ? false
    : await queueOutboxDelivery(env, delivery.id, org.github_login);
  return { created: true, queued };
}

export async function runNoxFeedDailySummaries(env: DailySummaryEnv, nowMs = Date.now()) {
  const { results } = await env.DB.prepare(
    `SELECT org.id, org.github_login, project.id AS project_id, project.name AS project_name,
            COALESCE(NULLIF(json_extract(config.data, '$.noxfeedDailySummary.timezone'), ''), 'UTC') AS timezone,
            COALESCE(NULLIF(json_extract(config.data, '$.noxfeedDailySummary.timeLocal'), ''), '17:00') AS time_local,
            NULLIF(json_extract(config.data, '$.slack.dailySummaryChannelId'), '') AS channel_id,
            COALESCE(
              NULLIF(json_extract(config.data, '$.slack.dailySummaryConnectionId'), ''),
              (SELECT connection.id FROM slack_connections connection
                WHERE connection.org_id = org.id
                ORDER BY connection.is_default DESC, connection.installed_at LIMIT 1)
            ) AS connection_id
       FROM projects project
       JOIN orgs org ON org.id = project.org_id
       JOIN project_routing_settings routing
         ON routing.org_id = org.id AND routing.project_id = project.id AND routing.enabled = 1
       JOIN project_config config
         ON config.org_id = org.id AND config.project_id = project.id AND config.key = 'settings'
      WHERE COALESCE(json_extract(config.data, '$.apps.noxfeed'), 1) != 0
        AND json_extract(config.data, '$.noxfeedDailySummary.enabled') = 1
        AND COALESCE(project.archived, 0) = 0
      ORDER BY org.id, project.id LIMIT ?`,
  ).bind(MAX_ORGS_PER_TICK).all<DailySummaryOrg>();

  let created = 0;
  let skipped = 0;
  let failed = 0;
  for (const org of results ?? []) {
    if (!org.channel_id || !org.connection_id) { skipped += 1; continue; }
    const period = isSummaryDue(nowMs, org.timezone, org.time_local);
    if (!period) { skipped += 1; continue; }
    try {
      const result = await createSummary(env, org, period, nowMs);
      if (result.created) created += 1;
      else skipped += 1;
    } catch (error) {
      failed += 1;
      console.error(JSON.stringify({
        event: "noxfeed_daily_summary_failed",
        orgId: org.id,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }
  return { created, skipped, failed };
}
