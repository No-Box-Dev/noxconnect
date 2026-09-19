import { decryptToken, encryptToken } from "./crypto.js";
import { TASK, enqueueTask } from "./tasks.js";
import { generateNoxSpotResolutionSummary } from "./noxspot-resolution-ai.js";
import { resolutionTemplateFromWidgetConfig, resolutionTemplateRevision } from "./noxspot-resolution-template.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function storeNoxSpotReport(env, capture, issue) {
  const email = normalizeEmail(capture.reporterEmail);
  const consent = email && capture.notifyOnResolution === true;
  const [encryptedEmail, emailHash] = consent
    ? await Promise.all([encryptToken(email, env.ENCRYPTION_KEY), sha256(email)])
    : [null, null];

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO spot_reports
         (id, org_id, project_id, site_id, repo, issue_number, issue_url, title,
          reporter_name, reporter_email_encrypted, reporter_email_hash,
          notification_consent, notification_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         issue_number = excluded.issue_number,
         issue_url = excluded.issue_url,
         title = excluded.title,
         reporter_name = COALESCE(spot_reports.reporter_name, excluded.reporter_name),
         reporter_email_encrypted = COALESCE(spot_reports.reporter_email_encrypted, excluded.reporter_email_encrypted),
         reporter_email_hash = COALESCE(spot_reports.reporter_email_hash, excluded.reporter_email_hash),
         notification_consent = MAX(spot_reports.notification_consent, excluded.notification_consent),
         updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`,
    ).bind(
      capture.captureId,
      capture.orgId,
      capture.projectId ?? null,
      capture.siteId,
      capture.repo,
      issue.number,
      issue.html_url ?? null,
      capture.title,
      capture.reporterGithubLogin || capture.reporter || null,
      encryptedEmail,
      emailHash,
      consent ? 1 : 0,
      "not_requested",
    ),
    env.DB.prepare(
      `INSERT INTO spot_report_activity (id, report_id, kind, actor, summary)
       VALUES (?, ?, 'created', ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    ).bind(`created:${capture.captureId}`, capture.captureId, capture.reporterGithubLogin || capture.reporter || null, capture.title),
  ]);
}

export async function updateNoxSpotReport(env, input) {
  const report = await env.DB.prepare(
    `SELECT report.id, report.org_id, report.project_id, report.site_id, report.repo,
            report.issue_number, report.issue_url, report.title, report.status,
            report.notification_consent, report.reporter_email_encrypted,
            report.notification_status, report.resolution_email_template_json,
            report.resolution_email_template_revision, site.name AS site_name, site.widget_config
       FROM spot_reports report
       JOIN spot_sites site ON site.id = report.site_id
      WHERE report.id = ? AND report.org_id = ?
        AND (? IS NULL OR report.project_id = ?)
      LIMIT 1`,
  ).bind(input.reportId, input.orgId, input.projectId ?? null, input.projectId ?? null).first();
  if (!report) return null;

  const now = new Date().toISOString();
  const status = input.status;
  const activityKind = status === "open" ? "reopened" : status;
  const resolving = status === "resolved";
  const eligible = report.notification_consent === 1 && Boolean(report.reporter_email_encrypted);
  const retry = input.retryNotification === true && resolving;
  const reopening = status === "open" && report.status === "resolved";
  const firstNotification = resolving && input.notify === true
    && !["pending", "sending", "accepted", "delivered"].includes(String(report.notification_status));
  const queueNotification = eligible && (retry || firstNotification);
  const notificationStatus = queueNotification ? "pending" : reopening && eligible ? "not_requested" : report.notification_status;
  const source = ["platform", "api", "github"].includes(input.source) ? input.source : "platform";
  const summary = cleanSummary(input.summary, resolving ? "This report has been resolved." : null);
  const resolvedTemplate = queueNotification
    ? (report.resolution_email_template_json
      ? resolutionTemplateFromSnapshot(report.resolution_email_template_json)
      : resolutionTemplateFromWidgetConfig(report.widget_config).template)
    : null;
  const templateJson = resolvedTemplate ? JSON.stringify(resolvedTemplate) : null;
  const templateRevision = resolvedTemplate
    ? (report.resolution_email_template_revision || await resolutionTemplateRevision(resolvedTemplate))
    : null;

  const statements = [
    env.DB.prepare(
      `UPDATE spot_reports
          SET status = ?,
              resolution_summary = CASE WHEN ? = 'resolved' THEN ? ELSE resolution_summary END,
              resolved_at = CASE WHEN ? = 'resolved' THEN ? ELSE NULL END,
              resolved_by = CASE WHEN ? = 'resolved' THEN ? ELSE NULL END,
              resolution_source = CASE WHEN ? = 'resolved' THEN ? ELSE NULL END,
              notification_status = ?,
              notification_message_id = CASE WHEN ? THEN NULL ELSE notification_message_id END,
              notification_last_error = CASE WHEN ? = 'pending' OR ? THEN NULL ELSE notification_last_error END,
              resolution_email_template_json = CASE WHEN ? THEN NULL WHEN ? THEN ? ELSE resolution_email_template_json END,
              resolution_email_template_revision = CASE WHEN ? THEN NULL WHEN ? THEN ? ELSE resolution_email_template_revision END,
              updated_at = ?
        WHERE id = ?`,
    ).bind(
      status,
      status, summary,
      status, now,
      status, input.actor ?? null,
      status, source,
      notificationStatus,
      reopening ? 1 : 0,
      notificationStatus,
      reopening ? 1 : 0,
      reopening ? 1 : 0,
      queueNotification ? 1 : 0,
      templateJson,
      reopening ? 1 : 0,
      queueNotification ? 1 : 0,
      templateRevision,
      now,
      report.id,
    ),
    env.DB.prepare(
      `INSERT INTO spot_report_activity (id, report_id, kind, actor, summary, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    ).bind(
      `status:${report.id}:${status}:${now}`,
      report.id,
      activityKind,
      input.actor ?? null,
      summary,
      now,
    ),
  ];
  if (queueNotification) {
    statements.push(env.DB.prepare(
      `INSERT INTO spot_report_activity (id, report_id, kind, actor, summary, created_at)
       VALUES (?, ?, 'notification_queued', ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    ).bind(`notification-queued:${report.id}:${now}`, report.id, input.actor ?? null, summary, now));
  }
  await env.DB.batch(statements);

  if (queueNotification) {
    await enqueueTask(env, input.ownerId, `noxspot-resolution:${report.id}:${now}`, {
      type: TASK.SPOT_SEND_RESOLUTION_EMAIL,
      reportId: report.id,
    });
  }

  return {
    id: report.id,
    status,
    resolutionSummary: resolving ? summary : null,
    resolvedAt: resolving ? now : null,
    notification: {
      eligible,
      requested: queueNotification,
      status: notificationStatus,
    },
  };
}

export async function resolveNoxSpotReportFromIssue(env, input) {
  const report = await env.DB.prepare(
    `SELECT id, project_id, notification_consent, reporter_email_encrypted FROM spot_reports
      WHERE org_id = ? AND repo = ? AND issue_number = ?
      LIMIT 1`,
  ).bind(input.orgId, input.repo, input.issueNumber).first();
  if (!report) return { skipped: "not_noxspot_report" };
  const result = await updateNoxSpotReport(env, {
    reportId: report.id,
    orgId: input.orgId,
    projectId: report.project_id ?? null,
    ownerId: input.ownerId,
    actor: input.actor ?? "github",
    source: "github",
    status: "resolved",
    summary: input.summary || "The linked GitHub issue was closed.",
    notify: false,
  });
  const eligible = report.notification_consent === 1 && Boolean(report.reporter_email_encrypted) && Boolean(report.project_id);
  if (!eligible) return result;

  await env.DB.prepare(
    `UPDATE spot_reports
        SET resolution_ai_status = 'pending', resolution_ai_evidence_source = NULL,
            resolution_ai_model = NULL, resolution_ai_last_error = NULL,
            updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      WHERE id = ? AND status = 'resolved'`,
  ).bind(report.id).run();
  await enqueueTask(env, input.ownerId, `noxspot-resolution-prepare:${report.id}:${result.resolvedAt}`, {
    type: TASK.SPOT_PREPARE_RESOLUTION_EMAIL,
    reportId: report.id,
  });
  return { ...result, notification: { ...result.notification, requested: true, status: "preparing" } };
}

export async function reopenNoxSpotReportFromIssue(env, input) {
  const report = await env.DB.prepare(
    `SELECT id, project_id FROM spot_reports
      WHERE org_id = ? AND repo = ? AND issue_number = ?
      LIMIT 1`,
  ).bind(input.orgId, input.repo, input.issueNumber).first();
  if (!report) return { skipped: "not_noxspot_report" };
  const result = await updateNoxSpotReport(env, {
    reportId: report.id,
    orgId: input.orgId,
    projectId: report.project_id ?? null,
    ownerId: input.ownerId,
    actor: input.actor ?? "github",
    source: "github",
    status: "open",
    summary: input.summary || "The linked GitHub issue was reopened.",
    notify: false,
  });
  await env.DB.prepare(
    `UPDATE spot_reports
        SET resolution_ai_status = 'not_requested', resolution_ai_evidence_source = NULL,
            resolution_ai_model = NULL, resolution_ai_last_error = NULL
      WHERE id = ?`,
  ).bind(report.id).run();
  return result;
}

export async function prepareNoxSpotResolutionEmail(env, reportId) {
  const report = await env.DB.prepare(
    `SELECT report.id, report.org_id, report.project_id, report.repo, report.issue_number,
            report.title, report.resolved_at, report.notification_consent,
            report.reporter_email_encrypted, report.resolution_ai_status,
            org.github_login AS owner_id, org.installation_id, site.widget_config
       FROM spot_reports report
       JOIN orgs org ON org.id = report.org_id
       JOIN spot_sites site ON site.id = report.site_id
      WHERE report.id = ? AND report.status = 'resolved'
      LIMIT 1`,
  ).bind(reportId).first();
  if (!report || report.notification_consent !== 1 || !report.reporter_email_encrypted || !report.project_id) {
    return { skipped: "not_eligible" };
  }
  if (report.resolution_ai_status === "ready") return { skipped: "already_prepared" };

  const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const claim = await env.DB.prepare(
    `UPDATE spot_reports
        SET resolution_ai_status = 'generating', resolution_ai_last_error = NULL,
            updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      WHERE id = ? AND (resolution_ai_status IN ('pending', 'failed')
             OR (resolution_ai_status = 'generating' AND updated_at < ?))`,
  ).bind(report.id, stale).run();
  if ((claim.meta?.changes ?? 0) === 0) return { skipped: "already_claimed" };

  try {
    const resolvedTemplate = resolutionTemplateFromWidgetConfig(report.widget_config);
    const templateRevision = await resolutionTemplateRevision(resolvedTemplate.template);
    const generated = await generateNoxSpotResolutionSummary(env, {
      ...report,
      resolution_email_tone: resolvedTemplate.template.tone,
    });
    if (generated.status === "insufficient_evidence") {
      await env.DB.prepare(
        `UPDATE spot_reports
            SET resolution_ai_status = 'insufficient', resolution_ai_evidence_source = ?,
                resolution_ai_last_error = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
          WHERE id = ?`,
      ).bind(generated.evidenceSource, "No closing pull request or maintainer resolution comment was available.", report.id).run();
      return { status: "insufficient_evidence" };
    }

    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE spot_reports
            SET resolution_summary = ?, resolution_ai_status = 'ready',
                resolution_ai_evidence_source = ?, resolution_ai_model = ?,
                resolution_email_template_json = ?, resolution_email_template_revision = ?,
                resolution_ai_last_error = NULL, notification_status = 'pending', updated_at = ?
          WHERE id = ? AND status = 'resolved'`,
      ).bind(
        generated.summary, generated.evidenceSource, generated.model,
        JSON.stringify(resolvedTemplate.template), templateRevision, now, report.id,
      ),
      env.DB.prepare(
        `INSERT INTO spot_report_activity (id, report_id, kind, actor, summary, created_at)
         VALUES (?, ?, 'notification_queued', 'noxconnect', ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      ).bind(`notification-queued:${report.id}:${report.resolved_at}`, report.id, generated.summary, now),
    ]);
    await enqueueTask(env, report.owner_id, `noxspot-resolution:${report.id}:${report.resolved_at}`, {
      type: TASK.SPOT_SEND_RESOLUTION_EMAIL,
      reportId: report.id,
    });
    return { status: "ready", summary: generated.summary, evidenceSource: generated.evidenceSource };
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : "Resolution summary generation failed";
    await env.DB.prepare(
      `UPDATE spot_reports SET resolution_ai_status = 'failed', resolution_ai_last_error = ?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?`,
    ).bind(message, report.id).run();
    throw error;
  }
}

export async function deliverNoxSpotResolutionEmail(env, reportId) {
  const report = await env.DB.prepare(
    `SELECT report.id, report.title, report.issue_url, report.resolution_summary,
            report.resolved_at, report.reporter_email_encrypted,
            report.notification_consent, report.notification_status,
            report.updated_at, report.reporter_name, report.org_id, report.project_id,
            report.site_id, report.repo, report.issue_number,
            report.resolution_email_template_json, site.name AS site_name, site.widget_config
       FROM spot_reports report
       JOIN spot_sites site ON site.id = report.site_id
      WHERE report.id = ? AND report.status = 'resolved'
      LIMIT 1`,
  ).bind(reportId).first();
  if (!report || report.notification_consent !== 1 || !report.reporter_email_encrypted) {
    return { skipped: "not_eligible" };
  }
  if (["accepted", "delivered"].includes(String(report.notification_status))) {
    return { skipped: "already_sent" };
  }

  const staleSendingBefore = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const claim = await env.DB.prepare(
    `UPDATE spot_reports
        SET notification_status = 'sending',
            notification_attempts = notification_attempts + 1,
            updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      WHERE id = ?
        AND (notification_status IN ('pending', 'failed', 'bounced')
             OR (notification_status = 'sending' AND updated_at < ?))`,
  ).bind(report.id, staleSendingBefore).run();
  if ((claim.meta?.changes ?? 0) === 0) return { skipped: "already_claimed" };

  try {
    const recipient = await decryptToken(report.reporter_email_encrypted, env.ENCRYPTION_KEY);
    const responseUrl = await ensureResolutionResponseUrl(env, report);
    const presentation = report.resolution_email_template_json
      ? resolutionTemplateFromSnapshot(report.resolution_email_template_json)
      : resolutionTemplateFromWidgetConfig(report.widget_config).template;
    const receipt = await env.NOXCONNECT_EMAIL.sendEmail({
      contract: "noxconnect.transactional-email",
      version: 1,
      requestId: `noxspot-resolution:${report.id}:${report.resolved_at || "resolved"}`,
      recipient,
      template: "noxspot.resolution",
      model: {
        siteName: report.site_name,
        reportTitle: report.title,
        summary: report.resolution_summary || "This report has been resolved.",
        presentation,
        ...(report.reporter_name ? { reporterName: report.reporter_name } : {}),
        ...(responseUrl ? { responseUrl } : {}),
      },
    });
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE spot_reports
            SET notification_status = 'accepted', notification_message_id = ?,
                notification_last_error = NULL, last_notified_at = ?, updated_at = ?
          WHERE id = ?`,
      ).bind(receipt.messageId, now, now, report.id),
      env.DB.prepare(
        `INSERT INTO spot_report_activity (id, report_id, kind, actor, summary, created_at)
         VALUES (?, ?, 'notification_accepted', 'noxconnect', ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      ).bind(`notification-accepted:${receipt.messageId}`, report.id, "Resolution email accepted by Postmark.", now),
    ]);
    return { status: "accepted", messageId: receipt.messageId };
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : "Resolution email failed";
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE spot_reports
            SET notification_status = 'failed', notification_last_error = ?, updated_at = ?
          WHERE id = ?`,
      ).bind(message, now, report.id),
      env.DB.prepare(
        `INSERT INTO spot_report_activity (id, report_id, kind, actor, summary, created_at)
         VALUES (?, ?, 'notification_failed', 'noxconnect', ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      ).bind(`notification-failed:${report.id}:${now}`, report.id, message, now),
    ]);
    throw error;
  }
}

function resolutionTemplateFromSnapshot(value) {
  try {
    return resolutionTemplateFromWidgetConfig({ resolutionEmail: JSON.parse(String(value)) }).template;
  } catch {
    return resolutionTemplateFromWidgetConfig(null).template;
  }
}

async function ensureResolutionResponseUrl(env, report) {
  const baseUrl = typeof env.NOXSPOT_PUBLIC_URL === "string" ? env.NOXSPOT_PUBLIC_URL.replace(/\/$/, "") : "";
  if (!baseUrl || !report.project_id || !report.resolved_at) return null;
  const resolutionKey = `${report.id}:${report.resolved_at}`;
  const existing = await env.DB.prepare(
    "SELECT token_encrypted FROM spot_report_response_tokens WHERE resolution_key = ? LIMIT 1",
  ).bind(resolutionKey).first();
  if (existing?.token_encrypted) {
    const token = await decryptToken(existing.token_encrypted, env.ENCRYPTION_KEY);
    return `${baseUrl}/resolution/${encodeURIComponent(token)}`;
  }

  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const [tokenHash, tokenEncrypted] = await Promise.all([
    sha256(token),
    encryptToken(token, env.ENCRYPTION_KEY),
  ]);
  const expiresAt = new Date(Date.now() + 90 * 86_400_000).toISOString();
  await env.DB.prepare(
    `INSERT INTO spot_report_response_tokens
       (token_hash, token_encrypted, resolution_key, report_id, org_id, project_id,
        site_id, repo, issue_number, report_title, reporter_name, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(resolution_key) DO NOTHING`,
  ).bind(
    tokenHash, tokenEncrypted, resolutionKey, report.id, report.org_id, report.project_id,
    report.site_id, report.repo, report.issue_number, report.title, report.reporter_name ?? null, expiresAt,
  ).run();
  const stored = await env.DB.prepare(
    "SELECT token_encrypted FROM spot_report_response_tokens WHERE resolution_key = ? LIMIT 1",
  ).bind(resolutionKey).first();
  const resolvedToken = stored?.token_encrypted
    ? await decryptToken(stored.token_encrypted, env.ENCRYPTION_KEY)
    : token;
  return `${baseUrl}/resolution/${encodeURIComponent(resolvedToken)}`;
}

export async function recoverNoxSpotResolutionEmails(env) {
  const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const result = await env.DB.prepare(
    `SELECT report.id, org.github_login AS owner_id FROM spot_reports report
      JOIN orgs org ON org.id = report.org_id
      WHERE report.status = 'resolved' AND report.notification_consent = 1
        AND (report.notification_status IN ('pending', 'failed')
             OR (report.notification_status = 'sending' AND report.updated_at < ?))
      ORDER BY report.updated_at ASC LIMIT 100`,
  ).bind(stale).all();
  for (const row of result.results ?? []) {
    await env.TASK_QUEUE.send({
      type: TASK.SPOT_SEND_RESOLUTION_EMAIL,
      reportId: row.id,
      ownerId: String(row.owner_id),
      deliveryId: `noxspot-resolution-recovery:${row.id}`,
    });
  }
  return { queued: result.results?.length ?? 0 };
}

export async function recoverNoxSpotResolutionPreparations(env) {
  const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const result = await env.DB.prepare(
    `SELECT report.id, org.github_login AS owner_id
       FROM spot_reports report
       JOIN orgs org ON org.id = report.org_id
      WHERE report.status = 'resolved' AND report.notification_consent = 1
        AND (report.resolution_ai_status IN ('pending', 'failed')
             OR (report.resolution_ai_status = 'generating' AND report.updated_at < ?))
      ORDER BY report.updated_at ASC LIMIT 100`,
  ).bind(stale).all();
  for (const row of result.results ?? []) {
    await env.TASK_QUEUE.send({
      type: TASK.SPOT_PREPARE_RESOLUTION_EMAIL,
      reportId: row.id,
      ownerId: String(row.owner_id),
      deliveryId: `noxspot-resolution-prepare-recovery:${row.id}`,
    });
  }
  return { queued: result.results?.length ?? 0 };
}

function normalizeEmail(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length <= 254 && EMAIL_PATTERN.test(normalized) ? normalized : null;
}

function cleanSummary(value, fallback) {
  if (typeof value !== "string" || !value.trim()) return fallback;
  return value.trim().slice(0, 4000);
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
