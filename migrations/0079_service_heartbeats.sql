-- Durable platform-component health used by NoxHere readiness checks. These
-- rows describe NoxConnect itself, not an individual tenant or project.
CREATE TABLE service_heartbeats (
  component             TEXT PRIMARY KEY,
  status                TEXT NOT NULL DEFAULT 'waiting'
                        CHECK (status IN ('waiting', 'healthy', 'issue')),
  last_attempted_at     TEXT,
  last_succeeded_at     TEXT,
  last_failed_at        TEXT,
  last_error            TEXT,
  release               TEXT,
  consecutive_successes INTEGER NOT NULL DEFAULT 0,
  consecutive_failures  INTEGER NOT NULL DEFAULT 0,
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX service_heartbeats_status_time
  ON service_heartbeats(status, updated_at);
