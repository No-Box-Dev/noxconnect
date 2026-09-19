-- Make Project the product-data boundary below the organization tenant.
-- Provider identities, organization membership, GitHub installations, and
-- reusable provider connections intentionally remain organization-owned.

ALTER TABLE projects ADD COLUMN org_id INTEGER
  REFERENCES orgs(id) ON DELETE CASCADE;

UPDATE projects
   SET org_id = (
     SELECT org.id FROM orgs org
      WHERE org.github_login = projects.owner_id COLLATE NOCASE
      LIMIT 1
   )
 WHERE org_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_projects_org_id
  ON projects(org_id, archived, name COLLATE NOCASE);

CREATE TRIGGER IF NOT EXISTS projects_org_required_insert
BEFORE INSERT ON projects
WHEN NEW.org_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'project organization is required');
END;

CREATE TRIGGER IF NOT EXISTS projects_org_required_update
BEFORE UPDATE OF org_id ON projects
WHEN NEW.org_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'project organization is required');
END;

-- Each project receives an independent copy of the established settings.
-- Subsequent service configuration reads and writes use this table.
CREATE TABLE IF NOT EXISTS project_config (
  org_id      INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  data        TEXT NOT NULL CHECK (json_valid(data)),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  PRIMARY KEY (org_id, project_id, key)
);

INSERT OR IGNORE INTO project_config (org_id, project_id, key, data, updated_at)
SELECT project.org_id, project.id, config.key, config.data,
       COALESCE(config.updated_at, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  FROM projects project
  JOIN config ON config.org_id = project.org_id
 WHERE project.org_id IS NOT NULL;

-- Direct project ownership for the remaining NoxTicket and GitHub-derived
-- product projections. Repository-backed rows are deterministically assigned
-- through the canonical project_repositories map.
ALTER TABLE features ADD COLUMN project_id TEXT
  REFERENCES projects(id) ON DELETE CASCADE;
ALTER TABLE specs ADD COLUMN project_id TEXT
  REFERENCES projects(id) ON DELETE CASCADE;
ALTER TABLE spec_attachments ADD COLUMN project_id TEXT
  REFERENCES projects(id) ON DELETE CASCADE;
ALTER TABLE pull_requests ADD COLUMN project_id TEXT
  REFERENCES projects(id) ON DELETE CASCADE;
ALTER TABLE issues ADD COLUMN project_id TEXT
  REFERENCES projects(id) ON DELETE CASCADE;
ALTER TABLE github_commits ADD COLUMN project_id TEXT
  REFERENCES projects(id) ON DELETE CASCADE;

UPDATE pull_requests
   SET project_id = (SELECT assignment.project_id
                       FROM project_repositories assignment
                      WHERE assignment.org_id = pull_requests.org_id
                        AND assignment.repo = pull_requests.repo COLLATE NOCASE)
 WHERE project_id IS NULL;
UPDATE issues
   SET project_id = (SELECT assignment.project_id
                       FROM project_repositories assignment
                      WHERE assignment.org_id = issues.org_id
                        AND assignment.repo = issues.repo COLLATE NOCASE)
 WHERE project_id IS NULL;
UPDATE github_commits
   SET project_id = (SELECT assignment.project_id
                       FROM project_repositories assignment
                      WHERE assignment.org_id = github_commits.org_id
                        AND assignment.repo = github_commits.repo COLLATE NOCASE)
 WHERE project_id IS NULL;

UPDATE features
   SET project_id = COALESCE(
     (SELECT assignment.project_id
        FROM project_repositories assignment
        JOIN config ON config.org_id = features.org_id AND config.key = 'settings'
       WHERE assignment.org_id = features.org_id
         AND assignment.repo = COALESCE(json_extract(config.data, '$.noxTicketRepo'), 'noxconnect') COLLATE NOCASE
       LIMIT 1),
     (SELECT MIN(routing.project_id)
        FROM project_routing_settings routing
       WHERE routing.org_id = features.org_id AND routing.enabled = 1
       HAVING COUNT(*) = 1)
   )
 WHERE project_id IS NULL;

UPDATE specs
   SET project_id = COALESCE(
     (SELECT feature.project_id FROM features feature
       WHERE feature.org_id = specs.org_id
         AND feature.number = specs.feature_number
         AND feature.project_id IS NOT NULL
       LIMIT 1),
     (SELECT MIN(routing.project_id)
        FROM project_routing_settings routing
       WHERE routing.org_id = specs.org_id AND routing.enabled = 1
       HAVING COUNT(*) = 1)
   )
 WHERE project_id IS NULL;

UPDATE spec_attachments
   SET project_id = (SELECT spec.project_id FROM specs spec
                      WHERE spec.id = spec_attachments.spec_id)
 WHERE project_id IS NULL;

-- Feature issue numbers are only unique inside their project repository. The
-- legacy organization-wide constraint would merge two projects' issue #42.
CREATE TABLE features_project_scoped (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL REFERENCES orgs(id),
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open',
  body TEXT DEFAULT '',
  assignees_json TEXT DEFAULT '[]',
  labels_json TEXT DEFAULT '[]',
  milestone_title TEXT,
  html_url TEXT,
  created_at TEXT,
  updated_at TEXT,
  gh_synced_at TEXT,
  UNIQUE(org_id, project_id, number)
);
INSERT INTO features_project_scoped
  (id, org_id, project_id, number, title, state, body, assignees_json,
   labels_json, milestone_title, html_url, created_at, updated_at, gh_synced_at)
SELECT id, org_id, project_id, number, title, state, body, assignees_json,
       labels_json, milestone_title, html_url, created_at, updated_at, gh_synced_at
  FROM features;
DROP TABLE features;
ALTER TABLE features_project_scoped RENAME TO features;


CREATE INDEX IF NOT EXISTS idx_features_project
  ON features(org_id, project_id, state, number);
CREATE INDEX IF NOT EXISTS idx_specs_project
  ON specs(org_id, project_id, archived, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_pull_requests_project
  ON pull_requests(org_id, project_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_issues_project
  ON issues(org_id, project_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_github_commits_project
  ON github_commits(org_id, project_id, authored_at DESC);

CREATE TRIGGER IF NOT EXISTS pull_requests_assign_project_insert
AFTER INSERT ON pull_requests
WHEN NEW.project_id IS NULL
BEGIN
  UPDATE pull_requests
     SET project_id = (SELECT assignment.project_id FROM project_repositories assignment
                        WHERE assignment.org_id = NEW.org_id AND assignment.repo = NEW.repo COLLATE NOCASE)
   WHERE id = NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS issues_assign_project_insert
AFTER INSERT ON issues
WHEN NEW.project_id IS NULL
BEGIN
  UPDATE issues
     SET project_id = (SELECT assignment.project_id FROM project_repositories assignment
                        WHERE assignment.org_id = NEW.org_id AND assignment.repo = NEW.repo COLLATE NOCASE)
   WHERE id = NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS github_commits_assign_project_insert
AFTER INSERT ON github_commits
WHEN NEW.project_id IS NULL
BEGIN
  UPDATE github_commits
     SET project_id = (SELECT assignment.project_id FROM project_repositories assignment
                        WHERE assignment.org_id = NEW.org_id AND assignment.repo = NEW.repo COLLATE NOCASE)
   WHERE id = NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS features_assign_project_insert
AFTER INSERT ON features
WHEN NEW.project_id IS NULL
BEGIN
  UPDATE features
     SET project_id = COALESCE(
       (SELECT assignment.project_id
          FROM project_repositories assignment
          JOIN project_config config
            ON config.org_id = NEW.org_id AND config.project_id = assignment.project_id AND config.key = 'settings'
         WHERE assignment.org_id = NEW.org_id
           AND assignment.repo = COALESCE(json_extract(config.data, '$.noxTicketRepo'), 'noxconnect') COLLATE NOCASE
         LIMIT 1),
       (SELECT MIN(routing.project_id) FROM project_routing_settings routing
         WHERE routing.org_id = NEW.org_id AND routing.enabled = 1 HAVING COUNT(*) = 1)
     )
   WHERE id = NEW.id;
END;

-- Shared delivery and observability rows carry project ownership directly so
-- cross-service retries and audits never have to infer tenant scope.
ALTER TABLE delivery_outbox ADD COLUMN project_id TEXT
  REFERENCES projects(id) ON DELETE CASCADE;
ALTER TABLE noxspot_config_audit ADD COLUMN project_id TEXT
  REFERENCES projects(id) ON DELETE CASCADE;
ALTER TABLE op_failures ADD COLUMN org_id INTEGER
  REFERENCES orgs(id) ON DELETE CASCADE;
ALTER TABLE op_failures ADD COLUMN project_id TEXT
  REFERENCES projects(id) ON DELETE CASCADE;

UPDATE delivery_outbox
   SET project_id = COALESCE(
     (SELECT site.project_id FROM spot_sites site
       WHERE site.org_id = delivery_outbox.org_id AND site.id = delivery_outbox.site_id),
     (SELECT source.project_id FROM cue_sources source
       WHERE source.org_id = delivery_outbox.org_id AND source.id = delivery_outbox.source_id),
     (SELECT event.project_id FROM events event
       WHERE event.org_id = delivery_outbox.org_id
         AND CAST(event.id AS TEXT) = delivery_outbox.source_id)
   )
 WHERE project_id IS NULL;

UPDATE noxspot_config_audit
   SET project_id = (SELECT site.project_id FROM spot_sites site
                      WHERE site.org_id = noxspot_config_audit.org_id
                        AND site.id = noxspot_config_audit.site_id)
 WHERE project_id IS NULL;

UPDATE op_failures
   SET org_id = (SELECT org.id FROM orgs org
                  WHERE org.github_login = op_failures.owner_id COLLATE NOCASE)
 WHERE org_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_delivery_outbox_project_status
  ON delivery_outbox(org_id, project_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_noxspot_config_audit_project
  ON noxspot_config_audit(org_id, project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_op_failures_project
  ON op_failures(org_id, project_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS project_ai_settings (
  org_id      INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  mode        TEXT NOT NULL DEFAULT 'managed' CHECK (mode IN ('managed', 'disabled')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  PRIMARY KEY (org_id, project_id)
);

INSERT OR IGNORE INTO project_ai_settings (org_id, project_id, mode, updated_at)
SELECT project.org_id, project.id, COALESCE(ai.mode, 'managed'),
       COALESCE(ai.updated_at, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  FROM projects project
  LEFT JOIN ai_settings ai ON ai.org_id = project.org_id
 WHERE project.org_id IS NOT NULL;

ALTER TABLE ai_settings_audit ADD COLUMN project_id TEXT
  REFERENCES projects(id) ON DELETE CASCADE;

-- Old unlinked Cue sources are assigned only when their organization has one
-- enabled project. Ambiguous rows remain visible for an explicit admin repair;
-- all new API writes require the authenticated project context.
UPDATE cue_sources
   SET project_id = (
     SELECT MIN(routing.project_id)
       FROM project_routing_settings routing
      WHERE routing.org_id = cue_sources.org_id AND routing.enabled = 1
      HAVING COUNT(*) = 1
   )
 WHERE project_id IS NULL;
