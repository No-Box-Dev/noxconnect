-- Extend the original NoxSpot configuration audit constraint for resolution
-- email template management. SQLite cannot alter a CHECK constraint in place,
-- so preserve the rows while rebuilding the table.
CREATE TABLE noxspot_config_audit_v2 (
  id           TEXT PRIMARY KEY,
  org_id       INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  site_id      TEXT NOT NULL,
  actor_login  TEXT NOT NULL,
  action       TEXT NOT NULL CHECK (action IN (
    'site.created',
    'site.updated',
    'site.deleted',
    'site.migrated',
    'resolution_template.updated',
    'resolution_template.reset',
    'resolution_template.test_sent'
  )),
  changes_json TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  project_id   TEXT REFERENCES projects(id) ON DELETE CASCADE
);

INSERT INTO noxspot_config_audit_v2
  (id, org_id, site_id, actor_login, action, changes_json, created_at, project_id)
SELECT id, org_id, site_id, actor_login, action, changes_json, created_at, project_id
  FROM noxspot_config_audit;

DROP TABLE noxspot_config_audit;
ALTER TABLE noxspot_config_audit_v2 RENAME TO noxspot_config_audit;

CREATE INDEX idx_noxspot_config_audit_org_created
  ON noxspot_config_audit(org_id, created_at DESC);

CREATE INDEX idx_noxspot_config_audit_site_created
  ON noxspot_config_audit(site_id, created_at DESC);

CREATE INDEX idx_noxspot_config_audit_project
  ON noxspot_config_audit(org_id, project_id, created_at DESC);
