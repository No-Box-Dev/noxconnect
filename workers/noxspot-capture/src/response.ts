const CONTRACT = "noxspot.response";
const VERSION = 1;
const MAX_GITHUB_BODY_LENGTH = 64_000;
const MAX_SECTION_TEXT_LENGTH = 2_900;

export interface CaptureInput extends Record<string, unknown> {
  captureId: string;
  siteId: string;
  title: string;
  siteName?: string | null;
  issueType?: string | null;
  description?: string | null;
  reporter?: string | null;
  reporterEmail?: string | null;
  reporterGithubLogin?: string | null;
  environment?: string | null;
  screenshotUrl?: string | null;
  rating?: number | null;
  blockValues?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  elements?: Record<string, unknown>[] | null;
  context?: Record<string, unknown> | null;
}

export interface IssueInput extends Record<string, unknown> {
  title?: string;
  url?: string | null;
  number?: number | null;
  submittedBy?: string | null;
  resolution?: {
    kind?: string;
    url?: string | null;
    number?: number | null;
    summary?: string | null;
    title?: string | null;
  } | null;
}

const LABELS = Object.freeze({
  noxspot: Object.freeze({ name: "noxspot", color: "FE795D", description: "Captured with NoxSpot" }),
  bug: Object.freeze({ name: "bug", color: "D73A4A", description: "Something is not working" }),
  feature: Object.freeze({ name: "enhancement", color: "A2EEEF", description: "New feature or request" }),
  feedback: Object.freeze({ name: "feedback", color: "7057FF", description: "Product feedback" }),
  error: Object.freeze({ name: "error", color: "B60205", description: "Automatically captured browser error" }),
});

export function buildIssueResponse(capture: CaptureInput) {
  requireCapture(capture);
  const marker = `<!-- noxspot:${capture.captureId} -->`;
  const typeLabel = LABELS[capture.issueType as keyof typeof LABELS] ?? LABELS.bug;
  return {
    contract: CONTRACT,
    version: VERSION,
    idempotencyMarker: marker,
    issue: {
      title: capture.title,
      body: buildIssueBody(capture, marker),
      labels: [LABELS.noxspot, typeLabel].map((label) => ({ ...label })),
    },
  };
}

export function buildSlackResponse(capture: CaptureInput, issue: IssueInput) {
  requireCapture(capture);
  const issueUrl = safeHttpUrl(issue?.url);
  if (!issueUrl) throw new Error("NoxSpot response requires a valid GitHub issue URL");
  const pageUrl = safeHttpUrl(capture?.metadata?.url, 3_000);
  const fields = [
    { type: "mrkdwn", text: `*Type*\n${escapeMrkdwn(capture.issueType)}` },
    { type: "mrkdwn", text: `*Site*\n${escapeMrkdwn(capture.siteName || capture.siteId)}` },
  ];
  if (pageUrl) fields.push({ type: "mrkdwn", text: `*Page*\n${escapeMrkdwn(truncate(pageUrl, 1_000))}` });
  if (capture.reporterGithubLogin) fields.push({ type: "mrkdwn", text: `*Reporter*\n@${escapeMrkdwn(capture.reporterGithubLogin)}` });
  else if (capture.reporter) fields.push({ type: "mrkdwn", text: `*Reporter*\n${escapeMrkdwn(capture.reporter)}` });

  const blocks: Record<string, unknown>[] = [
    { type: "header", text: { type: "plain_text", text: truncate(capture.title, 150), emoji: true } },
    { type: "section", fields },
  ];
  if (capture.description) blocks.push({ type: "section", text: { type: "mrkdwn", text: truncate(escapeMrkdwn(capture.description), 2_800) } });
  if (capture.screenshotUrl) blocks.push({ type: "image", image_url: capture.screenshotUrl, alt_text: "NoxSpot issue screenshot" });
  const actions: Record<string, unknown>[] = [];
  if (pageUrl) actions.push({ type: "button", text: { type: "plain_text", text: "Open reported page" }, url: pageUrl });
  actions.push({ type: "button", text: { type: "plain_text", text: "Open GitHub issue" }, url: issueUrl });
  blocks.push({ type: "actions", elements: actions });
  return {
    contract: CONTRACT,
    version: VERSION,
    message: { text: `New NoxSpot issue: ${capture.title}`, client_msg_id: capture.captureId, blocks },
  };
}

export function buildTestResponse(orgLogin: string) {
  if (typeof orgLogin !== "string" || !orgLogin.trim() || orgLogin.length > 200) throw new Error("Invalid NoxSpot org login");
  return {
    contract: CONTRACT,
    version: VERSION,
    message: {
      text: `NoxSpot delivery test for ${orgLogin}`,
      blocks: [
        { type: "header", text: { type: "plain_text", text: "NoxSpot delivery test", emoji: true } },
        { type: "section", text: { type: "mrkdwn", text: `Site feedback delivery is healthy for *${escapeMrkdwn(orgLogin)}*.` } },
      ],
    },
  };
}

export function buildDailyDigestResponse(
  siteName: string,
  period: string,
  filed: IssueInput[],
  solved: IssueInput[],
  totals: Record<string, unknown> = {},
) {
  if (typeof siteName !== "string" || !siteName.trim() || siteName.length > 200) throw new Error("Invalid NoxSpot site name");
  if (typeof period !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(period)) throw new Error("Invalid NoxSpot digest period");
  if (!Array.isArray(filed) || !Array.isArray(solved)) throw new Error("Invalid NoxSpot digest issues");
  const filedTotal = validCount(totals.filed, filed.length);
  const solvedTotal = validCount(totals.solved, solved.length);
  const blocks: Record<string, unknown>[] = [
    { type: "header", text: { type: "plain_text", text: truncate(`NoxSpot daily summary — ${siteName}`, 150), emoji: true } },
    { type: "context", elements: [{ type: "mrkdwn", text: `*${period}*  •  ${filedTotal} filed  •  ${solvedTotal} solved` }] },
  ];
  addDigestGroup(blocks, "Filed", filed, filedTotal, formatFiledIssue);
  addDigestGroup(blocks, "Solved", solved, solvedTotal, formatSolvedIssue);
  if (!filedTotal && !solvedTotal) blocks.push({ type: "section", text: { type: "mrkdwn", text: "No NoxSpot issues were filed or solved this day." } });
  return {
    contract: CONTRACT,
    version: VERSION,
    message: { text: `${siteName} NoxSpot summary for ${period}: ${filedTotal} filed, ${solvedTotal} solved`, blocks },
  };
}

function addDigestGroup(blocks: Record<string, unknown>[], label: string, issues: IssueInput[], total: number, formatter: (issue: IssueInput) => string) {
  if (!total) return;
  blocks.push({ type: "section", text: { type: "mrkdwn", text: `*${label} (${total})*` } });
  let section = "";
  for (const issue of issues) {
    const item = formatter(issue);
    const next = section ? `${section}\n\n${item}` : item;
    if (next.length <= MAX_SECTION_TEXT_LENGTH) section = next;
    else {
      if (section) blocks.push({ type: "section", text: { type: "mrkdwn", text: section } });
      section = item;
    }
  }
  if (section) blocks.push({ type: "section", text: { type: "mrkdwn", text: section } });
}

function formatFiledIssue(issue: IssueInput) {
  requireDigestIssue(issue);
  const reporter = issue.submittedBy ? `Filed by ${escapeMrkdwn(issue.submittedBy)}.` : "Filed this day.";
  return `${issueLink(issue)}\n${reporter} It is open.`;
}

function formatSolvedIssue(issue: IssueInput) {
  requireDigestIssue(issue);
  const resolution = issue.resolution;
  if (resolution?.kind === "pull_request") {
    const prUrl = safeHttpUrl(resolution.url);
    const prNumber = Number(resolution.number);
    const prLabel = Number.isInteger(prNumber) && prNumber > 0 ? `PR #${prNumber}` : "a pull request";
    const linkedPr = prUrl ? `<${prUrl}|${prLabel}>` : prLabel;
    const detail = cleanSentence(resolution.summary || resolution.title);
    return `${issueLink(issue)}\nSolved in ${linkedPr}.${detail ? ` ${escapeMrkdwn(detail)}` : ""}`;
  }
  return `${issueLink(issue)}\nThis issue was closed. No linked fix was found.`;
}

function issueLink(issue: IssueInput) {
  const number = Number(issue.number);
  const label = `${truncate(issue.title, 180)}${Number.isInteger(number) && number > 0 ? ` (#${number})` : ""}`;
  const url = safeHttpUrl(issue.url);
  return url ? `*<${url}|${escapeMrkdwn(label)}>*` : `*${escapeMrkdwn(label)}*`;
}

function buildIssueBody(capture: CaptureInput, marker: string) {
  const lines: string[] = [];
  if (capture.description) lines.push(capture.description, "");
  if (capture.screenshotUrl) lines.push(`![NoxSpot capture](${capture.screenshotUrl})`, "");
  lines.push("### Capture", "", `- **Site:** ${capture.siteName || capture.siteId}`);
  if (capture.environment) lines.push(`- **Environment:** ${capture.environment}`);
  if (capture.reporterGithubLogin) lines.push(`- **Reporter:** @${capture.reporterGithubLogin}`);
  else if (capture.reporter) lines.push(`- **Reporter:** ${capture.reporter}`);
  if (capture.notifyOnResolution && capture.reporterEmail) lines.push("- **Resolution updates:** Requested (contact kept private in NoxConnect)");
  if (capture.rating) lines.push(`- **Rating:** ${capture.rating}/5`);
  addJson(lines, "Custom fields", capture.blockValues);
  addJson(lines, "Browser context", capture.metadata);
  addJson(lines, "Selected elements", capture.elements);
  addJson(lines, "Application context", capture.context);
  const content = lines.join("\n");
  const suffix = `\n\n${marker}`;
  return `${content.slice(0, MAX_GITHUB_BODY_LENGTH - suffix.length)}${suffix}`;
}

function addJson(lines: string[], label: string, value: unknown) {
  if (!value) return;
  const json = JSON.stringify(value, null, 2);
  if (!json || json === "{}" || json === "[]") return;
  lines.push("", `<details><summary>${label}</summary>`, "", "```json", json.slice(0, 16_000), "```", "</details>");
}

function requireCapture(capture: CaptureInput) {
  for (const field of ["captureId", "siteId", "title"]) {
    if (!capture?.[field] || typeof capture[field] !== "string") throw new Error(`Invalid NoxSpot capture: missing ${field}`);
  }
}

function requireDigestIssue(issue: IssueInput) {
  if (!issue || typeof issue !== "object" || typeof issue.title !== "string" || !issue.title.trim()) throw new Error("Invalid NoxSpot digest issue");
}

function cleanSentence(value: unknown) {
  const text = truncate(String(value ?? "").trim().replace(/\s+/g, " "), 240);
  if (!text) return "";
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function validCount(value: unknown, fallback: number) {
  const count = Number(value);
  return Number.isInteger(count) && count >= fallback ? count : fallback;
}

function safeHttpUrl(value: unknown, maxLength = 3_000) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.toString().slice(0, maxLength);
  } catch { return null; }
}

function escapeMrkdwn(value: unknown) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function truncate(value: unknown, max: number) {
  const text = String(value ?? "");
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
