export type CueKeyKind = "publishable" | "secret";
export type NoxCueEnvironment = "production" | "staging" | "development" | "preview" | "test" | "local";

export interface NoxCueSourceInput {
  name: string;
  environment: NoxCueEnvironment;
  enabled: boolean;
  alertsEnabled: boolean;
  projectId: string | null;
  timezone: string;
  digestEnabled: boolean;
  digestTimeLocal: string;
  slackChannelId: string | null;
  slackConnectionId: string | null;
  allowedOrigins: string[];
  healthEnabled: boolean;
  healthUrl: string | null;
}

export interface NoxCueMetricsResponse {
  catalog: Array<{
    key: string;
    label: string;
    domain: "users" | "auth" | "errors" | "activity";
    unit: "count" | "ratio" | "decimal";
    origin: "reported" | "calculated";
    description: string;
    formulaKey: string | null;
    version: number;
  }>;
  days: Array<{
    period: string;
    metrics: Record<string, { value: number; origin: "reported" | "calculated"; updatedAt: string }>;
  }>;
  digests: Array<{ period: string; createdAt: string; status: string; deliveredAt: string | null }>;
  errorGroups: Array<{
    fingerprint: string;
    title: string;
    errorCode: string | null;
    component: string | null;
    environment: string | null;
    firstSeenAt: string;
    lastSeenAt: string;
    occurrenceCount: number;
    lastNotifiedAt: string | null;
    status: "open" | "acknowledged" | "resolved";
    acknowledgedAt: string | null;
    acknowledgedBy: string | null;
    resolvedAt: string | null;
    resolvedBy: string | null;
  }>;
}

export interface NoxCueSource extends NoxCueSourceInput {
  id: string;
  projectName: string | null;
  effectiveSlackChannelId: string | null;
  effectiveSlackConnectionId: string | null;
  slackRouteLevel: "source" | "project" | "organization" | "fallback" | null;
  lastRegistrationAt: string | null;
  lastActivityAt: string | null;
  createdAt: string;
  healthStatus: "waiting" | "healthy" | "issue";
  healthLastCheckedAt: string | null;
  healthLastError: string | null;
  healthLastStatusCode: number | null;
  healthLastLatencyMs: number | null;
  effectiveAlertSlackChannelId: string | null;
  effectiveAlertSlackConnectionId: string | null;
  alertSlackRouteLevel: "source" | "project" | "organization" | "fallback" | null;
  keys: Array<{
    id: string;
    name: string;
    kind: CueKeyKind;
    prefix: string;
    createdAt: string;
    lastUsedAt: string | null;
    revokedAt: string | null;
  }>;
}

export interface NoxCueFeaturesResponse {
  scope: { type: "project" | "source"; id: string; name: string };
  features: Array<{
    key: string; kind: "standard" | "custom"; enabled: boolean;
    label: string; description: string; failureMessage: string;
    status: "waiting" | "healthy" | "issue";
    consecutiveFailures: number; lastResultAt: string | null; lastSuccessAt: string | null;
    lastFailureAt: string | null; lastReason: string | null; incidentStartedAt: string | null;
    successes24h: number; rejections24h: number; failures24h: number; lastTestAt: string | null;
  }>;
}

export interface NoxCueCustomFeatureInput {
  key: string;
  label: string;
  failureMessage: string;
}

export interface NoxCueCustomFeatureUpdate {
  label: string;
  failureMessage: string;
  enabled: boolean;
}

export interface NoxCueCustomMetricsResponse {
  scope: { type: "project" | "source"; id: string; name: string };
  metrics: Array<{
    key: string;
    label: string;
    enabled: boolean;
    active: boolean;
    lastEventAt: string | null;
    outputs: Array<{ key: string; label: string; unit: "count" | "decimal" }>;
  }>;
}

export interface NoxCueCustomMetricInput { key: string; label: string }
export interface NoxCueCustomMetricUpdate { label: string; enabled: boolean }

export interface NoxCueSourcesResponse {
  projects: Array<{ id: string; name: string; repo: string | null }>;
  sources: NoxCueSource[];
}

export interface NoxCueAppleConnection {
  connected: boolean;
  appId?: string;
  keyId?: string;
  status?: "waiting_for_reports" | "active" | "error";
  lastSyncedAt?: string | null;
  lastSuccessfulPeriod?: string | null;
  lastError?: string | null;
  createdAt?: string;
}

export interface NoxCueAppleConnectionInput {
  appId: string;
  issuerId: string;
  keyId: string;
  privateKey: string;
}

export interface NoxCueDashboardShare {
  id: string;
  projectId: string;
  slug: string;
  enabled: boolean;
  updatedAt?: string;
}

export interface NoxCueEventsResponse {
  events: Array<{
    id: string;
    type: string;
    title: string;
    event: Record<string, unknown>;
    receivedAt: string;
    deliveryStatus: string | null;
    deliveredAt: string | null;
  }>;
}

export type NoxCueUserMetricKey =
  | "users.new"
  | "users.total"
  | "users.active.daily"
  | "users.active.weekly"
  | "users.active.monthly"
  | "users.stickiness.dau_mau";

export interface NoxCueProjectMetricsResponse {
  project: { id: string; name: string };
  sourceCount: number;
  enabledSourceCount: number;
  metrics: Array<{
    key: NoxCueUserMetricKey;
    label: string;
    unit: "count" | "ratio";
    description: string;
    enabled: boolean;
    active: boolean;
    lastEventAt: string | null;
  }>;
}

export interface NoxCueGithubIssueProject {
  projectId: string;
  projectName: string;
  repo: string | null;
  enabled: boolean;
  environments: NoxCueEnvironment[];
  commentOnRepeat: boolean;
  repeatIntervalMinutes: number;
  openIncidents: number;
}

export interface NoxCueGithubIssueSettingsResponse {
  githubConnected: boolean;
  projects: NoxCueGithubIssueProject[];
}
