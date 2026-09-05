-- NoxConnect caller credentials are deliberately separate from provider
-- credentials. Browser sessions and API tokens are opaque random values;
-- only their SHA-256 hashes are persisted.

CREATE TABLE IF NOT EXISTS browser_sessions (
  token_hash TEXT PRIMARY KEY,
  github_login TEXT NOT NULL,
  encrypted_github_token TEXT NOT NULL,
  csrf_hash TEXT NOT NULL,
  github_token_expires_at TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  last_used_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_browser_sessions_expiry
  ON browser_sessions(expires_at, revoked_at);
CREATE INDEX IF NOT EXISTS idx_browser_sessions_login
  ON browser_sessions(github_login, revoked_at);

CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('live', 'test')),
  token_prefix TEXT NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,
  scopes_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  expires_at TEXT,
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_api_tokens_org
  ON api_tokens(org_id, revoked_at, created_at);
CREATE INDEX IF NOT EXISTS idx_api_tokens_expiry
  ON api_tokens(expires_at, revoked_at);

CREATE TABLE IF NOT EXISTS auth_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER REFERENCES orgs(id),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'api_token', 'system')),
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_auth_audit_org_created
  ON auth_audit_log(org_id, created_at);

-- Invalidate exchange codes issued by versions that returned GitHub tokens to
-- browser JavaScript. New OAuth callbacks create browser_sessions directly.
DELETE FROM pending_tokens;
