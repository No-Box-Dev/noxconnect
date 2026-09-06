CREATE TABLE IF NOT EXISTS connection_capability_runs (
  id TEXT PRIMARY KEY,
  org_id INTEGER NOT NULL,
  project_id TEXT NOT NULL,
  service TEXT NOT NULL CHECK (service IN ('noxticket', 'noxfeed', 'noxspot', 'noxcue')),
  capability TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  command_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('processing', 'completed', 'queued', 'blocked', 'failed')),
  receipt_json TEXT,
  last_error TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  UNIQUE (org_id, service, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_connection_capability_runs_project
  ON connection_capability_runs(org_id, project_id, updated_at DESC);
