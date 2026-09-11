export const NOXCUE_USER_METRIC_KEYS = Object.freeze([
  "users.new",
  "users.total",
  "users.active.daily",
  "users.active.weekly",
  "users.active.monthly",
  "users.stickiness.dau_mau",
]);

export const NOXCUE_APPLE_METRIC_KEYS = Object.freeze([
  "apple.downloads.total",
  "apple.downloads.first_time",
  "apple.downloads.redownloads",
  "apple.installations",
  "apple.deletions",
  "apple.sessions",
  "apple.crashes",
]);

const NOXCUE_USER_METRIC_SET = new Set(NOXCUE_USER_METRIC_KEYS);
const REGISTRATION_METRICS = new Set(["users.new", "users.total"]);

export function isNoxCueUserMetricKey(value) {
  return typeof value === "string" && NOXCUE_USER_METRIC_SET.has(value);
}

export async function loadNoxCueProjectMetrics(db, orgId, projectId) {
  const [catalog, sourceState] = await Promise.all([
    db.prepare(
      `SELECT definition.key, definition.label, definition.unit, definition.description,
              COALESCE(setting.enabled, 1) AS enabled
         FROM cue_metric_definitions definition
         LEFT JOIN cue_project_metric_settings setting
           ON setting.metric_key = definition.key
          AND setting.project_id = ?
          AND setting.org_id = ?
        WHERE definition.key IN (${NOXCUE_USER_METRIC_KEYS.map(() => "?").join(", ")})
        ORDER BY CASE definition.key
          WHEN 'users.new' THEN 1
          WHEN 'users.total' THEN 2
          WHEN 'users.active.daily' THEN 3
          WHEN 'users.active.weekly' THEN 4
          WHEN 'users.active.monthly' THEN 5
          ELSE 6 END`,
    ).bind(projectId, orgId, ...NOXCUE_USER_METRIC_KEYS).all(),
    db.prepare(
      `WITH project_sources AS (
         SELECT id, enabled FROM cue_sources WHERE org_id = ? AND project_id = ?
       )
       SELECT
         (SELECT COUNT(*) FROM project_sources) AS source_count,
         (SELECT COUNT(*) FROM project_sources WHERE enabled = 1) AS enabled_source_count,
         (SELECT MAX(registration.received_at)
            FROM cue_user_registrations registration
            JOIN project_sources source ON source.id = registration.source_id
           WHERE source.enabled = 1) AS registration_last_received_at,
         (SELECT MAX(active.received_at)
            FROM cue_user_active_days active
            JOIN project_sources source ON source.id = active.source_id
           WHERE source.enabled = 1) AS activity_last_received_at`,
    ).bind(orgId, projectId).first(),
  ]);

  const enabledSourceCount = Number(sourceState?.enabled_source_count ?? 0);
  const registrationLastReceivedAt = sourceState?.registration_last_received_at
    ? String(sourceState.registration_last_received_at)
    : null;
  const activityLastReceivedAt = sourceState?.activity_last_received_at
    ? String(sourceState.activity_last_received_at)
    : null;

  return {
    sourceCount: Number(sourceState?.source_count ?? 0),
    enabledSourceCount,
    metrics: (catalog.results ?? []).map((row) => {
      const key = String(row.key);
      const lastEventAt = REGISTRATION_METRICS.has(key)
        ? registrationLastReceivedAt
        : activityLastReceivedAt;
      return {
        key,
        label: String(row.label),
        unit: String(row.unit),
        description: String(row.description),
        enabled: Number(row.enabled) === 1,
        active: enabledSourceCount > 0 && lastEventAt !== null,
        lastEventAt,
      };
    }),
  };
}

export async function saveNoxCueProjectMetrics(db, orgId, projectId, enabledMetricKeys, updatedBy) {
  const enabled = new Set(enabledMetricKeys);
  await db.batch(NOXCUE_USER_METRIC_KEYS.map((metricKey) => db.prepare(
    `INSERT INTO cue_project_metric_settings
       (org_id, project_id, metric_key, enabled, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
     ON CONFLICT(project_id, metric_key) DO UPDATE SET
       enabled = excluded.enabled,
       updated_by = excluded.updated_by,
       updated_at = excluded.updated_at`,
  ).bind(orgId, projectId, metricKey, enabled.has(metricKey) ? 1 : 0, updatedBy)));
}

/**
 * @param {D1Database} db
 * @param {number} orgId
 * @param {string|null} projectId
 * @param {string|null} [sourceId]
 */
export async function loadEnabledNoxCueMetricKeys(db, orgId, projectId, sourceId = null) {
  const custom = await db.prepare(
    `SELECT metric_key FROM cue_custom_metrics
      WHERE org_id = ? AND enabled = 1
        AND ((? IS NOT NULL AND project_id = ?)
          OR (? IS NULL AND source_id = ?))`,
  ).bind(orgId, projectId, projectId, projectId, sourceId).all();
  const customKeys = (custom.results ?? []).flatMap((row) => {
    const key = String(row.metric_key);
    return [key, `${key}.per_user`];
  });
  if (!projectId) return new Set([...NOXCUE_USER_METRIC_KEYS, ...NOXCUE_APPLE_METRIC_KEYS, ...customKeys]);
  const result = await db.prepare(
    `SELECT metric_key, enabled FROM cue_project_metric_settings
      WHERE org_id = ? AND project_id = ?`,
  ).bind(orgId, projectId).all();
  if ((result.results ?? []).length === 0) return new Set([...NOXCUE_USER_METRIC_KEYS, ...NOXCUE_APPLE_METRIC_KEYS, ...customKeys]);
  return new Set([...(result.results ?? [])
    .filter((row) => Number(row.enabled) === 1 && isNoxCueUserMetricKey(row.metric_key))
    .map((row) => String(row.metric_key)), ...NOXCUE_APPLE_METRIC_KEYS, ...customKeys]);
}

export function selectNoxCueDigestMetrics(digest, enabledKeys) {
  return {
    ...digest,
    metrics: Object.fromEntries(Object.entries(digest.metrics).filter(([key]) => enabledKeys.has(key))),
    comparisons: Object.fromEntries(Object.entries(digest.comparisons).filter(([key]) => enabledKeys.has(key))),
    metricLabels: Object.fromEntries(Object.entries(digest.metricLabels ?? {}).filter(([key]) => enabledKeys.has(key))),
  };
}
