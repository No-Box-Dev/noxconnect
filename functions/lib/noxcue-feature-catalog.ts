export const STANDARD_NOXCUE_FEATURES = [
  { key: "auth.signup", label: "Sign up", description: "Can a new user create an account?", failureMessage: "A user was prevented from signing up." },
  { key: "auth.login", label: "Log in", description: "Can an existing user authenticate?", failureMessage: "A user was prevented from logging in." },
  { key: "auth.password_reset", label: "Password reset", description: "Can a user request or complete a password reset?", failureMessage: "A user was prevented from resetting their password." },
  { key: "auth.email_verification", label: "Email verification", description: "Can a user verify their email address?", failureMessage: "A user was prevented from verifying their email address." },
  { key: "auth.oauth", label: "OAuth / SSO", description: "Can a user authenticate through an external identity provider?", failureMessage: "A user was prevented from signing in with an external provider." },
  { key: "auth.mfa", label: "Multi-factor authentication", description: "Can a user complete the second authentication factor?", failureMessage: "A user was prevented from completing multi-factor authentication." },
  { key: "auth.session_refresh", label: "Session refresh", description: "Can an authenticated session stay valid?", failureMessage: "A user's authenticated session could not be refreshed." },
  { key: "auth.logout", label: "Log out", description: "Can a user end the current session?", failureMessage: "A user was prevented from logging out." },
] as const;

export interface CueFeatureScope {
  sourceId: string; sourceName: string; projectId: string | null; projectName: string | null;
}

interface CueCustomFeatureRow {
  feature_key: string; label: string; failure_message: string; enabled: number;
}

export async function findCueFeatureScope(
  db: D1Database,
  orgId: number,
  orgLogin: string,
  sourceId: string,
  projectId?: string | null,
): Promise<CueFeatureScope | null> {
  const row = await db.prepare(
    `SELECT source.id AS source_id, source.name AS source_name,
            source.project_id, project.name AS project_name
       FROM cue_sources source
       LEFT JOIN projects project ON project.id = source.project_id
      WHERE source.id = ? AND source.org_id = ? AND source.owner_id = ?${projectId ? " AND source.project_id = ?" : ""}`,
  ).bind(...(projectId ? [sourceId, orgId, orgLogin, projectId] : [sourceId, orgId, orgLogin])).first<{
    source_id: string; source_name: string; project_id: string | null; project_name: string | null;
  }>();
  return row ? { sourceId: row.source_id, sourceName: row.source_name, projectId: row.project_id, projectName: row.project_name } : null;
}

async function loadCustomCueFeatures(db: D1Database, orgId: number, scope: CueFeatureScope): Promise<CueCustomFeatureRow[]> {
  const result = await db.prepare(
    `SELECT feature_key, label, failure_message, enabled
       FROM cue_custom_features
      WHERE org_id = ?
        AND ((? IS NOT NULL AND project_id = ?)
          OR (? IS NULL AND source_id = ?))
      ORDER BY label COLLATE NOCASE, feature_key`,
  ).bind(orgId, scope.projectId, scope.projectId, scope.projectId, scope.sourceId).all<CueCustomFeatureRow>();
  return result.results ?? [];
}

interface FeatureStateRow {
  feature_key: string; status: "waiting" | "healthy" | "issue"; consecutive_failures: number;
  consecutive_successes: number;
  last_result_at: string | null; last_success_at: string | null; last_failure_at: string | null;
  last_reason: string | null; incident_started_at: string | null;
}

interface FeatureCountRow {
  feature_key: string; successes_24h: number; rejections_24h: number;
  failures_24h: number; last_test_at: string | null;
}

export async function loadCueFeatureCatalog(db: D1Database, orgId: number, scope: CueFeatureScope) {
  const [custom, stateResult, countResult] = await Promise.all([
    loadCustomCueFeatures(db, orgId, scope),
    db.prepare(
      `SELECT feature_key, status, consecutive_failures, consecutive_successes, last_result_at,
              last_success_at, last_failure_at, last_reason, incident_started_at
         FROM cue_feature_states WHERE source_id = ?`,
    ).bind(scope.sourceId).all<FeatureStateRow>(),
    db.prepare(
      `SELECT feature_key,
              SUM(CASE WHEN is_test = 0 AND outcome = 'success' AND datetime(received_at) >= datetime('now', '-24 hours') THEN 1 ELSE 0 END) AS successes_24h,
              SUM(CASE WHEN is_test = 0 AND outcome = 'rejected' AND datetime(received_at) >= datetime('now', '-24 hours') THEN 1 ELSE 0 END) AS rejections_24h,
              SUM(CASE WHEN is_test = 0 AND outcome = 'failure' AND datetime(received_at) >= datetime('now', '-24 hours') THEN 1 ELSE 0 END) AS failures_24h,
              MAX(CASE WHEN is_test = 1 THEN received_at END) AS last_test_at
         FROM cue_feature_results WHERE source_id = ? GROUP BY feature_key`,
    ).bind(scope.sourceId).all<FeatureCountRow>(),
  ]);
  const states = new Map((stateResult.results ?? []).map((row) => [row.feature_key, row]));
  const counts = new Map((countResult.results ?? []).map((row) => [row.feature_key, row]));
  const definitions = [
    ...STANDARD_NOXCUE_FEATURES.map((feature) => ({ ...feature, kind: "standard" as const, enabled: true })),
    ...custom.map((feature) => ({ key: feature.feature_key, label: feature.label,
      description: feature.failure_message, failureMessage: feature.failure_message,
      kind: "custom" as const, enabled: feature.enabled === 1 })),
  ];
  return {
    scope: { type: scope.projectId ? "project" as const : "source" as const,
      id: scope.projectId ?? scope.sourceId, name: scope.projectName ?? scope.sourceName },
    features: definitions.map((definition) => {
      const state = states.get(definition.key);
      const count = counts.get(definition.key);
      return { ...definition, status: state?.status ?? "waiting",
        consecutiveFailures: Number(state?.consecutive_failures ?? 0),
        consecutiveSuccesses: Number(state?.consecutive_successes ?? 0),
        lastResultAt: state?.last_result_at ?? null, lastSuccessAt: state?.last_success_at ?? null,
        lastFailureAt: state?.last_failure_at ?? null, lastReason: state?.last_reason ?? null,
        incidentStartedAt: state?.incident_started_at ?? null,
        successes24h: Number(count?.successes_24h ?? 0), rejections24h: Number(count?.rejections_24h ?? 0),
        failures24h: Number(count?.failures_24h ?? 0), lastTestAt: count?.last_test_at ?? null };
    }),
  };
}
