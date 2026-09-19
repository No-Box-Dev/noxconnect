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

// Body schema — replaces the previous hand-rolled regex/type checks. The repo +
// assignee patterns guard against path traversal / injection into the GitHub URL.
const AssignBody = z.object({
  repo: z.string().regex(/^[\w.-]+$/, "Invalid repo name"),
  issue_number: z.number().int().positive(),
  assignees: z.array(z.string().regex(/^[a-zA-Z0-9-]+$/, "Invalid assignee username")),
});

// POST /api/assign — update issue assignees on GitHub and in D1.
//
// Uses the GitHub App installation token (NOT the caller's OAuth token), so
// any logged-in user can change assignees regardless of their personal
// permissions on the target repo. Matches the feature kanban auth model;
// see the audit in functions/api/features/[number].js for the rationale.
export async function onRequestPost(context: Ctx): Promise<Response> {
  const { orgId, orgLogin, projectId } = getCtx(context) as { orgId: number; orgLogin: string; projectId?: string | null };
  if (!orgLogin) return errorResponse("Missing org context", 400);

  let rawBody: unknown;
  try {
    rawBody = await context.request.json();
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  const parsed = validate(AssignBody, rawBody);
  if (!parsed.ok) return parsed.response;
  const { repo, issue_number, assignees } = parsed.data;
  const projectRepos = await getActiveRepoNames(context.env.DB, orgId, orgLogin, projectId);
  if (!projectRepos.includes(repo)) return errorResponse("Unknown repository", 404);

  const installationId = await getInstallationIdForOrg(context.env.DB, orgId);
  if (!installationId) return errorResponse("GitHub App not installed for this org", 412);

  let token: string;
  try {
    token = await getInstallationToken(context.env, installationId);
  } catch (err) {
    console.error("[assign] install token fetch failed", { msg: (err as Error)?.message });
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
      body: JSON.stringify({ assignees }),
    },
  );

  if (!ghRes.ok) {
    const errBody = await ghRes.json().catch(() => ({})) as { message?: string };
    return errorResponse(errBody.message || `GitHub API error: ${ghRes.status}`, ghRes.status);
  }

  const ghIssue = await ghRes.json() as { assignees?: { login: string; avatar_url?: string }[] };

  const assigneesJson = JSON.stringify(
    (ghIssue.assignees || []).map((a) => ({
      login: a.login,
      avatar_url: a.avatar_url || "",
    })),
  );

  await context.env.DB.prepare(
    "UPDATE issues SET assignees_json = ? WHERE org_id = ? AND repo = ? AND number = ?",
  )
    .bind(assigneesJson, orgId, repo, issue_number)
    .run();

  return jsonResponse({
    assignees: (ghIssue.assignees || []).map((a) => ({
      login: a.login,
      avatar_url: a.avatar_url || "",
    })),
  });
}
