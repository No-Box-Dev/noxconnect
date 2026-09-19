CREATE TABLE spot_reports (
  id                         TEXT PRIMARY KEY,
  org_id                     INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id                 TEXT,
  site_id                    TEXT NOT NULL REFERENCES spot_sites(id) ON DELETE CASCADE,
  repo                       TEXT NOT NULL,
  issue_number               INTEGER NOT NULL,
  issue_url                  TEXT,
  title                      TEXT NOT NULL,
  reporter_name              TEXT,
  reporter_email_encrypted   TEXT,
  reporter_email_hash        TEXT,
  notification_consent       INTEGER NOT NULL DEFAULT 0 CHECK (notification_consent IN (0, 1)),
  status                     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'investigating', 'resolved')),
  resolution_summary         TEXT,
  resolved_at                TEXT,
  resolved_by                TEXT,
  resolution_source          TEXT CHECK (resolution_source IS NULL OR resolution_source IN ('platform', 'api', 'github')),
  notification_status        TEXT NOT NULL DEFAULT 'not_requested'
                             CHECK (notification_status IN ('not_requested', 'pending', 'sending', 'accepted',
                                                            'delivered', 'bounced', 'complained', 'failed')),
  notification_message_id    TEXT,
  notification_attempts      INTEGER NOT NULL DEFAULT 0,
  notification_last_error    TEXT,
  last_notified_at           TEXT,
  created_at                 TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at                 TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  UNIQUE (org_id, repo, issue_number)
);

CREATE INDEX spot_reports_project_status
  ON spot_reports(org_id, project_id, status, updated_at DESC);
CREATE INDEX spot_reports_message
  ON spot_reports(notification_message_id)
  WHERE notification_message_id IS NOT NULL;

CREATE TABLE spot_report_activity (
  id          TEXT PRIMARY KEY,
  report_id   TEXT NOT NULL REFERENCES spot_reports(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('created', 'reopened', 'investigating', 'resolved', 'notification_queued',
                                           'notification_accepted', 'notification_delivered',
                                           'notification_bounced', 'notification_complained', 'notification_failed')),
  actor       TEXT,
  summary     TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX spot_report_activity_report_time
  ON spot_report_activity(report_id, created_at DESC);
