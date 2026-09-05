import { getCtx, jsonResponse, errorResponse } from "../../../lib/db";
import { getActiveRepoNames } from "../../../lib/inactive-repos";

const PR_COLUMNS = [
  "id", "repo", "number", "title", "state", "author", "author_avatar",
  "draft", "head_ref", "head_sha", "base_ref", "merged_at",
  "created_at", "updated_at", "html_url",
  "requested_reviewers_json", "labels_json",
].join(", ");

// GET /api/prs/:repo/:number — one cached PR. Returns 404 for unknown numbers
// and for repos outside the active set.
export async function onRequestGet(context) {
  const { orgId, orgLogin, projectId } = getCtx(context);
  const { repo, number } = context.params;
  if (!repo) return errorResponse("Missing repo", 400);

  const n = parseInt(number, 10);
  if (!Number.isFinite(n) || n <= 0) return errorResponse("Invalid number", 400);

  const activeRepos = await getActiveRepoNames(context.env.DB, orgId, orgLogin, projectId);
  if (!activeRepos.includes(repo)) return errorResponse("Unknown PR", 404);

  const row = await context.env.DB.prepare(
    `SELECT ${PR_COLUMNS} FROM pull_requests WHERE org_id = ? AND repo = ? AND number = ?`,
  ).bind(orgId, repo, n).first();

  if (!row) return errorResponse("Unknown PR", 404);

  return jsonResponse({
    pr: {
      ...row,
      draft: row.draft === 1,
      requested_reviewers: JSON.parse(row.requested_reviewers_json || "[]"),
      labels: JSON.parse(row.labels_json || "[]"),
    },
  });
}
