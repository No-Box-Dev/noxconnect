export interface OrgInfo {
  login: string;
  avatar_url: string;
  description: string | null;
}

export interface RepoInfo {
  id: number;
  name: string;
  full_name: string;
  description: string | null;
  open_issues_count: number;
  pushed_at: string | null;
  language: string | null;
  visibility: string;
  // First time this (org_id, name) was seen by sync. Set on first insert,
  // preserved via COALESCE on every subsequent reconcile.
  discoveredAt?: string | null;
  // Set by POST /api/repos/acknowledge when an admin reviews the repo.
  // NULL means the repo is "new" and should appear in the NewRepoBanner
  // + Settings → Newly detected section.
  acknowledgedAt?: string | null;
  retiredAt?: string | null;
  retirementReason?: string | null;
  transferredTo?: string | null;
  // True for drafts (platform-archived), GH-archived, or the noxconnect repo.
  // Only present when the endpoint is called with `?include=all`.
  inactive?: boolean;
}

export interface PRInfo {
  id: number;
  number: number;
  title: string;
  state: string;
  created_at: string;
  updated_at: string;
  user: { login: string; avatar_url: string } | null;
  labels: { name: string; color: string }[];
  draft: boolean;
  requested_reviewers: { login: string }[];
  head: { ref: string; repo: { name: string; full_name: string } | null };
  base: { ref: string };
  html_url: string;
}

export interface IssueInfo {
  id: number;
  number: number;
  title: string;
  state: string;
  created_at: string;
  updated_at: string;
  user: { login: string; avatar_url: string } | null;
  labels: { name: string; color: string }[];
  assignees: { login: string; avatar_url: string }[];
  milestone: { title: string } | null;
  html_url: string;
}

export type TabId =
  | "current"
  | "sprint"
  | "specs"
  | "prs"
  | "issues"
  | "admin"
  | "posts"
  | "repos"
  | "engineers";

export interface NoxSpotSite {
  id: string;
  name: string;
  projectId: string | null;
  repo: string | null;
  buttonColor: string;
  buttonText: string;
  widgetMode: "development" | "release";
  autoErrorLogging: boolean;
  environments: NoxSpotEnvironment[];
  blocks: NoxSpotBlock[];
  slackChannelId: string | null;
  slackConnectionId: string | null;
  slackEffectiveChannelId: string | null;
  slackUsesFallback: boolean;
  slackHealth: "disabled" | "disconnected" | "pending" | "connected" | "degraded";
  slackLastDeliveredAt: string | null;
  slackPendingCount: number;
  slackBlockedCount: number;
  slackLastError: string | null;
  dailySummaryEnabled: boolean;
  issueCount: number;
  openIssueCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface NoxSpotEnvironment {
  name: string;
  url: string;
  buttonColor?: string | null;
  buttonText?: string | null;
  widgetMode?: "development" | "release" | null;
  enabled?: boolean;
}

export interface NoxSpotBlock {
  id: string;
  type: "title" | "description" | "reporter" | "contact_email" | "custom_text" | "custom_textarea" | "custom_select" | "element_picker" | "metadata" | "console_logs";
  label?: string | null;
  required?: boolean;
  options?: string[];
  environments?: string[];
}

export interface NavFilter {
  person?: string;
  view?: string;
}

/** PR where the user is a requested reviewer */
export interface ReviewPR {
  repo: string;
  number: number;
  title: string;
  state: string;
  draft: boolean;
  merged_at: string | null;
  html_url: string;
  author: string | null;
  created_at: string;
}

/** Cross-repo issue assigned to the user (sourced from D1, not noxconnect repo) */
export interface AssignedIssue {
  repo: string;
  number: number;
  title: string;
  state: "open" | "closed";
  html_url: string;
  labels: { name: string; color: string }[];
  created_at: string;
}

// noxconnect config repo types

// Status IDs are now admin-configurable per org (see BoardStage + useBoardStages).
// The default ids match the historical scheme so existing features keep working
// before an admin customises anything.
export type FeatureStatus = string;

/** An admin-configurable board column. `id` is the GitHub label suffix (`status:<id>`). */
export interface BoardStage {
  id: string;
  label: string;
  color: string; // hex, e.g. "#94a3b8"
}

export interface StatusHistoryEntry {
  status: FeatureStatus;
  timestamp: string; // ISO 8601
}

/** A link from a feature out to a spec / doc / design (any external URL). */
export interface SpecLink {
  url: string;       // http(s) only — sanitized server-side before storage
  label?: string;    // optional friendly name; falls back to the URL when absent
  /** At most one link per Spec's `links` array may be primary. When set,
   * external chip-clicks (e.g. on FeatureCard) open this link; when unset
   * the first link is the effective primary. */
  primary?: boolean;
}

export interface Feature {
  id: number;
  title: string;
  owners: string[];
  status: FeatureStatus;
  url?: string;
  updatedAt?: string;
  statusHistory?: StatusHistoryEntry[];
  specLinks?: SpecLink[];
  /** Backlogged features are parked out of the kanban board — they keep
   * their status label so returning to the board lands them in the
   * column they left. Derived from the `backlog` GitHub label. */
  backlog?: boolean;
  // True while an optimistic create is in flight — the card carries a
  // temporary negative id and renders non-interactive until GitHub assigns
  // the real issue number. Never set on features returned by the server.
  pending?: boolean;
}

export interface Person {
  github: string;
  name: string;
  role: string;
  team?: string;
  description?: string;
}

// Manual Specs feature (see /api/specs). Specs live entirely in D1 —
// no GitHub round-trip, no repo folder proxy.

/** A file attached to a Spec. Bytes live in R2; this row carries the
 * metadata + a serverside-derived kind so the client picks the right
 * viewer without re-sniffing the filename. */
export type SpecAttachmentKind = "markdown" | "pdf" | "docx" | "html" | "other";

export interface SpecAttachment {
  id: number;
  filename: string;
  contentType: string;
  size: number;
  uploadedBy: string;
  uploadedAt: string;
  kind: SpecAttachmentKind;
}

/** A single spec: Markdown description + external links, belonging to a
 * Feature (via issue number) or Unfiled. */
export interface Spec {
  id: number;
  /** Issue number of the Feature this spec belongs to, or null when unfiled. */
  featureNumber: number | null;
  /** Selected direct link for its Feature when that Feature has multiple specs. */
  isPrimary: boolean;
  title: string;
  description: string;
  links: SpecLink[];
  archived: boolean;
  archivedAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface OrgSettings {
  // NoxConnect is always enabled and is therefore not stored here. Missing
  // optional-app values default to true for backwards compatibility.
  apps?: {
    noxticket?: boolean;
    noxfeed?: boolean;
    noxspot?: boolean;
    noxcue?: boolean;
  };
  excludedMembers?: string[];
  noxTicketRepo?: string;
  boardStages?: BoardStage[];
  // Admin-editable system prompt for the Release-notes feed. Empty/missing
  // falls back to the bundled default (RELEASE_NOTES_SYSTEM in
  // functions/lib/prompt.js). The LLM provider/model is NOT configurable
  // per-feed — both Posts and Release notes share the org's LLM config.
  releaseNotesPrompt?: string;
  noxfeedDailySummary?: {
    enabled: boolean;
    timeLocal: string;
    timezone: string;
  };
  // Service-specific Slack routing. The bot install (token + team metadata)
  // lives in slack_settings; config stores public channel IDs only.
  slack?: {
    fallbackChannelId?: string;
    fallbackConnectionId?: string;
    noxCueChannelId?: string;
    noxCueConnectionId?: string;
    noxTicketChannelId?: string;
    noxTicketConnectionId?: string;
    postsChannelId?: string;
    postsConnectionId?: string;
    releaseNotesChannelId?: string;
    releaseNotesConnectionId?: string;
    dailySummaryChannelId?: string;
    dailySummaryConnectionId?: string;
    /** @deprecated Adopted by both NoxFeed routes until dedicated choices are saved. */
    noxFeedChannelId?: string;
  };
  // Policy for newly-discovered repos.
  //  - 'include' (default): the repo is active immediately (current behavior).
  //  - 'exclude':           the repo is platform-archived (draft) on first
  //                         insert so it stays out of every active scope
  //                         until an admin clicks Track in the Newly
  //                         detected section. The discovery banner +
  //                         TopNav dot still surface either way.
  newRepoDefault?: "include" | "exclude";
}

// Extended issue info with repo context
export interface IssueWithRepo extends IssueInfo {
  repo: string;
}

// Metric types
export interface WeeklyBucket {
  weekStart: string;
  value: number;
}

export interface MetricData {
  current: number;
  previous: number;
  change: number;
  history: WeeklyBucket[];
}
