-- Provider identity credentials remain in NoxConnect while NoxHere owns the
-- opaque application sessions that reference them by connection id.
CREATE TABLE IF NOT EXISTS identity_connections (
  id TEXT PRIMARY KEY,
  github_user_id INTEGER UNIQUE NOT NULL,
  github_login TEXT COLLATE NOCASE UNIQUE NOT NULL,
  avatar_url TEXT,
  encrypted_access_token TEXT NOT NULL,
  encrypted_refresh_token TEXT,
  access_token_expires_at TEXT,
  refresh_token_expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_identity_connections_login
  ON identity_connections(github_login, revoked_at);
