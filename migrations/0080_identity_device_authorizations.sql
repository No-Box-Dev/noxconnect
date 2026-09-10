CREATE TABLE IF NOT EXISTS identity_device_authorizations (
  id TEXT PRIMARY KEY,
  client_name TEXT NOT NULL,
  encrypted_device_code TEXT NOT NULL,
  interval_seconds INTEGER NOT NULL CHECK (interval_seconds BETWEEN 5 AND 60),
  expires_at TEXT NOT NULL,
  last_polled_at TEXT,
  result_json TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_identity_device_authorizations_expiry
  ON identity_device_authorizations(expires_at, completed_at);
