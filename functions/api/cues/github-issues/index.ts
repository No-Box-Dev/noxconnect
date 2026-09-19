import { z } from "zod";
import { errorResponse, getCtx, jsonResponse } from "../../../lib/db";
import { getNoxDb, type NoxDatabaseEnv } from "../../../lib/nox-db";
import { validate } from "../../../lib/validate";

const ENVIRONMENTS = ["production", "staging", "development", "preview", "test", "local"] as const;
const UpdateSchema = z.object({
  projectId: z.string().min(1).max(200),
  enabled: z.boolean(),
  environments: z.array(z.enum(ENVIRONMENTS)).min(1).max(ENVIRONMENTS.length)
    .refine((items) => new Set(items).size === items.length, "Environments must be unique"),
  commentOnRepeat: z.boolean().default(false),
  repeatIntervalMinutes: z.number().int().min(15).max(10080).default(360),
}).strict();

interface Ctx {
  env: NoxDatabaseEnv;
  data: { orgId: number; projectId?: string | null; orgLogin: string; userLogin: string; isAdmin: boolean };
  request: Request;
}

interface ProjectRow {
  id: string; name: string; repo: string | null; enabled: number | null;
  environments_json: string | null; comment_on_repeat: number | null;
  repeat_interval_minutes: number | null; open_incidents: number;
}

export async function onRequestGet(context: Ctx): Promise<Response> {
  const { orgId, projectId, isAdmin } = getCtx(context) as Ctx["data"];
  if (!orgId) return errorResponse("Missing org context", 400);
  if (!isAdmin) return errorResponse("Admin required", 403);
  const db = getNoxDb(context.env);
  const [projects, org] = await Promise.all([
    db.prepare(
      `SELECT project.id, project.name, project.repo, setting.enabled, setting.environments_json,
              setting.comment_on_repeat, setting.repeat_interval_minutes,
              COUNT(CASE WHEN incident.status = 'open' THEN 1 END) AS open_incidents
         FROM projects project
         JOIN project_routing_settings routing
           ON routing.project_id = project.id AND routing.org_id = ? AND routing.enabled = 1
         LEFT JOIN cue_github_issue_settings setting
           ON setting.org_id = routing.org_id AND setting.project_id = project.id
         LEFT JOIN cue_github_incidents incident
           ON incident.org_id = routing.org_id AND incident.project_id = project.id
        WHERE project.org_id = ?${projectId ? " AND project.id = ?" : ""} AND COALESCE(project.archived, 0) = 0
        GROUP BY project.id, project.name, project.repo, setting.enabled, setting.environments_json,
                 setting.comment_on_repeat, setting.repeat_interval_minutes
        ORDER BY project.name`,
    ).bind(...(projectId ? [orgId, orgId, projectId] : [orgId, orgId])).all<ProjectRow>(),
    db.prepare("SELECT installation_id FROM orgs WHERE id = ?").bind(orgId)
      .first<{ installation_id: number | null }>(),
  ]);
  return jsonResponse({
    githubConnected: Boolean(org?.installation_id),
    projects: (projects.results ?? []).map(present),
  });
}

export async function onRequestPut(context: Ctx): Promise<Response> {
  const { orgId, projectId, userLogin, isAdmin } = getCtx(context) as Ctx["data"];
  if (!orgId) return errorResponse("Missing org context", 400);
  if (!isAdmin) return errorResponse("Admin required", 403);
  let raw: unknown;
  try { raw = await context.request.json(); } catch { return errorResponse("Invalid JSON body", 400); }
  const parsed = validate(UpdateSchema, raw);
  if (!parsed.ok) return parsed.response;
  if (projectId && parsed.data.projectId !== projectId) return errorResponse("The requested resource was not found", 404);
  const targetProjectId = projectId || parsed.data.projectId;
  const db = getNoxDb(context.env);
  const project = await db.prepare(
    `SELECT project.id, project.name, project.repo
       FROM projects project JOIN project_routing_settings routing ON routing.project_id = project.id
      WHERE project.id = ? AND project.org_id = ? AND routing.org_id = ? AND routing.enabled = 1
        AND COALESCE(project.archived, 0) = 0`,
  ).bind(targetProjectId, orgId, orgId).first<{ id: string; name: string; repo: string | null }>();
  if (!project) return errorResponse("Active project not found", 404);
  if (parsed.data.enabled && !project.repo) return errorResponse("Link a GitHub repository to this project first", 409);
  await db.prepare(
    `INSERT INTO cue_github_issue_settings
       (org_id, project_id, enabled, environments_json, comment_on_repeat,
        repeat_interval_minutes, created_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(org_id, project_id) DO UPDATE SET
       enabled = excluded.enabled, environments_json = excluded.environments_json,
       comment_on_repeat = excluded.comment_on_repeat,
       repeat_interval_minutes = excluded.repeat_interval_minutes, updated_at = excluded.updated_at`,
  ).bind(
    orgId, project.id, parsed.data.enabled ? 1 : 0, JSON.stringify(parsed.data.environments),
    parsed.data.commentOnRepeat ? 1 : 0, parsed.data.repeatIntervalMinutes, userLogin,
    new Date().toISOString(),
  ).run();
  const saved = await db.prepare(
    `SELECT project.id, project.name, project.repo, setting.enabled, setting.environments_json,
            setting.comment_on_repeat, setting.repeat_interval_minutes,
            0 AS open_incidents
       FROM projects project JOIN cue_github_issue_settings setting ON setting.project_id = project.id
      WHERE project.id = ? AND setting.org_id = ?`,
  ).bind(project.id, orgId).first<ProjectRow>();
  return jsonResponse({ project: present(saved!) });
}

function present(row: ProjectRow) {
  return {
    projectId: row.id,
    projectName: row.name,
    repo: row.repo,
    enabled: row.enabled === 1,
    environments: parseEnvironments(row.environments_json),
    commentOnRepeat: row.comment_on_repeat === 1,
    repeatIntervalMinutes: row.repeat_interval_minutes ?? 360,
    openIncidents: Number(row.open_incidents ?? 0),
  };
}

function parseEnvironments(raw: string | null): Array<typeof ENVIRONMENTS[number]> {
  try {
    const value = JSON.parse(raw ?? "");
    if (Array.isArray(value)) return value.filter((item): item is typeof ENVIRONMENTS[number] => ENVIRONMENTS.includes(item));
  } catch { /* use the safe default */ }
  return ["production"];
}
