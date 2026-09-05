import { getCtx, jsonResponse, errorResponse } from "../../../lib/db";
import { startRepoTracking, stopRepoTracking } from "../../../lib/repo-tracking";
import { requireAdmin } from "../../../lib/access.js";

// POST   /api/projects/:id/archive  → archive the project (inactive on platform)
// DELETE /api/projects/:id/archive  → unarchive
//
// Archived projects are excluded from sync and from issue/PR queries.
// The row stays in `projects` (so the user can flip it back on) but
// archived=1 keeps it out of every active scope.

export async function onRequestPost(context) {
  return setArchived(context, 1);
}

export async function onRequestDelete(context) {
  return setArchived(context, 0);
}

async function setArchived(context, value) {
  const accessError = requireAdmin(context);
  if (accessError) return accessError;
  const { orgId, orgLogin } = getCtx(context);
  if (!orgId || !orgLogin) return errorResponse("Missing org context", 400);
  const { id } = context.params;
  if (!id) return errorResponse("Missing project id", 400);

  const archivedAt = value === 1 ? new Date().toISOString() : null;
  const project = await context.env.DB
    .prepare(
      `SELECT project.repo, project.archived, repo.archived_at, repo.retired_at
       FROM projects project
       LEFT JOIN repos repo ON repo.org_id = ? AND repo.name = project.repo
       WHERE project.id = ? AND project.owner_id = ?`,
    )
    .bind(orgId, id, orgLogin)
    .first();
  if (!project) return errorResponse(`Unknown project ${id}`, 404);
  if (value === 0 && (project.archived_at || project.retired_at)) {
    return errorResponse("Cannot restore a repository that is archived or retired on GitHub", 409);
  }

  const result = await context.env.DB.prepare(
    `UPDATE projects
        SET archived = ?, archived_at = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      WHERE id = ? AND owner_id = ?`
  ).bind(value, archivedAt, id, orgLogin).run();

  const changes = result.meta?.changes ?? 0;
  if (!changes) return errorResponse(`Unknown project ${id}`, 404);

  if (project.repo) {
    if (value === 1) {
      await stopRepoTracking(context.env.DB, orgId, project.repo, "platform_archived", archivedAt);
    } else {
      await startRepoTracking(context.env.DB, orgId, project.repo);
    }
  }

  return jsonResponse({ ok: true, id, archived: value === 1 });
}
