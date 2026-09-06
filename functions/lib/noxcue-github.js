import { getInstallationIdForOrg, getInstallationToken } from "./github-app.js";
import { upsertIssue } from "./github-sync.js";
import {
  createRepositoryIssue,
  createRepositoryIssueComment,
  ensureRepositoryLabels,
  findIssueByBodyMarker,
  getRepositoryIssue,
  updateRepositoryIssue,
} from "./github-issues.js";
import { isAppEnabled } from "./apps.js";

export async function createOrUpdateNoxCueGitHubIssue(env, task) {
  if (!task?.incidentId) throw new Error("Invalid NoxCue GitHub issue task");
  const claimed = await env.DB.prepare(
    `UPDATE cue_github_incidents
        SET status = 'processing', processing_occurrence_count = occurrence_count,
            updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      WHERE id = ? AND status IN ('pending', 'failed')`,
  ).bind(task.incidentId).run();
  if (!claimed.meta.changes) return { skipped: "already_processing_or_current" };

  try {
    return await processIncident(env, task.incidentId);
  } catch (error) {
    await env.DB.prepare(
      `UPDATE cue_github_incidents SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?`,
    ).bind(errorMessage(error), new Date().toISOString(), task.incidentId).run();
    throw error;
  }
}

async function processIncident(env, incidentId) {
  const row = await env.DB.prepare(
    `SELECT incident.*, setting.enabled, setting.environments_json, setting.comment_on_repeat,
            setting.repeat_interval_minutes, project.repo, org.github_login, source.name AS source_name
       FROM cue_github_incidents incident
       JOIN cue_github_issue_settings setting
         ON setting.org_id = incident.org_id AND setting.project_id = incident.project_id
       JOIN orgs org ON org.id = incident.org_id
       JOIN projects project ON project.id = incident.project_id AND project.owner_id = org.github_login
       JOIN cue_sources source ON source.id = incident.source_id AND source.org_id = incident.org_id
      WHERE incident.id = ?`,
  ).bind(incidentId).first();
  if (!row) {
    await markDisabled(env.DB, incidentId, "GitHub issue routing is not configured for this project");
    return { skipped: "not_configured" };
  }
  if (!row.enabled || !enabledEnvironment(row.environments_json, row.environment)) {
    await markDisabled(env.DB, incidentId, `GitHub issues are disabled for ${row.environment}`);
    return { skipped: "environment_disabled" };
  }
  if (!(await isAppEnabled(env.DB, row.org_id, "noxcue"))) {
    await markDisabled(env.DB, incidentId, "NoxCue is disabled");
    return { skipped: "service_disabled" };
  }
  if (!row.github_login || !validRepo(row.repo)) throw new Error("Linked project does not have a valid GitHub repository");
  const installationId = await getInstallationIdForOrg(env.DB, row.org_id);
  if (!installationId) throw new Error(`GitHub App not installed for org ${row.org_id}`);
  const token = await getInstallationToken(env, installationId);
  if (!env.NOXCUE_RESPONSE?.buildGitHubIncident) throw new Error("NoxCue incident service binding is unavailable");
  const presentation = requirePresentation(await env.NOXCUE_RESPONSE.buildGitHubIncident({
    environment: row.environment,
    incidentKey: row.incident_key,
    title: row.title,
    payloadJson: row.payload_json,
    sourceName: row.source_name,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    occurrenceCount: row.occurrence_count,
  }, row.previous_issue_url ? { url: row.previous_issue_url } : null));
  const marker = presentation.marker;

  let issue = null;
  if (row.github_issue_number && row.github_repo === row.repo) {
    try {
      issue = await getRepositoryIssue(token, row.github_login, row.repo, row.github_issue_number);
    } catch (error) {
      if (error?.status !== 404) throw error;
    }
  }
  if (!issue) issue = await findIssueByBodyMarker(token, row.github_login, row.repo, marker);

  const previous = issue?.state === "closed" ? issue : null;
  let wroteIssue = false;
  if (issue?.state === "open") {
    const shouldUpdate = updateDue(row.last_github_update_at, row.repeat_interval_minutes)
      || presentation.latestRelease !== (row.last_github_release ?? null);
    if (shouldUpdate) {
      issue = await updateRepositoryIssue(token, row.github_login, row.repo, issue.number, {
        body: presentation.body,
      });
      wroteIssue = true;
      if (row.comment_on_repeat) {
        await createRepositoryIssueComment(
          token, row.github_login, row.repo, issue.number,
          presentation.repeatComment,
        );
      }
    }
  } else {
    const createPresentation = previous
      ? requirePresentation(await env.NOXCUE_RESPONSE.buildGitHubIncident({
          environment: row.environment, incidentKey: row.incident_key, title: row.title,
          payloadJson: row.payload_json, sourceName: row.source_name,
          firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at,
          occurrenceCount: row.occurrence_count,
        }, { url: previous.html_url }))
      : presentation;
    await ensureRepositoryLabels(token, row.github_login, row.repo, createPresentation.labels);
    issue = await createRepositoryIssue(token, row.github_login, row.repo, {
      title: createPresentation.title,
      body: createPresentation.body,
      labels: createPresentation.labels.map((label) => label.name),
    });
    wroteIssue = true;
  }

  await upsertIssue(env.DB, row.org_id, row.repo, issue);
  const now = new Date().toISOString();
  await env.DB.batch([
    ...(previous ? [env.DB.prepare(
      `UPDATE cue_github_issue_links SET closed_at = COALESCE(closed_at, ?)
        WHERE incident_id = ? AND repo = ? AND issue_number = ?`,
    ).bind(now, incidentId, row.repo, previous.number)] : []),
    env.DB.prepare(
      `INSERT INTO cue_github_issue_links
         (incident_id, repo, issue_number, issue_url, opened_at, closed_at)
       VALUES (?, ?, ?, ?, ?, NULL)
       ON CONFLICT(incident_id, repo, issue_number) DO UPDATE SET
         issue_url = excluded.issue_url, closed_at = NULL`,
    ).bind(incidentId, row.repo, issue.number, issue.html_url, issue.created_at ?? now),
    env.DB.prepare(
      `UPDATE cue_github_incidents SET
         status = CASE WHEN occurrence_count > processing_occurrence_count THEN 'pending' ELSE 'open' END,
         github_repo = ?, github_issue_number = ?, github_issue_url = ?, github_issue_state = 'open',
         previous_issue_number = ?, previous_issue_url = ?, last_github_update_at = ?,
         last_github_release = ?, last_error = NULL, updated_at = ? WHERE id = ?`,
    ).bind(
      row.repo, issue.number, issue.html_url, previous?.number ?? row.previous_issue_number ?? null,
      previous?.html_url ?? row.previous_issue_url ?? null,
      wroteIssue ? now : row.last_github_update_at,
      wroteIssue ? presentation.latestRelease : row.last_github_release,
      now, incidentId,
    ),
  ]);
  const pending = await env.DB.prepare("SELECT status FROM cue_github_incidents WHERE id = ?")
    .bind(incidentId).first();
  if (pending?.status === "pending") {
    await env.TASK_QUEUE.send({ type: "noxcue_github_issue", incidentId, ownerId: row.github_login, deliveryId: `noxcue:${incidentId}:${now}` });
  }
  return { number: issue.number, url: issue.html_url, deduplicated: !previous && Boolean(row.github_issue_number) };
}

export async function recoverNoxCueGithubIncidents(env) {
  const result = await env.DB.prepare(
    `SELECT incident.id, org.github_login AS owner_id
       FROM cue_github_incidents incident JOIN orgs org ON org.id = incident.org_id
      WHERE incident.status IN ('pending', 'failed')
        AND (incident.last_queued_at IS NULL OR datetime(incident.last_queued_at) <= datetime('now', '-10 minutes'))
      ORDER BY incident.updated_at LIMIT 50`,
  ).all();
  for (const row of result.results ?? []) {
    await env.TASK_QUEUE.send({
      type: "noxcue_github_issue",
      incidentId: row.id,
      ownerId: row.owner_id,
      deliveryId: `noxcue:${row.id}:recovery`,
    });
    await env.DB.prepare("UPDATE cue_github_incidents SET last_queued_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), row.id).run();
  }
}

function enabledEnvironment(raw, environment) {
  try { return JSON.parse(raw).includes(environment); } catch { return false; }
}

function updateDue(last, minutes) { return !last || Date.now() - Date.parse(last) >= Number(minutes) * 60_000; }
function validRepo(value) { return typeof value === "string" && /^[A-Za-z0-9_.-]{1,100}$/.test(value); }
function requirePresentation(value) {
  if (!value || typeof value.marker !== "string" || typeof value.title !== "string" || typeof value.body !== "string"
    || !Array.isArray(value.labels) || typeof value.repeatComment !== "string") throw new Error("NoxCue returned an invalid incident presentation");
  return value;
}
function errorMessage(error) { return (error instanceof Error ? error.message : String(error)).slice(0, 500); }
async function markDisabled(db, id, reason) {
  await db.prepare("UPDATE cue_github_incidents SET status = 'disabled', last_error = ?, updated_at = ? WHERE id = ?")
    .bind(reason, new Date().toISOString(), id).run();
}
