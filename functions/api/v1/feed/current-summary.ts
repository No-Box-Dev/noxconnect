import { getCtx, jsonResponse } from "../../../lib/db";
import { getActiveRepoNames } from "../../../lib/inactive-repos";

interface Ctx {
  env: { DB: D1Database };
  data: { orgId: number; orgLogin: string; projectId?: string | null };
}

interface MemberRow {
  login: string;
  avatar_url: string;
  kind: string;
}

interface CountRow { login: string; count: number }

export async function onRequestGet(context: Ctx): Promise<Response> {
  const { orgId, orgLogin, projectId } = getCtx(context);
  const activeRepos = await getActiveRepoNames(context.env.DB, orgId, orgLogin, projectId);
  const settingsRow = await context.env.DB.prepare(projectId
    ? "SELECT data FROM project_config WHERE org_id = ? AND project_id = ? AND key = 'settings'"
    : "SELECT data FROM config WHERE org_id = ? AND key = 'settings'")
    .bind(...(projectId ? [orgId, projectId] : [orgId]))
    .first<{ data?: string }>();
  let excludedMembers: string[] = [];
  try {
    const settings = settingsRow?.data ? JSON.parse(settingsRow.data) as { excludedMembers?: unknown } : null;
    if (Array.isArray(settings?.excludedMembers)) {
      excludedMembers = settings.excludedMembers.filter((value): value is string => typeof value === "string");
    }
  } catch { /* The config endpoint reports corrupt rows; keep this read surface available. */ }

  const repoSql = activeRepos.length ? `repo IN (${activeRepos.map(() => "?").join(",")})` : "0";
  const [members, pullRequests, issues] = await context.env.DB.batch([
    context.env.DB.prepare(
      "SELECT login, avatar_url, kind FROM members WHERE org_id = ? AND kind != 'bot' ORDER BY login",
    ).bind(orgId),
    context.env.DB.prepare(
      `SELECT LOWER(author) AS login, COUNT(*) AS count FROM pull_requests
        WHERE org_id = ? AND state = 'open' AND ${repoSql}
        GROUP BY LOWER(author)`,
    ).bind(orgId, ...activeRepos),
    context.env.DB.prepare(
      `SELECT LOWER(json_extract(assignee.value, '$.login')) AS login, COUNT(DISTINCT issue.id) AS count
         FROM issues issue, json_each(COALESCE(issue.assignees_json, '[]')) assignee
        WHERE issue.org_id = ? AND issue.state = 'open' AND ${activeRepos.length ? `issue.repo IN (${activeRepos.map(() => "?").join(",")})` : "0"}
        GROUP BY LOWER(json_extract(assignee.value, '$.login'))`,
    ).bind(orgId, ...activeRepos),
  ]);
  const excluded = new Set(excludedMembers.map((login) => login.toLowerCase()));
  const prCounts = new Map(((pullRequests.results ?? []) as unknown as CountRow[]).map((row) => [String(row.login), Number(row.count ?? 0)]));
  const issueCounts = new Map(((issues.results ?? []) as unknown as CountRow[]).map((row) => [String(row.login), Number(row.count ?? 0)]));
  const people = ((members.results ?? []) as unknown as MemberRow[])
    .filter((member) => !excluded.has(member.login.toLowerCase()))
    .map((member) => ({
      member: { login: member.login, avatar_url: member.avatar_url, kind: member.kind === "bot" ? "bot" : "human" },
      counts: { prs: prCounts.get(member.login.toLowerCase()) ?? 0, issues: issueCounts.get(member.login.toLowerCase()) ?? 0 },
    }));
  return jsonResponse({ people });
}
