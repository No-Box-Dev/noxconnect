-- Automation credentials are bound to exactly one enabled NoxConnect project.
-- Existing unscoped credentials are revoked during the migration so a token
-- created under the older organization-wide model cannot retain broad access.

ALTER TABLE api_tokens ADD COLUMN project_id TEXT
  REFERENCES projects(id) ON DELETE CASCADE;

UPDATE api_tokens
   SET revoked_at = COALESCE(revoked_at, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
 WHERE project_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_api_tokens_project
  ON api_tokens(org_id, project_id, revoked_at, created_at);

CREATE TRIGGER IF NOT EXISTS api_tokens_project_insert_guard
BEFORE INSERT ON api_tokens
WHEN NEW.project_id IS NULL OR NOT EXISTS (
  SELECT 1
    FROM project_routing_settings routing
    JOIN projects project ON project.id = routing.project_id
   WHERE routing.org_id = NEW.org_id
     AND routing.project_id = NEW.project_id
     AND routing.enabled = 1
     AND COALESCE(project.archived, 0) = 0
)
BEGIN
  SELECT RAISE(ABORT, 'api token project must be active in its organization');
END;

CREATE TRIGGER IF NOT EXISTS api_tokens_project_update_guard
BEFORE UPDATE OF org_id, project_id ON api_tokens
WHEN NEW.project_id IS NULL OR NOT EXISTS (
  SELECT 1
    FROM project_routing_settings routing
    JOIN projects project ON project.id = routing.project_id
   WHERE routing.org_id = NEW.org_id
     AND routing.project_id = NEW.project_id
     AND routing.enabled = 1
     AND COALESCE(project.archived, 0) = 0
)
BEGIN
  SELECT RAISE(ABORT, 'api token project must be active in its organization');
END;
