import { z } from "zod";
import { getCtx, jsonResponse, errorResponse } from "../lib/db";
import { getInstallationIdForOrg, getInstallationToken } from "../lib/github-app";
import { validate } from "../lib/validate";
import { getActiveRepoNames } from "../lib/inactive-repos";

interface Env {
  DB: D1Database;
}

interface Ctx {
  env: Env;
  data: { orgId: number; orgLogin: string };
  request: Request;
}

// Body schema — replaces the previous hand-rolled missing/type/regex/enum checks.
// The repo pattern guards against path traversal / injection into the GitHub URL.
const IssueStateBody = z.object({
  repo: z.string().regex(/^[\w.-]+$/, "Invalid repo name"),
  issue_number: z.number().int().positive(),
  state: z.enum(["open", "closed"]),
});

// POST /api/issue-state — close or reopen a GitHub issue and update D1.
//
// Uses the GitHub App installation token (NOT the caller's OAuth token), so
// any logged-in user can open/close issues regardless of their personal
// permissions on the target repo. Matches the feature kanban auth model.
export async function onRequestPost(context: Ctx): Promise<Response> {
  const { orgId, orgLogin, projectId } = getCtx(context) as { orgId: number; orgLogin: string; projectId?: string | null };
  if (!orgLogin) return errorResponse("Missing org context", 400);

  let rawBody: unknown;
  try {
    rawBody = await context.request.json();
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  const parsed = validate(IssueStateBody, rawBody);
  if (!parsed.ok) return parsed.response;
  const { repo, issue_number, state } = parsed.data;
  const projectRepos = await getActiveRepoNames(context.env.DB, orgId, orgLogin, projectId);
  if (!projectRepos.includes(repo)) return errorResponse("Unknown repository", 404);

  const installationId = await getInstallationIdForOrg(context.env.DB, orgId);
  if (!installationId) return errorResponse("GitHub App not installed for this org", 412);

  let token: string;
  try {
    token = await getInstallationToken(context.env, installationId);
  } catch (err) {
    console.error("[issue-state] install token fetch failed", { msg: (err as Error)?.message });
    return errorResponse("Failed to acquire GitHub App token", 500);
  }

  const ghRes = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(orgLogin)}/${encodeURIComponent(repo)}/issues/${issue_number}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "NoxConnect",
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ state }),
    },
  );

  if (!ghRes.ok) {
    const ghBody = await ghRes.json().catch(() => ({})) as { message?: string };
    return errorResponse(ghBody.message || `GitHub API error: ${ghRes.status}`, ghRes.status);
  }

  const ghIssue = await ghRes.json() as { closed_at?: string | null };

  await context.env.DB.prepare(
    "UPDATE issues SET state = ?, closed_at = ? WHERE org_id = ? AND repo = ? AND number = ?"
  )
    .bind(state, ghIssue.closed_at ?? null, orgId, repo, issue_number)
    .run();

  return jsonResponse({ ok: true, state, closed_at: ghIssue.closed_at ?? null });
}
