import type { Context } from "hono";

export const RESPONSE_TEXT_MAX = 2_000;
export const RESPONSE_SCREENSHOT_MAX = 7_000_000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const CLAIM_STALE_MS = 10 * 60_000;

interface NoxConnectCapability {
  execute(command: unknown): Promise<unknown>;
}

export type NoxSpotEnv = Omit<Env, "NOXCONNECT"> & { NOXCONNECT: NoxConnectCapability };
type AppContext = Context<{ Bindings: NoxSpotEnv }>;

interface TokenRow {
  token_hash: string;
  report_id: string | null;
  org_id: number;
  project_id: string;
  site_id: string;
  repo: string;
  issue_number: number;
  report_title: string;
  reporter_name: string | null;
  expires_at: string;
  claimed_at: string | null;
  used_at: string | null;
}

export async function resolutionResponsePage(context: AppContext): Promise<Response> {
  const token = context.req.param("token");
  const row = await activeToken(context.env.DB, token);
  if (!row) return page("Link unavailable", unavailableBody(), 404);
  return page(
    "Is this still not fixed?",
    `<p class="eyebrow">${escapeHtml(row.report_title)}</p>
     <h1>Tell us what is still happening</h1>
     <p class="intro">Your response will reopen the existing issue for the Playnist team.</p>
     <form method="post" enctype="multipart/form-data" action="/api/spots/public/v1/resolution-responses/${encodeURIComponent(token)}">
       <label for="message">What is still not working? <span>Optional</span></label>
       <textarea id="message" name="message" maxlength="${RESPONSE_TEXT_MAX}" rows="5" placeholder="A short note is enough"></textarea>
       <label for="screenshot">Add a screenshot <span>Optional</span></label>
       <input id="screenshot" name="screenshot" type="file" accept="image/png,image/jpeg,image/webp" />
       <button type="submit">Reopen issue</button>
     </form>`,
    200,
  );
}

export async function submitResolutionResponse(context: AppContext): Promise<Response> {
  const token = context.req.param("token");
  if (!TOKEN_PATTERN.test(token)) return page("Link unavailable", unavailableBody(), 404);
  const hash = await sha256(token);
  const row = await context.env.DB.prepare(
    `SELECT token_hash, report_id, org_id, project_id, site_id, repo, issue_number,
            report_title, reporter_name, expires_at, claimed_at, used_at
       FROM spot_report_response_tokens WHERE token_hash = ? LIMIT 1`,
  ).bind(hash).first<TokenRow>();
  if (!isAvailable(row)) return page("Link unavailable", unavailableBody(), 404);

  const contentLength = Number(context.req.header("Content-Length"));
  if (Number.isFinite(contentLength) && contentLength > RESPONSE_SCREENSHOT_MAX + 100_000) {
    return page("Response too large", "<p>Please use a screenshot smaller than 7 MB.</p>", 413);
  }
  let form: FormData;
  try { form = await context.req.raw.formData(); }
  catch { return page("Could not read response", "<p>Please return to the email and try again.</p>", 400); }
  const messageValue = form.get("message");
  const responseText = typeof messageValue === "string" ? messageValue.trim().slice(0, RESPONSE_TEXT_MAX) : "";
  const screenshot = form.get("screenshot");
  if (screenshot instanceof File && screenshot.size > RESPONSE_SCREENSHOT_MAX) {
    return page("Screenshot too large", "<p>Please use a screenshot smaller than 7 MB.</p>", 413);
  }
  if (screenshot instanceof File && screenshot.size > 0 && !["image/png", "image/jpeg", "image/webp"].includes(screenshot.type)) {
    return page("Unsupported screenshot", "<p>Please upload a PNG, JPEG, or WebP image.</p>", 415);
  }

  const responseId = crypto.randomUUID();
  const staleBefore = new Date(Date.now() - CLAIM_STALE_MS).toISOString();
  const claimed = await context.env.DB.prepare(
    `UPDATE spot_report_response_tokens
        SET claimed_at = ?, response_id = ?, last_error = NULL, updated_at = ?
      WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?
        AND (claimed_at IS NULL OR claimed_at < ?)`,
  ).bind(new Date().toISOString(), responseId, new Date().toISOString(), hash, new Date().toISOString(), staleBefore).run();
  if ((claimed.meta.changes ?? 0) !== 1) return page("Already submitted", "<p>This response is already being processed or has reopened the issue.</p>", 409);

  let screenshotKey: string | null = null;
  let screenshotUrl: string | null = null;
  try {
    if (screenshot instanceof File && screenshot.size > 0) {
      const extension = screenshot.type === "image/jpeg" ? "jpg" : screenshot.type.split("/")[1];
      screenshotKey = `responses/${row.site_id}/${responseId}.${extension}`;
      await context.env.ASSETS.put(screenshotKey, await screenshot.arrayBuffer(), {
        httpMetadata: { contentType: screenshot.type },
      });
      screenshotUrl = `${context.env.PUBLIC_ASSET_BASE_URL.replace(/\/$/, "")}/${screenshotKey}`;
    }
    const commentBody = [
      "The reporter says this is not fixed.",
      responseText ? `\n${responseText}` : "\nNo additional note was provided.",
      screenshotUrl ? `\n![Reporter follow-up screenshot](${screenshotUrl})` : "",
      `\n<!-- noxspot-response:${responseId} -->`,
    ].join("");
    await context.env.NOXCONNECT.execute(capability(row, responseId, "comment", {
      repository: row.repo, issueNumber: row.issue_number, body: commentBody,
    }));
    await context.env.NOXCONNECT.execute(capability(row, responseId, "reopen", {
      repository: row.repo, issueNumber: row.issue_number, issue: { state: "open" },
    }));
    const now = new Date().toISOString();
    await context.env.DB.batch([
      context.env.DB.prepare(
        `UPDATE spot_report_response_tokens
            SET used_at = ?, response_text = ?, screenshot_url = ?, last_error = NULL, updated_at = ?
          WHERE token_hash = ? AND response_id = ?`,
      ).bind(now, responseText || null, screenshotUrl, now, hash, responseId),
      ...(row.report_id ? [context.env.DB.prepare(
        `UPDATE spot_reports
            SET status = 'open', resolved_at = NULL, resolved_by = NULL, resolution_source = NULL,
                notification_status = 'not_requested', notification_message_id = NULL,
                notification_last_error = NULL, updated_at = ?
          WHERE id = ?`,
      ).bind(now, row.report_id)] : []),
      ...(row.report_id ? [context.env.DB.prepare(
        `INSERT INTO spot_report_activity (id, report_id, kind, actor, summary, created_at)
         VALUES (?, ?, 'reopened', 'reporter', ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      ).bind(`reporter-response:${responseId}`, row.report_id, responseText || "Reporter says this is not fixed.", now)] : []),
    ]);
    return page("Issue reopened", "<h1>Thanks for the update</h1><p>The issue has been reopened and the Playnist team will take another look.</p>", 200);
  } catch (error) {
    if (screenshotKey) await context.env.ASSETS.delete(screenshotKey).catch(() => undefined);
    const detail = error instanceof Error ? error.message.slice(0, 500) : "Response processing failed";
    await context.env.DB.prepare(
      `UPDATE spot_report_response_tokens
          SET claimed_at = NULL, response_id = NULL, last_error = ?, updated_at = ?
        WHERE token_hash = ? AND response_id = ?`,
    ).bind(detail, new Date().toISOString(), hash, responseId).run();
    console.error(JSON.stringify({ event: "noxspot.response.failed", issueNumber: row.issue_number, error: detail }));
    return page("Could not reopen issue", "<p>Please try again in a moment.</p>", 503);
  }
}

function capability(row: TokenRow, responseId: string, step: "comment" | "reopen", input: unknown) {
  return {
    contract: "noxconnect.connection-capability",
    version: 1,
    commandId: `spot-response-${step}-${responseId}`,
    idempotencyKey: `spot-response-${step}-${responseId}`,
    service: "noxspot",
    organizationId: Number(row.org_id),
    projectId: row.project_id,
    capability: step === "comment" ? "github.issue.comment" : "github.issue.update",
    input,
  };
}

async function activeToken(db: D1Database, token: string): Promise<TokenRow | null> {
  if (!TOKEN_PATTERN.test(token)) return null;
  const row = await db.prepare(
    `SELECT token_hash, report_id, org_id, project_id, site_id, repo, issue_number,
            report_title, reporter_name, expires_at, claimed_at, used_at
       FROM spot_report_response_tokens WHERE token_hash = ? LIMIT 1`,
  ).bind(await sha256(token)).first<TokenRow>();
  return isAvailable(row) ? row : null;
}

function isAvailable(row: TokenRow | null): row is TokenRow {
  return Boolean(row && !row.used_at && Date.parse(row.expires_at) > Date.now());
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function unavailableBody() {
  return "<p>This response link has expired or has already been used.</p>";
}

function page(title: string, body: string, status: number): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · NoxSpot</title><style>body{margin:0;background:#f7f6f3;color:#292524;font:16px/1.5 system-ui,sans-serif}.card{box-sizing:border-box;max-width:600px;margin:7vh auto;padding:32px;border:1px solid #e7e5e4;border-radius:18px;background:#fff;box-shadow:0 16px 45px #29252412}h1{font-size:28px;line-height:1.2;margin:8px 0 12px}.eyebrow{color:#78716c;font-size:14px;margin:0}.intro{color:#57534e}label{display:block;font-weight:650;margin:24px 0 8px}label span{color:#a8a29e;font-weight:400}textarea,input{box-sizing:border-box;width:100%;border:1px solid #d6d3d1;border-radius:10px;padding:12px;font:inherit}button{margin-top:24px;width:100%;border:0;border-radius:10px;background:#1c1917;color:#fff;padding:13px 18px;font:inherit;font-weight:700;cursor:pointer}@media(max-width:640px){.card{margin:0;min-height:100vh;border:0;border-radius:0;padding:24px}}</style></head><body><main class="card">${body}</main></body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" } });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}
