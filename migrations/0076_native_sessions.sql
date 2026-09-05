-- Native applications authenticate to NoxConnect, never to downstream
-- product Workers and never with a long-lived GitHub bearer on each request.
-- Raw NoxConnect credentials are returned once; only hashes are persisted.

CREATE TABLE IF NOT EXISTS native_device_authorizations (
  id TEXT PRIMARY KEY,
  encrypted_device_code TEXT NOT NULL,
  client_name TEXT NOT NULL CHECK (client_name IN ('noxfeed-mac')),
  interval_seconds INTEGER NOT NULL CHECK (interval_seconds BETWEEN 1 AND 60),
  expires_at TEXT NOT NULL,
  last_polled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  consumed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_native_device_authorizations_expiry
  ON native_device_authorizations(expires_at, consumed_at);

CREATE TABLE IF NOT EXISTS native_sessions (
  id TEXT PRIMARY KEY,
  client_name TEXT NOT NULL CHECK (client_name IN ('noxfeed-mac')),
  github_login TEXT NOT NULL,
  access_token_hash TEXT UNIQUE NOT NULL,
  refresh_token_hash TEXT UNIQUE NOT NULL,
  encrypted_github_token TEXT NOT NULL,
  encrypted_github_refresh_token TEXT,
  github_token_expires_at TEXT,
  github_refresh_expires_at TEXT,
  access_expires_at TEXT NOT NULL,
  refresh_expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  last_used_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  rotated_at TEXT,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_native_sessions_access
  ON native_sessions(access_token_hash, access_expires_at, revoked_at);
CREATE INDEX IF NOT EXISTS idx_native_sessions_refresh
  ON native_sessions(refresh_token_hash, refresh_expires_at, revoked_at);
CREATE INDEX IF NOT EXISTS idx_native_sessions_login
  ON native_sessions(github_login, revoked_at);
