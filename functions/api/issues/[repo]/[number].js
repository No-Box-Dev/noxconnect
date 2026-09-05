import { getCtx, jsonResponse, errorResponse } from "../../../lib/db";
import { getActiveRepoNames } from "../../../lib/inactive-repos";

const ISSUE_COLUMNS = [
  "id", "repo", "number", "title", "state", "author", "author_avatar",
  "created_at", "updated_at", "closed_at", "html_url",
  "assignees_json", "labels_json", "milestone_title", "closed_by",
].join(", ");

// GET /api/issues/:repo/:number — one cached issue. Returns 404 for unknown
// numbers and for repos not in the active set (drafts, archived, noxconnect).
export async function onRequestGet(context) {
  const { orgId, orgLogin, projectId } = getCtx(context);
  const { repo, number } = context.params;
  if (!repo) return errorResponse("Missing repo", 400);

  const n = parseInt(number, 10);
  if (!Number.isFinite(n) || n <= 0) return errorResponse("Invalid number", 400);

  const activeRepos = await getActiveRepoNames(context.env.DB, orgId, orgLogin, projectId);
  if (!activeRepos.includes(repo)) return errorResponse("Unknown issue", 404);

  const row = await context.env.DB.prepare(
    `SELECT ${ISSUE_COLUMNS} FROM issues WHERE org_id = ? AND repo = ? AND number = ?`,
  ).bind(orgId, repo, n).first();

  if (!row) return errorResponse("Unknown issue", 404);

  return jsonResponse({
    issue: {
      ...row,
      assignees: JSON.parse(row.assignees_json || "[]"),
      labels: JSON.parse(row.labels_json || "[]"),
      closed_by: row.closed_by ?? null,
    },
  });
}
