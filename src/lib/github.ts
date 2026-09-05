import { apiGet, apiPost, ApiError, broadcastError } from "./api";

export interface RateLimitInfo {
  limit: number;
  remaining: number;
  reset: number; // Unix timestamp
  used: number;
}

export async function fetchRateLimit(): Promise<RateLimitInfo> {
  return apiGet<RateLimitInfo>("/api/github/rate-limit");
}

export async function fetchUser() {
  const profile = await apiGet<{ user: { login: string; avatar_url: string; name: string | null } }>("/api/auth/profile?scope=user");
  return profile.user;
}

export interface GitHubOrganization {
  id: number;
  login: string;
  avatar_url?: string | null;
  description?: string | null;
}

export async function fetchOrgs(): Promise<GitHubOrganization[]> {
  const profile = await apiGet<{ orgs: GitHubOrganization[] }>("/api/auth/profile?scope=orgs");
  return profile.orgs;
}

export interface MeResponse {
  login: string;
  org: string;
  isAdmin: boolean;
}

// App-level identity + admin flag. Backed by `/api/me`, which reads the
// `org_admins` table populated by a verified GitHub organization-owner
// bootstrap. This replaced a direct GitHub call against
// `/orgs/{org}/memberships/{user}` — GitHub org role and app-level admin are
// no longer coupled.
export async function fetchMe(): Promise<MeResponse> {
  return apiGet<MeResponse>("/api/me");
}

// ---------- Sync ----------

interface SyncResponse {
  done: boolean;
  cursor?: string;
  repos?: number;
  repoList?: string[];
  synced?: string;
  lastRepo?: string;
}

export async function triggerSync() {
  // Phase 1: init — get repo list
  const init = await apiPost<SyncResponse>("/api/sync");

  if (init.done) {
    return { ok: true, synced: { repos: 0, prs: 0, issues: 0, members: 0 } };
  }

  // Phase 2: sync one repo at a time via cursor
  let cursor = init.cursor;
  const maxIterations = (init.repos ?? 0) + 5;
  let iterations = 0;
  while (cursor && iterations < maxIterations) {
    const res = await apiPost<SyncResponse>(`/api/sync?cursor=${encodeURIComponent(cursor)}`);
    if (res.done) break;
    cursor = res.cursor;
    iterations++;
  }

  if (iterations >= maxIterations && cursor) {
    console.error(`[noxconnect] Sync exceeded max iterations (${maxIterations}). Remaining cursor: ${cursor}`);
    // Return partial success with remaining cursor so callers can resume
    return { ok: false, synced: { repos: init.repos ?? 0, prs: 0, issues: 0, members: 0 }, remainingCursor: cursor };
  }

  return { ok: true, synced: { repos: init.repos ?? 0, prs: 0, issues: 0, members: 0 } };
}

export interface SyncProgress {
  phase: "init" | "syncing" | "done" | "error";
  repo?: string;
  synced: number;
  total: number;
  failed?: string[];
  error?: string;
}

export async function triggerSyncWithProgress(
  onProgress: (status: SyncProgress) => void,
  force = false,
  signal?: AbortSignal,
) {
  let init: SyncResponse;
  try {
    onProgress({ phase: "init", synced: 0, total: 0 });
    init = await apiPost<SyncResponse>("/api/sync");
  } catch (err) {
    if (signal?.aborted) return;
    const msg = err instanceof Error ? err.message : "Sync failed";
    if (!(err instanceof ApiError)) broadcastError(msg);
    onProgress({ phase: "error", synced: 0, total: 0, error: msg });
    return;
  }

  if (init.done) {
    onProgress({ phase: "done", synced: 0, total: 0 });
    return;
  }

  // Iterate the explicit repo list rather than chasing server-returned cursors.
  // A single failing repo must not strand the rest — capture per-repo errors
  // and keep going so every active repo gets its shot.
  const repos = init.repoList ?? (init.cursor ? [init.cursor] : []);
  const total = repos.length;
  const failed: string[] = [];
  const forceParam = force ? "&force=true" : "";
  let synced = 0;

  for (const repo of repos) {
    if (signal?.aborted) return;
    onProgress({ phase: "syncing", repo, synced, total, failed: [...failed] });
    try {
      await apiPost<SyncResponse>(`/api/sync?cursor=${encodeURIComponent(repo)}${forceParam}`);
      synced++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[noxconnect] sync failed for ${repo}:`, msg);
      failed.push(repo);
    }
  }

  if (!signal?.aborted) {
    onProgress({ phase: "done", synced, total, failed });
  }
}

export async function fetchSyncStatus() {
  return apiGet<{ isStale: boolean; lastSync: string | null }>("/api/sync");
}

// Admin-only: backfill missing rows in the events table for every active
// repo. Same cursor-batched shape as triggerSyncWithProgress, just hits
// /api/sync-events. Used by Settings → Live Activity Backfill.
export async function triggerEventsBackfillWithProgress(
  onProgress: (status: SyncProgress) => void,
  signal?: AbortSignal,
) {
  let init: SyncResponse;
  try {
    onProgress({ phase: "init", synced: 0, total: 0 });
    init = await apiPost<SyncResponse>("/api/sync-events");
  } catch (err) {
    if (signal?.aborted) return;
    const msg = err instanceof Error ? err.message : "Backfill failed";
    if (!(err instanceof ApiError)) broadcastError(msg);
    onProgress({ phase: "error", synced: 0, total: 0, error: msg });
    return;
  }

  if (init.done) {
    onProgress({ phase: "done", synced: 0, total: 0 });
    return;
  }

  const repos = init.repoList ?? (init.cursor ? [init.cursor] : []);
  const total = repos.length;
  const failed: string[] = [];
  let synced = 0;

  for (const repo of repos) {
    if (signal?.aborted) return;
    onProgress({ phase: "syncing", repo, synced, total, failed: [...failed] });
    try {
      await apiPost<SyncResponse>(
        `/api/sync-events?cursor=${encodeURIComponent(repo)}`,
      );
      synced++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[noxconnect] event backfill failed for ${repo}:`, msg);
      failed.push(repo);
    }
  }

  if (!signal?.aborted) {
    onProgress({ phase: "done", synced, total, failed });
  }
}

// Recover historic PR/issue rows from archived, transferred, or App-removed
// repositories using the logged-in admin's GitHub access.
export async function recoverRepoHistoryWithProgress(
  onProgress: (status: SyncProgress) => void,
  sourceOrg?: string,
  signal?: AbortSignal,
) {
  const sourceQuery = sourceOrg?.trim()
    ? `?sourceOrg=${encodeURIComponent(sourceOrg.trim())}`
    : "";
  let init: SyncResponse;
  try {
    onProgress({ phase: "init", synced: 0, total: 0 });
    init = await apiPost<SyncResponse & { repoList?: string[] }>(
      `/api/recover-repo-history${sourceQuery}`,
    );
  } catch (err) {
    if (signal?.aborted) return;
    const msg = err instanceof Error ? err.message : "History recovery failed";
    onProgress({ phase: "error", synced: 0, total: 0, error: msg });
    return;
  }

  const repos = init.repoList ?? [];
  const failed: string[] = [];
  let synced = 0;
  for (const repo of repos) {
    if (signal?.aborted) return;
    onProgress({ phase: "syncing", repo, synced, total: repos.length, failed: [...failed] });
    try {
      const result = await apiPost<{ recovered: boolean; inaccessible?: boolean }>(
        `/api/recover-repo-history?cursor=${encodeURIComponent(repo)}${sourceOrg?.trim()
          ? `&sourceOrg=${encodeURIComponent(sourceOrg.trim())}`
          : ""}`,
      );
      if (result.recovered) synced += 1;
      else failed.push(repo);
    } catch {
      failed.push(repo);
    }
  }
  onProgress({ phase: "done", synced, total: repos.length, failed });
}

export async function triggerFeatureSync() {
  return apiPost<{ done: true; scope: "features" }>("/api/sync?scope=features");
}

// ---------- DB-backed API types ----------

interface ApiRepo {
  name: string;
  language: string | null;
  pushed_at: string | null;
  discoveredAt?: string | null;
  acknowledgedAt?: string | null;
  retiredAt?: string | null;
  retirementReason?: string | null;
  transferredTo?: string | null;
  inactive?: boolean;
}

interface ApiPR {
  id: number;
  repo: string;
  number: number;
  title: string;
  state: string;
  author: string | null;
  author_avatar: string | null;
  draft: boolean;
  head_ref: string | null;
  base_ref: string | null;
  merged_at: string | null;
  created_at: string;
  updated_at: string;
  html_url: string;
  requested_reviewers: { login: string }[];
  labels: { name: string; color: string }[];
}

interface ApiIssue {
  id: number;
  repo: string;
  number: number;
  title: string;
  state: string;
  author: string | null;
  author_avatar: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  html_url: string;
  assignees: { login: string; avatar_url?: string }[];
  labels: { name: string; color: string }[];
  milestone_title: string | null;
  closed_by: string | null;
}

interface ApiMember {
  login: string;
  avatar_url: string | null;
  kind: "human" | "bot";
}

// ---------- Transform NoxConnect API → UI shapes ----------

function transformPR(pr: ApiPR) {
  return {
    id: pr.id,
    number: pr.number,
    title: pr.title,
    state: pr.state,
    created_at: pr.created_at,
    updated_at: pr.updated_at,
    merged_at: pr.merged_at,
    draft: pr.draft,
    user: pr.author ? { login: pr.author, avatar_url: pr.author_avatar ?? "" } : null,
    head: { ref: pr.head_ref ?? "", repo: { name: pr.repo, full_name: pr.repo } },
    base: { ref: pr.base_ref ?? "" },
    html_url: pr.html_url,
    requested_reviewers: pr.requested_reviewers,
    labels: pr.labels,
    repo: pr.repo,
  };
}

function transformIssue(issue: ApiIssue) {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    state: issue.state,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
    user: issue.author ? { login: issue.author, avatar_url: issue.author_avatar ?? "" } : null,
    assignees: issue.assignees.map((a) => ({ login: a.login, avatar_url: a.avatar_url ?? "" })),
    labels: issue.labels,
    milestone: issue.milestone_title ? { title: issue.milestone_title } : null,
    html_url: issue.html_url,
    repo: issue.repo,
    closed_by: issue.closed_by,
  };
}

// ---------- Data fetchers (call our API) ----------

// fetchRepos defaults to ACTIVE repos only. Pass { includeAll: true } from
// Settings' repo-management UI to see drafts/archived/noxconnect-repo as well
// (each row carries an `inactive` flag in that case).
export async function fetchRepos(opts?: { includeAll?: boolean }) {
  const query = opts?.includeAll ? "?include=all" : "";
  const repos = await apiGet<ApiRepo[]>(`/api/repos${query}`);
  return repos.map((r) => ({
    id: 0,
    name: r.name,
    full_name: r.name,
    description: null,
    open_issues_count: 0,
    pushed_at: r.pushed_at,
    language: r.language,
    visibility: "private",
    inactive: r.inactive ?? false,
    discoveredAt: r.discoveredAt ?? null,
    acknowledgedAt: r.acknowledgedAt ?? null,
    retiredAt: r.retiredAt ?? null,
    retirementReason: r.retirementReason ?? null,
    transferredTo: r.transferredTo ?? null,
  }));
}

// Mark one or more repos as reviewed by an admin. Used by:
//   - NewRepoBanner "Dismiss all" → all unacknowledged names
//   - Settings → Newly detected "Acknowledge all" → all listed names
//   - Per-row Track / Mark draft → that one name (after the draft toggle)
//
// Backend is idempotent (COALESCE keeps the first-acknowledgment timestamp).
export async function acknowledgeRepos(names: string[]) {
  if (names.length === 0) return { acknowledged: [], changes: 0 };
  return apiPost<{ acknowledged: string[]; changes: number }>(
    "/api/repos/acknowledge",
    { names },
  );
}

interface PaginatedPRResponse {
  data: ApiPR[];
  totalCount: number;
  page: number;
  pageSize: number;
}

async function fetchAllPRPages(baseParams: Record<string, string>) {
  const PAGE_SIZE = 500;
  const all: ApiPR[] = [];
  let page = 1;

  while (true) {
    const params = new URLSearchParams({ ...baseParams, page_size: String(PAGE_SIZE), page: String(page) });
    const res = await apiGet<PaginatedPRResponse | ApiPR[]>(`/api/prs?${params}`);
    // Handle both old (array) and new (paginated) response formats
    if (Array.isArray(res)) {
      all.push(...res);
      break;
    }
    all.push(...res.data);
    if (all.length >= res.totalCount || res.data.length < PAGE_SIZE) break;
    page++;
  }

  return all.map(transformPR);
}

export function fetchOpenPRs() {
  return fetchAllPRPages({ state: "open" });
}

export function fetchMergedPRs(since?: string) {
  const params: Record<string, string> = { state: "merged" };
  if (since) params.since = since;
  return fetchAllPRPages(params);
}

export function fetchAllPRs(since?: string) {
  const params: Record<string, string> = { state: "all" };
  if (since) params.since = since;
  return fetchAllPRPages(params);
}

export async function fetchOpenIssues() {
  const res = await apiGet<{ data: ApiIssue[]; totalCount: number }>("/api/issues?state=open");
  return res.data.map(transformIssue);
}

export async function fetchClosedIssues(since?: string) {
  const params = new URLSearchParams({ state: "closed", page_size: "5000" });
  if (since) params.set("closed_since", since);
  const res = await apiGet<{ data: ApiIssue[]; totalCount: number }>(`/api/issues?${params}`);
  return res.data.map(transformIssue);
}

export async function fetchAllIssues(since?: string) {
  const params = new URLSearchParams({ state: "all", page_size: "5000" });
  if (since) params.set("since", since);
  const res = await apiGet<{ data: ApiIssue[]; totalCount: number }>(`/api/issues?${params}`);
  return res.data.map(transformIssue);
}

export async function updateIssueState(repo: string, issueNumber: number, state: "open" | "closed") {
  return apiPost<{ ok: boolean; state: string; closed_at: string | null }>("/api/issue-state", {
    repo,
    issue_number: issueNumber,
    state,
  });
}

export async function fetchOrgMembers() {
  const members = await apiGet<ApiMember[]>("/api/members");
  return members.map((m) => ({
    login: m.login,
    avatar_url: m.avatar_url ?? "",
    id: 0,
    type: (m.kind === "bot" ? "Bot" : "User") as "Bot" | "User",
    kind: m.kind,
  }));
}

export interface TeamsResponse {
  teams: { slug: string; name: string }[];
  memberships: Record<string, string[]>;
}

export async function fetchTeams(): Promise<TeamsResponse> {
  return apiGet<TeamsResponse>("/api/teams");
}

// ---------- Paginated issues ----------

export interface PaginatedResponse<T> {
  data: T[];
  totalCount: number;
  page: number;
  pageSize: number;
}

export interface IssueQueryParams {
  state?: "open" | "closed" | "all";
  page?: number;
  pageSize?: number;
  repos?: string[];
  assignee?: string;
  assigned?: "true" | "false"; // filter by has-assignee / no-assignee
  label?: string;
  stale?: boolean;
  sort?: "updated_at" | "created_at" | "number" | "title" | "repo";
  sortDir?: "asc" | "desc";
  closedSince?: string;
  closedBefore?: string;
}

export interface PrQueryParams {
  state?: "open" | "closed" | "merged" | "all";
  page?: number;
  pageSize?: number;
  repo?: string;
  author?: string;
  draft?: boolean;
  stale?: boolean;
  since?: string;
  sort?: "updated_at" | "created_at" | "number" | "title" | "repo" | "author";
  sortDir?: "asc" | "desc";
}

export async function fetchPaginatedIssues(params: IssueQueryParams): Promise<PaginatedResponse<ReturnType<typeof transformIssue>>> {
  const qs = new URLSearchParams();
  if (params.state) qs.set("state", params.state);
  if (params.page) qs.set("page", String(params.page));
  if (params.pageSize) qs.set("page_size", String(params.pageSize));
  if (params.repos?.length) qs.set("repos", params.repos.join(","));
  if (params.assignee) qs.set("assignee", params.assignee);
  if (params.assigned) qs.set("assigned", params.assigned);
  if (params.label) qs.set("label", params.label);
  if (params.stale) qs.set("stale", "1");
  if (params.sort) qs.set("sort", params.sort);
  if (params.sortDir) qs.set("sort_dir", params.sortDir);
  if (params.closedSince) qs.set("closed_since", params.closedSince);
  if (params.closedBefore) qs.set("closed_before", params.closedBefore);

  const raw = await apiGet<{ data: ApiIssue[]; totalCount: number; page: number; pageSize: number }>(
    `/api/issues?${qs}`,
  );
  return {
    data: raw.data.map(transformIssue),
    totalCount: raw.totalCount,
    page: raw.page,
    pageSize: raw.pageSize,
  };
}

export async function fetchIssueLabels(): Promise<{ name: string; color: string }[]> {
  return apiGet<{ name: string; color: string }[]>("/api/issues?meta=labels");
}

export async function fetchPaginatedPrs(
  params: PrQueryParams,
): Promise<PaginatedResponse<ReturnType<typeof transformPR>>> {
  const qs = new URLSearchParams();
  if (params.state) qs.set("state", params.state);
  if (params.page) qs.set("page", String(params.page));
  if (params.pageSize) qs.set("page_size", String(params.pageSize));
  if (params.repo) qs.set("repo", params.repo);
  if (params.author) qs.set("author", params.author);
  if (params.draft) qs.set("draft", "1");
  if (params.stale) qs.set("stale", "1");
  if (params.since) qs.set("since", params.since);
  if (params.sort) qs.set("sort", params.sort);
  if (params.sortDir) qs.set("sort_dir", params.sortDir);

  const raw = await apiGet<{ data: ApiPR[]; totalCount: number; page: number; pageSize: number }>(
    `/api/prs?${qs}`,
  );
  return {
    data: raw.data.map(transformPR),
    totalCount: raw.totalCount,
    page: raw.page,
    pageSize: raw.pageSize,
  };
}

export async function fetchIssueDetail(repo: string, number: number) {
  const raw = await apiGet<{ issue: ApiIssue }>(
    `/api/issues/${encodeURIComponent(repo)}/${number}`,
  );
  return transformIssue(raw.issue);
}

export async function fetchPrDetail(repo: string, number: number) {
  const raw = await apiGet<{ pr: ApiPR }>(
    `/api/prs/${encodeURIComponent(repo)}/${number}`,
  );
  return transformPR(raw.pr);
}

export interface IssueBody {
  body: string | null;
  comments: number;
  reactions_total: number;
}

export async function fetchIssueBody(
  _owner: string,
  repo: string,
  number: number,
): Promise<IssueBody> {
  return apiGet<IssueBody>(`/api/github/details?kind=issue&repo=${encodeURIComponent(repo)}&number=${number}`);
}

export interface PrBody {
  body: string | null;
  comments: number;
  review_comments: number;
  additions: number;
  deletions: number;
  changed_files: number;
  merged: boolean;
  mergeable: boolean | null;
}

export async function fetchPrBody(
  _owner: string,
  repo: string,
  number: number,
): Promise<PrBody> {
  return apiGet<PrBody>(`/api/github/details?kind=pr&repo=${encodeURIComponent(repo)}&number=${number}`);
}

export interface IssueStats {
  open: number;
  unassigned: number;
  stale: number;
  byRepo: { repo: string; count: number; critical: number; stale: number }[];
  byLabel: { name: string; color: string; count: number }[];
  closedPerDay: { day: string; count: number; critical: number }[];
}

export async function fetchIssueStats(repos?: string[]): Promise<IssueStats> {
  const params = new URLSearchParams({ meta: "stats" });
  if (repos && repos.length > 0) params.set("repos", repos.join(","));
  return apiGet<IssueStats>(`/api/issues?${params}`);
}

export interface PRStats {
  open: number;
  draft: number;
  stale: number;
  byRepo: { repo: string; count: number; draft: number }[];
}

export async function fetchPRStats(): Promise<PRStats> {
  return apiGet<PRStats>("/api/prs?meta=stats");
}

// Admin-only. Closes a PR on GitHub via /api/prs/close and mirrors the
// state=closed change to D1 so the caller can invalidate PR queries and see
// the row drop out immediately.
export async function closePR(repo: string, number: number): Promise<void> {
  await apiPost<{ ok: true }>("/api/prs/close", { repo, number });
}

// Per-member counts for the Engineers tab, aggregated server-side. Each map is
// keyed by GitHub login. See functions/api/engineer-stats.ts.
export interface EngineerStats {
  openPRs: Record<string, number>;
  reviewing: Record<string, number>;
  approvalsGiven: Record<string, number>;
  mergesOfOthers: Record<string, number>;
  assignedIssues: Record<string, number>;
  lifetimePRs: Record<string, number>;
  prsLast4Weeks: Record<string, number>;
  lifetimeCommits: Record<string, number>;
  commitsLast4Weeks: Record<string, number>;
  issuesClosed: Record<string, number>;
  coverage: {
    approvalsGivenSince: string | null;
    mergedByKnown: number;
    mergedPRs: number;
    issuesClosedByKnown: number;
    closedIssues: number;
  };
  prAudits: Record<string, {
    startMonth: string;
    endMonth: string;
    completedAt: string;
    githubPRs: number;
    cachedAllPRs: number;
    cachedTrackedPRs: number;
  }>;
}

export async function fetchEngineerStats(): Promise<EngineerStats> {
  return apiGet<EngineerStats>("/api/engineer-stats");
}

// Tracked-repository contribution counts for one engineer. Daily maps are keyed
// by "YYYY-MM-DD" for the selected month; monthly maps are keyed by "YYYY-MM".
export interface EngineerActivity {
  login: string;
  month: string;
  firstMonth: string | null;
  prsOpened: Record<string, number>;
  prsMerged: Record<string, number>;
  prsReviewed: Record<string, number>;
  commits: Record<string, number>;
  monthlyOpened: Record<string, number>;
  monthlyMerged: Record<string, number>;
  monthlyReviewed: Record<string, number>;
  monthlyCommits: Record<string, number>;
}

export async function fetchEngineerActivity(login: string, month?: string): Promise<EngineerActivity> {
  const qs = new URLSearchParams({ login });
  if (month) qs.set("month", month);
  return apiGet<EngineerActivity>(`/api/engineer-activity?${qs}`);
}

export async function updateIssueAssignees(
  repo: string,
  issueNumber: number,
  assignees: string[],
): Promise<{ assignees: { login: string; avatar_url: string }[] }> {
  return apiPost("/api/assign", { repo, issue_number: issueNumber, assignees });
}
