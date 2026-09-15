import { getCtx, errorResponse, jsonResponse } from "../../lib/db.js";
import { getActiveRepoNames } from "../../lib/inactive-repos.js";
import { getInstallationIdForOrg, getInstallationToken } from "../../lib/github-app.js";

// GET /api/github/details?kind=issue|pr&repo=x&number=1
// NoxConnect owns the live GitHub read. Clients receive a bounded projection,
// never an installation token or raw GitHub client response.
export async function onRequestGet(context) {
  const { orgId, orgLogin, projectId } = getCtx(context);
  const url = new URL(context.request.url);
  const kind = url.searchParams.get("kind");
  const repo = url.searchParams.get("repo")?.trim();
  const number = Number(url.searchParams.get("number"));
  if ((kind !== "issue" && kind !== "pr") || !repo || !Number.isSafeInteger(number) || number < 1) {
    return errorResponse("Invalid GitHub detail request", 400);
  }
  const activeRepos = await getActiveRepoNames(context.env.DB, orgId, orgLogin, projectId);
  if (!activeRepos.includes(repo)) return errorResponse("Unknown repository", 404);

  const installationId = await getInstallationIdForOrg(context.env.DB, orgId);
  if (!installationId) return errorResponse("GitHub App not installed", 409);
  try {
    const token = await getInstallationToken(context.env, installationId);
    const endpoint = kind === "issue" ? "issues" : "pulls";
    const response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(orgLogin)}/${encodeURIComponent(repo)}/${endpoint}/${number}`,
      { headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "noxconnect",
        "X-GitHub-Api-Version": "2022-11-28",
      } },
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return errorResponse(data?.message || "GitHub detail unavailable", response.status);
    return jsonResponse(kind === "issue" ? {
      body: data.body ?? null,
      comments: finite(data.comments),
      reactions_total: finite(data.reactions?.total_count),
    } : {
      body: data.body ?? null,
      comments: finite(data.comments),
      review_comments: finite(data.review_comments),
      additions: finite(data.additions),
      deletions: finite(data.deletions),
      changed_files: finite(data.changed_files),
      merged: data.merged === true,
      mergeable: typeof data.mergeable === "boolean" ? data.mergeable : null,
    });
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "GitHub detail unavailable", 502);
  }
}

function finite(value) {
  return Number.isFinite(value) ? Number(value) : 0;
}
