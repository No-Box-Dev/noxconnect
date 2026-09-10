import {
  parseConnectionCapabilityCommand,
  parseConnectionCapabilityReceipt,
  type ConnectionCapabilityCommand,
  type ConnectionCapabilityReceipt,
} from "./connection-capabilities";
import { isAppEnabled } from "./apps.js";
import { stageSlackDelivery, queueOutboxDelivery } from "./delivery-outbox.js";
import { getInstallationIdForOrg, getInstallationToken } from "./github-app.js";
import {
  createRepositoryIssue,
  createRepositoryIssueComment,
  ensureRepositoryLabels,
  findIssueByBodyMarker,
  updateRepositoryIssue,
} from "./github-issues.js";
import { upsertIssue } from "./github-sync.js";
import { complete } from "./llm.js";
import { resolveLlmConfig } from "./llm-config.js";
import { resolveProjectSlackDestination, type ProjectRouteKey } from "./project-routing";
import { resolveSlackChannels, resolveSlackConnectionId, resolveSlackRoute } from "./slack.js";

interface CapabilityEnvironment {
  DB: D1Database;
  TASK_QUEUE: Queue;
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  ENCRYPTION_KEY?: string;
}

interface ProjectScope {
  id: string;
  name: string;
  repo: string;
  ownerId: string;
}

interface RunRow {
  id: string;
  capability: string;
  command_hash: string;
  status: string;
  receipt_json: string | null;
  lease_expires_at: string | null;
}

const PROJECT_ROUTE_KEYS = new Set<ProjectRouteKey>([
  "noxfeed_posts",
  "noxfeed_release_notes",
  "noxcue",
  "noxcue_alerts",
]);

export class CapabilityBusyError extends Error {
  constructor() {
    super("An equivalent connection capability command is already processing");
    this.name = "CapabilityBusyError";
  }
}

export async function executeConnectionCapability(
  env: CapabilityEnvironment,
  rawCommand: unknown,
): Promise<ConnectionCapabilityReceipt> {
  const command = parseConnectionCapabilityCommand(rawCommand);
  const project = await requireProjectScope(env.DB, command.organizationId, command.projectId);
  if (!(await isAppEnabled(env.DB, command.organizationId, command.service))) {
    throw new Error(`${command.service} is not enabled for this organization`);
  }
  if (
    (command.capability === "github.issue.create" ||
      command.capability === "github.issue.update" ||
      command.capability === "github.issue.comment") &&
    command.input.repository !== project.repo
  ) {
    throw new Error("The requested repository is outside the command project scope");
  }

  const commandHash = await sha256(JSON.stringify(command));
  const existing = await claimRun(env.DB, command, commandHash);
  if (existing) return existing;

  try {
    let receipt: ConnectionCapabilityReceipt;
    switch (command.capability) {
      case "github.issue.create":
      case "github.issue.update":
      case "github.issue.comment":
        receipt = await executeGitHub(env, command, project);
        break;
      case "slack.message.deliver":
        receipt = await executeSlack(env, command, project);
        break;
      case "ai.complete":
        receipt = await executeAi(env, command);
        break;
    }
    await finishRun(env.DB, command.commandId, receipt);
    return receipt;
  } catch (error) {
    await failRun(env.DB, command.commandId, error);
    throw error;
  }
}

async function executeGitHub(
  env: CapabilityEnvironment,
  command: Extract<ConnectionCapabilityCommand, { capability: `github.${string}` }>,
  project: ProjectScope,
): Promise<ConnectionCapabilityReceipt> {
  const installationId = await getInstallationIdForOrg(env.DB, command.organizationId);
  if (!installationId) throw new Error("GitHub App is not installed for this organization");
  const token = await getInstallationToken(env, installationId);
  let issue;
  let created = false;

  if (command.capability === "github.issue.create") {
    issue = await findIssueByBodyMarker(token, project.ownerId, project.repo, command.input.idempotencyMarker);
    if (!issue) {
      await ensureRepositoryLabels(token, project.ownerId, project.repo, command.input.issue.labels);
      const body = command.input.issue.body.includes(command.input.idempotencyMarker)
        ? command.input.issue.body
        : `${command.input.issue.body}\n\n${command.input.idempotencyMarker}`;
      issue = await createRepositoryIssue(token, project.ownerId, project.repo, {
        ...command.input.issue,
        body,
        labels: command.input.issue.labels.map((label) => label.name),
      });
      created = true;
    }
  } else if (command.capability === "github.issue.update") {
    const patch = {
      ...command.input.issue,
      ...(command.input.issue.labels
        ? { labels: command.input.issue.labels.map((label) => label.name) }
        : {}),
    };
    if (command.input.issue.labels) {
      await ensureRepositoryLabels(token, project.ownerId, project.repo, command.input.issue.labels);
    }
    issue = await updateRepositoryIssue(
      token,
      project.ownerId,
      project.repo,
      command.input.issueNumber,
      patch,
    );
  } else {
    await createRepositoryIssueComment(
      token,
      project.ownerId,
      project.repo,
      command.input.issueNumber,
      command.input.body,
    );
    issue = {
      number: command.input.issueNumber,
      html_url: `https://github.com/${project.ownerId}/${project.repo}/issues/${command.input.issueNumber}`,
      state: null,
    };
  }

  if (command.capability !== "github.issue.comment") {
    await upsertIssue(env.DB, command.organizationId, project.repo, issue);
  }
  return receipt(command, "github", {
    issueNumber: Number(issue.number),
    url: typeof issue.html_url === "string" ? issue.html_url : null,
    state: typeof issue.state === "string" ? issue.state : null,
    created,
  }, "completed");
}

async function executeSlack(
  env: CapabilityEnvironment,
  command: Extract<ConnectionCapabilityCommand, { capability: "slack.message.deliver" }>,
  project: ProjectScope,
): Promise<ConnectionCapabilityReceipt> {
  const route = command.input.route;
  const projectDestination = PROJECT_ROUTE_KEYS.has(route as ProjectRouteKey)
    ? await resolveProjectSlackDestination(
        env.DB,
        command.organizationId,
        route as ProjectRouteKey,
        { projectId: project.id },
      )
    : null;
  const channels = projectDestination ? null : await resolveSlackChannels(env.DB, command.organizationId);
  const channelId = projectDestination?.channelId ?? resolveSlackRoute(channels, route);
  const connectionId = projectDestination?.connectionId ?? resolveSlackConnectionId(channels, route);
  if (!channelId) throw new Error(`No Slack destination is configured for ${route}`);

  const staged = await stageSlackDelivery(env.DB, {
    orgId: command.organizationId,
    source: command.service,
    sourceId: command.idempotencyKey,
    siteId: null,
    connectionId,
    channelId,
    payload: {
      message: {
        ...command.input.message,
        client_msg_id: command.input.message.client_msg_id ?? command.commandId,
      },
    },
  });
  if (!staged?.id) throw new Error("Slack delivery could not be staged");
  const queued = staged.status === "delivered"
    ? false
    : await queueOutboxDelivery(env, staged.id, project.ownerId);
  return receipt(command, "slack", { deliveryId: staged.id, queued }, "queued");
}

async function executeAi(
  env: CapabilityEnvironment,
  command: Extract<ConnectionCapabilityCommand, { capability: "ai.complete" }>,
): Promise<ConnectionCapabilityReceipt> {
  const config = await resolveLlmConfig(env, command.organizationId);
  if (config.status !== "ready") throw new Error(`Managed AI is unavailable (${config.errorCode ?? config.status})`);
  const text = await complete(config, {
    system: command.input.system,
    user: command.input.user,
    maxTokens: command.input.maxTokens,
    tag: `${command.service}:${command.input.purpose}`,
  });
  if (text && command.input.responseFormat === "json") JSON.parse(text);
  return receipt(command, "ai", { text, model: "model" in config ? config.model ?? null : null }, "completed");
}

function receipt(
  command: ConnectionCapabilityCommand,
  provider: "github" | "slack" | "ai",
  result: unknown,
  status: "completed" | "queued",
): ConnectionCapabilityReceipt {
  return parseConnectionCapabilityReceipt({
    contract: "noxconnect.connection-receipt",
    version: 1,
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey,
    capability: command.capability,
    provider,
    status,
    result,
  });
}

async function requireProjectScope(db: D1Database, orgId: number, projectId: string): Promise<ProjectScope> {
  const row = await db.prepare(
    `SELECT project.id, project.name, project.repo, project.owner_id
       FROM projects project
       JOIN orgs org ON org.github_login = project.owner_id
      WHERE org.id = ? AND project.id = ? AND COALESCE(project.archived, 0) = 0
      LIMIT 1`,
  ).bind(orgId, projectId).first<{ id: string; name: string; repo: string; owner_id: string }>();
  if (!row) throw new Error("Project is outside the command organization scope or is archived");
  return { id: row.id, name: row.name, repo: row.repo, ownerId: row.owner_id };
}

async function claimRun(
  db: D1Database,
  command: ConnectionCapabilityCommand,
  commandHash: string,
): Promise<ConnectionCapabilityReceipt | null> {
  const lease = new Date(Date.now() + 15 * 60_000).toISOString();
  await db.prepare(
    `INSERT INTO connection_capability_runs
       (id, org_id, project_id, service, capability, idempotency_key, command_hash, status, lease_expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'processing', ?)
     ON CONFLICT(org_id, service, idempotency_key) DO NOTHING`,
  ).bind(
    command.commandId,
    command.organizationId,
    command.projectId,
    command.service,
    command.capability,
    command.idempotencyKey,
    commandHash,
    lease,
  ).run();
  const row = await db.prepare(
    `SELECT id, capability, command_hash, status, receipt_json, lease_expires_at
       FROM connection_capability_runs
      WHERE org_id = ? AND service = ? AND idempotency_key = ?`,
  ).bind(command.organizationId, command.service, command.idempotencyKey).first<RunRow>();
  if (!row) throw new Error("Connection capability command could not be claimed");
  if (row.command_hash !== commandHash || row.capability !== command.capability) {
    throw new Error("Idempotency key was already used for a different command");
  }
  if (row.receipt_json && ["completed", "queued", "blocked"].includes(row.status)) {
    return parseConnectionCapabilityReceipt(JSON.parse(row.receipt_json));
  }
  if (row.id !== command.commandId && row.status === "processing" && Date.parse(row.lease_expires_at ?? "") > Date.now()) {
    throw new CapabilityBusyError();
  }
  if (row.id !== command.commandId || row.status === "failed") {
    const reclaimed = await db.prepare(
      `UPDATE connection_capability_runs
          SET id = ?, status = 'processing', lease_expires_at = ?, last_error = NULL,
              updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
        WHERE org_id = ? AND service = ? AND idempotency_key = ?
          AND (status = 'failed' OR lease_expires_at <= strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
    ).bind(command.commandId, lease, command.organizationId, command.service, command.idempotencyKey).run();
    if (!reclaimed.meta.changes) throw new CapabilityBusyError();
  }
  return null;
}

async function finishRun(db: D1Database, commandId: string, value: ConnectionCapabilityReceipt): Promise<void> {
  await db.prepare(
    `UPDATE connection_capability_runs
        SET status = ?, receipt_json = ?, lease_expires_at = NULL, last_error = NULL,
            updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      WHERE id = ?`,
  ).bind(value.status, JSON.stringify(value), commandId).run();
}

async function failRun(db: D1Database, commandId: string, error: unknown): Promise<void> {
  await db.prepare(
    `UPDATE connection_capability_runs
        SET status = 'failed', lease_expires_at = NULL, last_error = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      WHERE id = ?`,
  ).bind(error instanceof Error ? error.message.slice(0, 1_000) : String(error).slice(0, 1_000), commandId).run();
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
