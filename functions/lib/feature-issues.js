// Server-side helpers for the feature kanban (issues in {org}/noxconnect).
//
// Mirrors src/lib/github-features.ts's label/body conventions so that the
// frontend can talk to /api/features instead of calling Octokit directly.
// Keeping both sides in lock-step matters: the kanban column an issue lands
// in is derived from labels, so any divergence here would silently misroute
// cards.

import { parseFeatureMetadata, serializeFeatureMetadata } from "./feature-metadata.js";
import { LEGACY_NOXTICKET_LABEL } from "./naming-compat.js";

export const NOXTICKET_REPO = "noxconnect";
export const NOXTICKET_LABEL = "noxticket";
export const FEATURE_LABEL = "feature";
export const BACKLOG_LABEL = "backlog";
const STATUS_PREFIX = "status:";

// Fixed labels that always exist on the NoxTicket repo. `status:*` labels are
// derived from the org's configured board stages — see ensureNoxTicketRepoLabels.
export const FEATURE_LABELS = [
  { name: NOXTICKET_LABEL, color: "1B6971", description: "Tracked by NoxTicket" },
  { name: "feature", color: "1B6971", description: "Feature managed by Nox" },
  { name: "backlog", color: "94A3B8", description: "Feature parked in the backlog (hidden from the board)" },
];

// "todo" is the implicit default — no explicit status label. Only emit a
// `status:*` label for the non-default columns. Admins can rename the
// non-default stage labels/colors via Settings → Board stages, but `todo`
// remains the implicit-default id; features without a `status:*` label keep
// resolving to it.
//
// `backlog` is orthogonal to status — a backlogged feature keeps its status
// label so moving back to the board lands it in the same column it left.
export function buildFeatureLabels(status, backlog = false) {
  const labels = [NOXTICKET_LABEL, FEATURE_LABEL];
  if (status && status !== "todo") labels.push(`${STATUS_PREFIX}${status}`);
  if (backlog) labels.push(BACKLOG_LABEL);
  return labels;
}

export function hasNoxTicketLabel(labels) {
  const names = new Set((labels ?? []).map((label) =>
    String(typeof label === "string" ? label : label?.name ?? "").toLowerCase()));
  return names.has(NOXTICKET_LABEL) || names.has(LEGACY_NOXTICKET_LABEL);
}

export function extractStatusFromLabels(labels) {
  const names = (labels ?? [])
    .map((l) => (typeof l === "string" ? l : l?.name))
    .filter(Boolean);
  const found = names.find((n) => n.startsWith(STATUS_PREFIX));
  return found ? found.slice(STATUS_PREFIX.length) : "todo";
}

export function extractBacklogFromLabels(labels) {
  return (labels ?? [])
    .map((l) => (typeof l === "string" ? l : l?.name))
    .some((n) => n === BACKLOG_LABEL);
}

const GH_HEADERS = (token) => ({
  Authorization: `Bearer ${token}`,
  "User-Agent": "NoxConnect",
  Accept: "application/vnd.github+json",
});

async function ghFetch(url, init, token) {
  const res = await fetch(url, {
    ...init,
    headers: {
      ...GH_HEADERS(token),
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body?.message || `GitHub ${res.status} ${res.statusText}`);
    err.status = res.status;
    err.ghBody = body;
    throw err;
  }
  return res.json();
}

// Per-org cache: only run the label backfill once per Worker isolate per
// (org, stage-set) signature. createLabel is idempotent, so on a cold start
// the re-check is harmless; the cache just avoids the redundant API calls.
const labelsEnsuredByOrg = new Set();

// Test-only: clear the per-isolate cache so unit tests can drive the GET
// labels flow deterministically. Not exported for production use.
export function __resetLabelCacheForTests() {
  labelsEnsuredByOrg.clear();
}

function stageSignature(stages) {
  return (stages ?? []).map((s) => `${s.id}:${(s.color || "").replace(/^#/, "")}`).join(",");
}

// Ensures `noxticket`, `feature`, and `status:<id>` labels exist on the NoxTicket
// repo for every configured stage. `stages` is the array returned by
// resolveBoardStages — caller is responsible for resolving them.
export async function ensureNoxTicketRepoLabels(token, orgLogin, stages = []) {
  const cacheKey = `${orgLogin}::${stageSignature(stages)}`;
  if (labelsEnsuredByOrg.has(cacheKey)) return;

  const needed = [
    ...FEATURE_LABELS,
    ...stages.map((s) => ({
      name: `${STATUS_PREFIX}${s.id}`,
      color: (s.color || "#94a3b8").replace(/^#/, ""),
      description: s.label,
    })),
  ];

  const existing = await ghFetch(
    `https://api.github.com/repos/${encodeURIComponent(orgLogin)}/${NOXTICKET_REPO}/labels?per_page=100`,
    { method: "GET" },
    token,
  );
  const existingByName = new Map(existing.map((l) => [l.name, l]));

  for (const label of needed) {
    const current = existingByName.get(label.name);
    if (!current) {
      try {
        await ghFetch(
          `https://api.github.com/repos/${encodeURIComponent(orgLogin)}/${NOXTICKET_REPO}/labels`,
          { method: "POST", body: JSON.stringify(label) },
          token,
        );
      } catch (err) {
        // 422 = "already_exists" race; safe to ignore.
        if (err?.status !== 422) throw err;
      }
      continue;
    }
    // PATCH the label when the color or description drifts from what the
    // admin configured — keeps GitHub's label colors in sync with the board.
    if (label.color && current.color !== label.color) {
      try {
        await ghFetch(
          `https://api.github.com/repos/${encodeURIComponent(orgLogin)}/${NOXTICKET_REPO}/labels/${encodeURIComponent(label.name)}`,
          { method: "PATCH", body: JSON.stringify({ color: label.color, description: label.description }) },
          token,
        );
      } catch (err) {
        if (err?.status !== 422) throw err;
      }
    }
  }
  labelsEnsuredByOrg.add(cacheKey);
}

export async function createFeatureIssue(token, orgLogin, payload) {
  return ghFetch(
    `https://api.github.com/repos/${encodeURIComponent(orgLogin)}/${NOXTICKET_REPO}/issues`,
    { method: "POST", body: JSON.stringify(payload) },
    token,
  );
}

export async function patchFeatureIssue(token, orgLogin, number, payload) {
  return ghFetch(
    `https://api.github.com/repos/${encodeURIComponent(orgLogin)}/${NOXTICKET_REPO}/issues/${number}`,
    { method: "PATCH", body: JSON.stringify(payload) },
    token,
  );
}

// Build the body GitHub will store — plan content followed by the metadata
// HTML comment block. Empty metadata returns just the plan.
export function buildIssueBody(plan, metadata) {
  return serializeFeatureMetadata(plan ?? "", metadata ?? {});
}

// Read the current feature row from D1 (or null) — used by PATCH to preserve
// metadata and compare the old status.
export async function readFeatureRow(db, orgId, projectId, number) {
  return db
    .prepare(projectId
      ? `SELECT number, title, state, body, assignees_json, labels_json, milestone_title, html_url, created_at, updated_at
           FROM features WHERE org_id = ? AND project_id = ? AND number = ?`
      : `SELECT number, title, state, body, assignees_json, labels_json, milestone_title, html_url, created_at, updated_at
           FROM features WHERE org_id = ? AND number = ? ORDER BY project_id LIMIT 1`)
    .bind(...(projectId ? [orgId, projectId, number] : [orgId, number]))
    .first();
}

// Mirror a feature row into D1. Same column set as the webhook handler so
// /api/features?state=open reads consistently regardless of which path wrote.
//
// `opts.from` is the bidirectional-sync discriminator:
//   - "github" → row reflects GitHub's current state. Sets
//     `gh_synced_at = ghIssue.updated_at`, so a later cron tick can tell
//     "D1 is in sync with GitHub" from "D1 has an unpushed local change".
//   - "local"  → row reflects a user edit from the UI. Bumps `updated_at`
//     to now() and leaves `gh_synced_at` untouched, marking the row
//     pending-push. The cron's syncFeatures will push it to GitHub on
//     the next tick if the inline waitUntil PATCH didn't get there first.
//
// Default is "github" to keep the existing webhook callers correct without
// every call site needing an update.
export async function upsertFeatureRow(db, orgId, ghIssue, opts = {}) {
  const from = opts.from ?? "github";
  const projectId = opts.projectId ?? null;
  const assignees = (ghIssue.assignees ?? []).map((a) => ({
    login: a.login,
    avatar_url: a.avatar_url || "",
  }));
  const labels = (ghIssue.labels ?? []).map((l) => ({ name: l.name, color: l.color }));
  const updatedAt = from === "local"
    ? new Date().toISOString()
    : (ghIssue.updated_at ?? new Date().toISOString());

  if (from === "local") {
    // ON CONFLICT clause deliberately omits gh_synced_at so the previous
    // value (set by the last GH-sourced mirror) is preserved.
    await db
      .prepare(
        `INSERT INTO features (org_id, project_id, number, title, state, body, assignees_json, labels_json, milestone_title, html_url, created_at, updated_at, gh_synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(org_id, project_id, number) DO UPDATE SET
           project_id = COALESCE(excluded.project_id, features.project_id),
           title = excluded.title,
           state = excluded.state,
           body = excluded.body,
           assignees_json = excluded.assignees_json,
           labels_json = excluded.labels_json,
           milestone_title = excluded.milestone_title,
           html_url = excluded.html_url,
           updated_at = excluded.updated_at`,
      )
      .bind(
        orgId,
        projectId,
        ghIssue.number,
        ghIssue.title,
        ghIssue.state ?? "open",
        ghIssue.body ?? "",
        JSON.stringify(assignees),
        JSON.stringify(labels),
        ghIssue.milestone?.title ?? null,
        ghIssue.html_url ?? null,
        ghIssue.created_at ?? new Date().toISOString(),
        updatedAt,
      )
      .run();
    return;
  }

  await db
    .prepare(
      `INSERT INTO features (org_id, project_id, number, title, state, body, assignees_json, labels_json, milestone_title, html_url, created_at, updated_at, gh_synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(org_id, project_id, number) DO UPDATE SET
         project_id = COALESCE(excluded.project_id, features.project_id),
         title = excluded.title,
         state = excluded.state,
         body = excluded.body,
         assignees_json = excluded.assignees_json,
         labels_json = excluded.labels_json,
         milestone_title = excluded.milestone_title,
         html_url = excluded.html_url,
         updated_at = excluded.updated_at,
         gh_synced_at = excluded.gh_synced_at`,
    )
    .bind(
      orgId,
      projectId,
      ghIssue.number,
      ghIssue.title,
      ghIssue.state ?? "open",
      ghIssue.body ?? "",
      JSON.stringify(assignees),
      JSON.stringify(labels),
      ghIssue.milestone?.title ?? null,
      ghIssue.html_url ?? null,
      ghIssue.created_at ?? new Date().toISOString(),
      updatedAt,
      updatedAt,
    )
    .run();
}

// Convert a GitHub issue response to the Feature shape the frontend uses.
// Feature body's leading text (legacy plan) is intentionally dropped from the
// wire response — Specs are the sole content surface. parseFeatureMetadata
// still runs so the metadata block behind it comes through.
export function ghIssueToFeature(ghIssue) {
  const { metadata } = parseFeatureMetadata(ghIssue.body ?? "");
  return {
    id: ghIssue.number,
    title: ghIssue.title,
    owners: (ghIssue.assignees ?? []).map((a) => a.login),
    status: extractStatusFromLabels(ghIssue.labels),
    backlog: extractBacklogFromLabels(ghIssue.labels),
    url: ghIssue.html_url ?? undefined,
    updatedAt: ghIssue.updated_at,
    statusHistory: metadata.statusHistory,
    specLinks: metadata.specLinks,
  };
}
