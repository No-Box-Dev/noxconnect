-- App Store Connect analytics credentials and incremental report state.
-- Private keys stay encrypted at rest; report batches are idempotent and can
-- be replaced when Apple publishes late data or a correction.

CREATE TABLE cue_apple_connections (
  source_id             TEXT PRIMARY KEY REFERENCES cue_sources(id) ON DELETE CASCADE,
  org_id                INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  app_id                TEXT NOT NULL,
  issuer_id             TEXT NOT NULL,
  key_id                TEXT NOT NULL,
  encrypted_private_key TEXT NOT NULL,
  report_request_id     TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'waiting_for_reports'
                        CHECK (status IN ('waiting_for_reports', 'active', 'error')),
  last_synced_at        TEXT,
  last_successful_period TEXT,
  last_error            TEXT,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  UNIQUE (org_id, app_id)
);

CREATE INDEX idx_cue_apple_connections_sync
  ON cue_apple_connections(status, last_synced_at, source_id);

CREATE TABLE cue_apple_processed_instances (
  source_id       TEXT NOT NULL REFERENCES cue_apple_connections(source_id) ON DELETE CASCADE,
  report_id       TEXT NOT NULL,
  instance_id     TEXT NOT NULL,
  processing_date TEXT,
  processed_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  PRIMARY KEY (source_id, instance_id)
);

CREATE TABLE cue_external_metric_contributions (
  org_id      INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  source_id   TEXT NOT NULL REFERENCES cue_sources(id) ON DELETE CASCADE,
  provider    TEXT NOT NULL CHECK (provider IN ('apple-app-store-connect')),
  batch_id    TEXT NOT NULL,
  period      TEXT NOT NULL,
  metric_key  TEXT NOT NULL REFERENCES cue_metric_definitions(key),
  value       REAL NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (source_id, provider, batch_id, period, metric_key)
);

CREATE INDEX idx_cue_external_metric_rollup
  ON cue_external_metric_contributions(source_id, provider, period, metric_key);

INSERT INTO cue_metric_definitions
  (key, label, domain, unit, origin, description, formula_key, version)
VALUES
  ('apple.downloads.total', 'App Store downloads', 'users', 'count', 'reported',
   'All App Store download events, including first downloads, redownloads, updates, and restores.', NULL, 1),
  ('apple.downloads.first_time', 'First-time downloads', 'users', 'count', 'reported',
   'First-time App Store downloads based on Apple ID accounts.', NULL, 1),
  ('apple.downloads.redownloads', 'Redownloads', 'users', 'count', 'reported',
   'Subsequent App Store downloads made with the redownload action.', NULL, 1),
  ('apple.installations', 'App installations', 'users', 'count', 'reported',
   'Install events from opted-in devices reported by App Store Connect.', NULL, 1),
  ('apple.deletions', 'App deletions', 'users', 'count', 'reported',
   'Delete events from opted-in devices reported by App Store Connect.', NULL, 1),
  ('apple.sessions', 'App sessions', 'users', 'count', 'reported',
   'Sessions from opted-in devices reported by App Store Connect.', NULL, 1),
  ('apple.crashes', 'App crashes', 'errors', 'count', 'reported',
   'Crashes from opted-in devices reported by App Store Connect.', NULL, 1);
