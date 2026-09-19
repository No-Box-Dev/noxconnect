import { getCtx, errorResponse, jsonResponse } from "../../lib/db.js";
import { getActiveRepoNames } from "../../lib/inactive-repos.js";
import { getInstallationIdForOrg, getInstallationToken } from "../../lib/github-app.js";

const PAGE_SIZE = 100;
const MAX_PAGES_PER_STREAM = 20;

// GET /api/github/comments?repo=x&number=1
// Returns the complete PR conversation from GitHub's three comment streams:
// issue comments, review summaries, and inline review comments. The payload is
// a bounded projection; installation credentials and raw GitHub data never
// cross the NoxConnect boundary.
export async function onRequestGet(context) {
  const { orgId, orgLogin, projectId } = getCtx(context);
  const url = new URL(context.request.url);
  const repo = url.searchParams.get("repo")?.trim();
  const number = Number(url.searchParams.get("number"));
  if (!repo || !Number.isSafeInteger(number) || number < 1) {
    return errorResponse("Invalid GitHub comments request", 400);
  }

  const activeRepos = await getActiveRepoNames(context.env.DB, orgId, orgLogin, projectId);
  if (!activeRepos.includes(repo)) return errorResponse("Unknown repository", 404);

  const installationId = await getInstallationIdForOrg(context.env.DB, orgId);
  if (!installationId) return errorResponse("GitHub App not installed", 409);

  try {
    const token = await getInstallationToken(context.env, installationId);
    const root = `https://api.github.com/repos/${encodeURIComponent(orgLogin)}/${encodeURIComponent(repo)}`;
    const [issueComments, reviews, reviewComments] = await Promise.all([
      fetchAll(`${root}/issues/${number}/comments`, token),
      fetchAll(`${root}/pulls/${number}/reviews`, token),
      fetchAll(`${root}/pulls/${number}/comments`, token),
    ]);

    const comments = [
      ...issueComments.items.map(projectIssueComment),
      ...reviews.items.filter(hasBody).map(projectReview),
      ...reviewComments.items.map(projectReviewComment),
    ].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));

    return jsonResponse({
      comments,
      truncated: issueComments.truncated || reviews.truncated || reviewComments.truncated,
    });
  } catch (error) {
    if (error instanceof GitHubResponseError) {
      return errorResponse(error.message, error.status);
    }
    return errorResponse(error instanceof Error ? error.message : "GitHub comments unavailable", 502);
  }
}

async function fetchAll(endpoint, token) {
  const items = [];
  for (let page = 1; page <= MAX_PAGES_PER_STREAM; page += 1) {
    const separator = endpoint.includes("?") ? "&" : "?";
    const response = await fetch(`${endpoint}${separator}per_page=${PAGE_SIZE}&page=${page}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "noxconnect",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new GitHubResponseError(data?.message || "GitHub comments unavailable", response.status);
    }
    if (!Array.isArray(data)) throw new Error("GitHub returned an invalid comments response");
    items.push(...data);

    const hasNext = /<[^>]+>;\s*rel="next"/.test(response.headers?.get?.("Link") || "");
    if (data.length < PAGE_SIZE || !hasNext) return { items, truncated: false };
  }
  return { items, truncated: true };
}

function projectIssueComment(item) {
  return projectBase(item, "comment");
}

function projectReview(item) {
  return {
    ...projectBase(item, "review"),
    state: typeof item.state === "string" ? item.state.toLowerCase() : null,
  };
}

function projectReviewComment(item) {
  return {
    ...projectBase(item, "review_comment"),
    path: text(item.path),
    line: Number.isSafeInteger(item.line) ? item.line : null,
    diff_hunk: text(item.diff_hunk),
  };
}

function projectBase(item, kind) {
  return {
    id: `${kind}:${String(item.id ?? "unknown")}`,
    kind,
    body: text(item.body) ?? "",
    author_login: text(item.user?.login),
    author_avatar_url: text(item.user?.avatar_url),
    created_at: timestamp(item.created_at),
    updated_at: timestamp(item.updated_at),
    html_url: text(item.html_url),
  };
}

function hasBody(item) {
  return typeof item?.body === "string" && item.body.trim().length > 0;
}

function text(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function timestamp(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value))
    ? value
    : "1970-01-01T00:00:00Z";
}

class GitHubResponseError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}
