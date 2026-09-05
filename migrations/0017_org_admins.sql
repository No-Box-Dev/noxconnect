-- App-level admin role, independent of GitHub org admin status.
-- Organization bootstrap is performed by the middleware only after GitHub
-- confirms that the caller is an active organization owner. Subsequent users
-- default to member; promotion to admin is via an admin-only API.
--
-- Why a separate table instead of `members.role`: `members` is a verbatim
-- mirror of the GitHub org members API, refreshed by syncMembers. Mixing
-- app-level state into a synced mirror table risks the next reconcile
-- wiping admin assignments. A dedicated table keeps the two concerns clean.
CREATE TABLE IF NOT EXISTS org_admins (
  org_id INTEGER NOT NULL,
  login TEXT NOT NULL,
  granted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  granted_by_login TEXT,
  PRIMARY KEY (org_id, login)
);
