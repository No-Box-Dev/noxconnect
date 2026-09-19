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
      captureId: typeof parsed.captureId === "string" ? parsed.captureId : null,
      description: typeof parsed.description === "string" ? parsed.description : null,
      submittedBy: typeof parsed.reporter === "string" ? parsed.reporter : null,
    };
  } catch { return { issueNumber: null, captureId: null, description: null, submittedBy: null }; }
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

  const [issues, captures, reports, activities] = await db.batch([
    db.prepare(
      `SELECT repo, number, title, state, author, author_avatar, created_at, updated_at, closed_at,
              html_url, assignees_json, labels_json
         FROM issues
        WHERE org_id = ?${projectFilter}
          AND EXISTS (SELECT 1 FROM json_each(labels_json)
                       WHERE LOWER(json_extract(value, '$.name')) = 'noxspot')
        ORDER BY updated_at DESC LIMIT 500`,
    ).bind(...projectBinds),
    db.prepare(
      `SELECT repo, payload_json FROM events
        WHERE org_id = ?${projectFilter} AND type = 'spot:issue_created'
        ORDER BY created_at DESC LIMIT 1000`,
    ).bind(...projectBinds),
    db.prepare(
      `SELECT id, repo, issue_number, status, resolution_summary, resolved_at, resolved_by,
              notification_consent, notification_status, notification_last_error,
              notification_attempts, last_notified_at
         FROM spot_reports
        WHERE org_id = ?${projectFilter}
        ORDER BY updated_at DESC LIMIT 1000`,
    ).bind(...projectBinds),
    db.prepare(
      `SELECT activity.report_id, activity.kind, activity.actor, activity.summary, activity.created_at
         FROM spot_report_activity activity
         JOIN spot_reports report ON report.id = activity.report_id
        WHERE report.org_id = ?${projectId ? " AND report.project_id = ? AND report.repo = ?" : ""}
        ORDER BY activity.created_at DESC LIMIT 2000`,
    ).bind(...projectBinds),
  ]);

  const keyFor = (repo: unknown, number: unknown) => `${String(repo)}#${Number(number)}`;
  const details = new Map<string, { captureId: string | null; description: string | null; submittedBy: string | null }>();
  for (const row of captures.results ?? []) {
    const event = row as Record<string, unknown>;
    const capture = captureDetails(event.payload_json);
    const key = keyFor(event.repo, capture.issueNumber);
    if (capture.issueNumber && !details.has(key)) details.set(key, capture);
  }
  const reportByIssue = new Map<string, Record<string, unknown>>();
  for (const row of reports.results ?? []) {
    const report = row as Record<string, unknown>;
    reportByIssue.set(keyFor(report.repo, report.issue_number), report);
  }
  const activityByReport = new Map<string, Array<Record<string, unknown>>>();
  for (const row of activities.results ?? []) {
    const activity = row as Record<string, unknown>;
    const reportId = String(activity.report_id);
    const entries = activityByReport.get(reportId) ?? [];
    entries.push({
      kind: activity.kind,
      actor: activity.actor,
      summary: activity.summary,
      createdAt: activity.created_at,
    });
    activityByReport.set(reportId, entries);
  }
  const mappedIssues = (issues.results ?? []).map((row) => {
    const issue = row as Record<string, unknown>;
    const issueKey = keyFor(issue.repo, issue.number);
    const detail = details.get(issueKey);
    const report = reportByIssue.get(issueKey);
    const reportId = report?.id ? String(report.id) : detail?.captureId ?? null;
    return {
      id: reportId,
      repo: String(issue.repo),
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
      reportStatus: String(report?.status ?? (issue.state === "closed" ? "resolved" : "open")),
      resolutionSummary: report?.resolution_summary ?? null,
      resolvedAt: report?.resolved_at ?? issue.closed_at ?? null,
      resolvedBy: report?.resolved_by ?? null,
      notification: report ? {
        eligible: report.notification_consent === 1,
        status: report.notification_status,
        attempts: Number(report.notification_attempts ?? 0),
        lastError: report.notification_last_error ?? null,
        lastNotifiedAt: report.last_notified_at ?? null,
      } : { eligible: false, status: "not_requested", attempts: 0, lastError: null, lastNotifiedAt: null },
      activity: reportId ? activityByReport.get(reportId) ?? [] : [],
    };
  });
  const countStatus = (status: string) => mappedIssues.filter((issue) => issue.reportStatus === status).length;
  return jsonResponse({
    project: project ? { id: project.id, name: project.name, repo: project.repo } : null,
    counts: {
      open: countStatus("open"),
      investigating: countStatus("investigating"),
      resolved: countStatus("resolved"),
      closed: mappedIssues.filter((issue) => issue.state === "closed").length,
    },
    issues: mappedIssues,
  });
}
