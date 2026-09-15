-- Repair legacy rows whose repository ownership predates the explicit
-- project_repositories routing table. A projects(org_id, repo) match is safe
-- only when it identifies exactly one project; ambiguous or orphaned rows stay
-- NULL for explicit administrator repair rather than crossing project scopes.

UPDATE pull_requests
   SET project_id = (
     SELECT MIN(project.id)
       FROM projects project
      WHERE project.org_id = pull_requests.org_id
        AND project.repo = pull_requests.repo COLLATE NOCASE
     HAVING COUNT(*) = 1
   )
 WHERE project_id IS NULL;

UPDATE issues
   SET project_id = (
     SELECT MIN(project.id)
       FROM projects project
      WHERE project.org_id = issues.org_id
        AND project.repo = issues.repo COLLATE NOCASE
     HAVING COUNT(*) = 1
   )
 WHERE project_id IS NULL;

UPDATE github_commits
   SET project_id = (
     SELECT MIN(project.id)
       FROM projects project
      WHERE project.org_id = github_commits.org_id
        AND project.repo = github_commits.repo COLLATE NOCASE
     HAVING COUNT(*) = 1
   )
 WHERE project_id IS NULL;

-- Legacy feature rows retain their canonical GitHub issue URL, which provides
-- the repository identity without relying on organization-wide settings.
UPDATE features
   SET project_id = (
     SELECT MIN(project.id)
       FROM projects project
      WHERE project.org_id = features.org_id
        AND lower(features.html_url) = lower(
          'https://github.com/' || COALESCE(project.org, project.owner_id) ||
          '/' || project.repo || '/issues/' || features.number
        )
     HAVING COUNT(*) = 1
   )
 WHERE project_id IS NULL
   AND html_url IS NOT NULL;

UPDATE specs
   SET project_id = (
     SELECT MIN(feature.project_id)
       FROM features feature
      WHERE feature.org_id = specs.org_id
        AND feature.number = specs.feature_number
        AND feature.project_id IS NOT NULL
     HAVING COUNT(DISTINCT feature.project_id) = 1
   )
 WHERE project_id IS NULL;

UPDATE spec_attachments
   SET project_id = (
     SELECT spec.project_id
       FROM specs spec
      WHERE spec.id = spec_attachments.spec_id
   )
 WHERE project_id IS NULL;

-- Re-run relationship-based delivery ownership after repairing the source
-- projections above. Historical rows with no project-bearing source remain
-- explicitly unassigned.
UPDATE delivery_outbox
   SET project_id = COALESCE(
     (SELECT site.project_id FROM spot_sites site
       WHERE site.org_id = delivery_outbox.org_id
         AND site.id = delivery_outbox.site_id),
     (SELECT source.project_id FROM cue_sources source
       WHERE source.org_id = delivery_outbox.org_id
         AND source.id = delivery_outbox.source_id),
     (SELECT event.project_id FROM events event
       WHERE event.org_id = delivery_outbox.org_id
         AND CAST(event.id AS TEXT) = delivery_outbox.source_id)
   )
 WHERE project_id IS NULL;

DROP TRIGGER IF EXISTS pull_requests_assign_project_insert;
CREATE TRIGGER pull_requests_assign_project_insert
AFTER INSERT ON pull_requests
WHEN NEW.project_id IS NULL
BEGIN
  UPDATE pull_requests
     SET project_id = COALESCE(
       (SELECT assignment.project_id
          FROM project_repositories assignment
         WHERE assignment.org_id = NEW.org_id
           AND assignment.repo = NEW.repo COLLATE NOCASE),
       (SELECT MIN(project.id)
          FROM projects project
         WHERE project.org_id = NEW.org_id
           AND project.repo = NEW.repo COLLATE NOCASE
        HAVING COUNT(*) = 1)
     )
   WHERE id = NEW.id;
END;

DROP TRIGGER IF EXISTS issues_assign_project_insert;
CREATE TRIGGER issues_assign_project_insert
AFTER INSERT ON issues
WHEN NEW.project_id IS NULL
BEGIN
  UPDATE issues
     SET project_id = COALESCE(
       (SELECT assignment.project_id
          FROM project_repositories assignment
         WHERE assignment.org_id = NEW.org_id
           AND assignment.repo = NEW.repo COLLATE NOCASE),
       (SELECT MIN(project.id)
          FROM projects project
         WHERE project.org_id = NEW.org_id
           AND project.repo = NEW.repo COLLATE NOCASE
        HAVING COUNT(*) = 1)
     )
   WHERE id = NEW.id;
END;

DROP TRIGGER IF EXISTS github_commits_assign_project_insert;
CREATE TRIGGER github_commits_assign_project_insert
AFTER INSERT ON github_commits
WHEN NEW.project_id IS NULL
BEGIN
  UPDATE github_commits
     SET project_id = COALESCE(
       (SELECT assignment.project_id
          FROM project_repositories assignment
         WHERE assignment.org_id = NEW.org_id
           AND assignment.repo = NEW.repo COLLATE NOCASE),
       (SELECT MIN(project.id)
          FROM projects project
         WHERE project.org_id = NEW.org_id
           AND project.repo = NEW.repo COLLATE NOCASE
        HAVING COUNT(*) = 1)
     )
   WHERE id = NEW.id;
END;

DROP TRIGGER IF EXISTS features_assign_project_insert;
CREATE TRIGGER features_assign_project_insert
AFTER INSERT ON features
WHEN NEW.project_id IS NULL
BEGIN
  UPDATE features
     SET project_id = COALESCE(
       (SELECT MIN(project.id)
          FROM projects project
         WHERE project.org_id = NEW.org_id
           AND NEW.html_url IS NOT NULL
           AND lower(NEW.html_url) = lower(
             'https://github.com/' || COALESCE(project.org, project.owner_id) ||
             '/' || project.repo || '/issues/' || NEW.number
           )
        HAVING COUNT(*) = 1),
       (SELECT assignment.project_id
          FROM project_repositories assignment
          JOIN project_config config
            ON config.org_id = NEW.org_id
           AND config.project_id = assignment.project_id
           AND config.key = 'settings'
         WHERE assignment.org_id = NEW.org_id
           AND assignment.repo = COALESCE(
             json_extract(config.data, '$.noxTicketRepo'), 'noxconnect'
           ) COLLATE NOCASE
         LIMIT 1),
       (SELECT MIN(routing.project_id)
          FROM project_routing_settings routing
         WHERE routing.org_id = NEW.org_id
           AND routing.enabled = 1
        HAVING COUNT(*) = 1)
     )
   WHERE id = NEW.id;
END;
