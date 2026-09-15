import { getCtx, jsonResponse, errorResponse } from "../../lib/db";
import { getNoxDb, type NoxDatabaseEnv } from "../../lib/nox-db";

interface Ctx {
  env: NoxDatabaseEnv;
  data: { orgId: number; projectId?: string | null };
}

function parseArray(value: unknown): unknown[] {
  try {
    const parsed = JSON.parse(String(value || "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function captureDetails(payload: unknown) {
  try {
    const parsed = JSON.parse(String(payload || "{}"));
    const issueNumber = Number(parsed.githubIssueNumber ?? parsed.issueId);
    return {
      issueNumber: Number.isInteger(issueNumber) && issueNumber > 0 ? issueNumber : null,
      description: typeof parsed.description === "string" ? parsed.description : null,
      submittedBy: typeof parsed.reporter === "string" ? parsed.reporter : null,
    };
  } catch { return { issueNumber: null, description: null, submittedBy: null }; }
}

export async function onRequestGet(context: Ctx): Promise<Response> {
  const { orgId, projectId } = getCtx(context) as Ctx["data"];
  const db = getNoxDb(context.env);
  const project = projectId ? await db.prepare(
    `SELECT id, name, repo FROM projects
      WHERE id = ? AND org_id = ? AND COALESCE(archived, 0) = 0`,
  ).bind(projectId, orgId).first<{ id: string; name: string; repo: string }>() : null;
  if (projectId && !project) return errorResponse("Project not found", 404);
  const projectFilter = projectId ? " AND project_id = ? AND repo = ?" : "";
  const projectBinds = projectId ? [orgId, projectId, project!.repo] : [orgId];

  const [issues, captures, counts] = await db.batch([
    db.prepare(
      `SELECT number, title, state, author, author_avatar, created_at, updated_at, closed_at,
              html_url, assignees_json, labels_json
         FROM issues
        WHERE org_id = ?${projectFilter}
          AND EXISTS (SELECT 1 FROM json_each(labels_json)
                       WHERE LOWER(json_extract(value, '$.name')) = 'noxspot')
        ORDER BY updated_at DESC LIMIT 500`,
    ).bind(...projectBinds),
    db.prepare(
      `SELECT payload_json FROM events
        WHERE org_id = ?${projectFilter} AND type = 'spot:issue_created'
        ORDER BY created_at DESC LIMIT 1000`,
    ).bind(...projectBinds),
    db.prepare(
      `SELECT state, COUNT(*) AS count FROM issues
        WHERE org_id = ?${projectFilter}
          AND EXISTS (SELECT 1 FROM json_each(labels_json)
                       WHERE LOWER(json_extract(value, '$.name')) = 'noxspot')
        GROUP BY state`,
    ).bind(...projectBinds),
  ]);

  const details = new Map<number, { description: string | null; submittedBy: string | null }>();
  for (const row of captures.results ?? []) {
    const capture = captureDetails((row as Record<string, unknown>).payload_json);
    if (capture.issueNumber && !details.has(capture.issueNumber)) details.set(capture.issueNumber, capture);
  }
  const countRows = (counts.results ?? []) as Array<Record<string, unknown>>;
  const count = (state: string) => Number(countRows.find((row) => row.state === state)?.count ?? 0);
  return jsonResponse({
    project: project ? { id: project.id, name: project.name, repo: project.repo } : null,
    counts: { open: count("open"), closed: count("closed") },
    issues: (issues.results ?? []).map((row) => {
      const issue = row as Record<string, unknown>;
      const detail = details.get(Number(issue.number));
      return {
        number: Number(issue.number),
        title: String(issue.title),
        state: String(issue.state),
        author: issue.author ? { login: String(issue.author), avatarUrl: issue.author_avatar ? String(issue.author_avatar) : null } : null,
        assignees: parseArray(issue.assignees_json),
        labels: parseArray(issue.labels_json),
        createdAt: issue.created_at,
        updatedAt: issue.updated_at,
        closedAt: issue.closed_at,
        url: issue.html_url,
        description: detail?.description ?? null,
        submittedBy: detail?.submittedBy ?? null,
      };
    }),
  });
}
