import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  findForbiddenCredentialPaths,
  parseConnectionCapabilityCommand,
  parseConnectionCapabilityReceipt,
} from "../connection-capabilities";

const provider = vi.hoisted(() => ({
  createIssue: vi.fn(),
  findIssue: vi.fn(),
  updateIssue: vi.fn(),
  comment: vi.fn(),
  labels: vi.fn(),
  installationId: vi.fn(),
  installationToken: vi.fn(),
  upsertIssue: vi.fn(),
  enabled: vi.fn(),
  stageSlack: vi.fn(),
  queueSlack: vi.fn(),
  projectRoute: vi.fn(),
  slackChannels: vi.fn(),
  complete: vi.fn(),
  llmConfig: vi.fn(),
}));

vi.mock("../apps.js", () => ({ isAppEnabled: provider.enabled }));
vi.mock("../github-app.js", () => ({
  getInstallationIdForOrg: provider.installationId,
  getInstallationToken: provider.installationToken,
}));
vi.mock("../github-issues.js", () => ({
  createRepositoryIssue: provider.createIssue,
  createRepositoryIssueComment: provider.comment,
  ensureRepositoryLabels: provider.labels,
  findIssueByBodyMarker: provider.findIssue,
  updateRepositoryIssue: provider.updateIssue,
}));
vi.mock("../github-sync.js", () => ({ upsertIssue: provider.upsertIssue }));
vi.mock("../delivery-outbox.js", () => ({
  stageSlackDelivery: provider.stageSlack,
  queueOutboxDelivery: provider.queueSlack,
}));
vi.mock("../project-routing", () => ({ resolveProjectSlackDestination: provider.projectRoute }));
vi.mock("../slack.js", () => ({
  resolveSlackChannels: provider.slackChannels,
  resolveSlackConnectionId: () => "connection-1",
  resolveSlackRoute: () => "channel-1",
}));
vi.mock("../llm.js", () => ({ complete: provider.complete }));
vi.mock("../llm-config.js", () => ({ resolveLlmConfig: provider.llmConfig }));

import { executeConnectionCapability } from "../connection-capability-executor";

const BASE = {
  contract: "noxconnect.connection-capability" as const,
  version: 1 as const,
  commandId: "command-1",
  idempotencyKey: "incident:production:checkout",
  service: "noxcue" as const,
  organizationId: 7,
  projectId: "project-1",
};

class CapabilityDb {
  run: Record<string, unknown> | null = null;

  prepare(sql: string) {
    const values: unknown[] = [];
    const statement = {
      bind: (...input: unknown[]) => {
        values.push(...input);
        return statement;
      },
      first: async () => {
        if (sql.includes("FROM projects project")) {
          return { id: "project-1", name: "Checkout", repo: "checkout", owner_id: "acme" };
        }
        if (sql.includes("FROM connection_capability_runs")) return this.run;
        return null;
      },
      run: async () => {
        if (sql.includes("INSERT INTO connection_capability_runs") && !this.run) {
          this.run = {
            id: values[0],
            capability: values[4],
            command_hash: values[6],
            status: "processing",
            receipt_json: null,
            lease_expires_at: values[7],
          };
          return { meta: { changes: 1 } };
        }
        if (sql.includes("SET status = ?") && this.run) {
          this.run.status = values[0];
          this.run.receipt_json = values[1];
          return { meta: { changes: 1 } };
        }
        if (sql.includes("SET status = 'failed'") && this.run) {
          this.run.status = "failed";
          return { meta: { changes: 1 } };
        }
        return { meta: { changes: 1 } };
      },
    };
    return statement;
  }
}

function githubCreate(overrides: Record<string, unknown> = {}) {
  return {
    ...BASE,
    ...overrides,
    capability: "github.issue.create" as const,
    input: {
      repository: "checkout",
      idempotencyMarker: "<!-- noxcue:checkout -->",
      issue: {
        title: "Checkout is failing",
        body: "Observed failures",
        labels: [{ name: "noxcue", color: "6f42c1" }],
      },
    },
  };
}

describe("connection capability contracts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    provider.enabled.mockResolvedValue(true);
    provider.installationId.mockResolvedValue(99);
    provider.installationToken.mockResolvedValue("provider-secret-token");
    provider.findIssue.mockResolvedValue(null);
    provider.createIssue.mockResolvedValue({
      number: 42,
      html_url: "https://github.com/acme/checkout/issues/42",
      state: "open",
    });
    provider.stageSlack.mockResolvedValue({ id: "delivery-1", status: "pending" });
    provider.queueSlack.mockResolvedValue(true);
    provider.projectRoute.mockResolvedValue(null);
    provider.slackChannels.mockResolvedValue({});
    provider.llmConfig.mockResolvedValue({ status: "ready", model: "managed-model" });
    provider.complete.mockResolvedValue("Summary");
  });

  it("accepts a bounded project-scoped command", () => {
    expect(parseConnectionCapabilityCommand(githubCreate()).capability).toBe("github.issue.create");
  });

  it("rejects credential-shaped fields at any depth", () => {
    const unsafe = { ...githubCreate(), input: { ...githubCreate().input, authorization: "Bearer leaked" } };
    expect(findForbiddenCredentialPaths(unsafe)).toEqual(["$.input.authorization"]);
    expect(() => parseConnectionCapabilityCommand(unsafe)).toThrow("cannot contain credentials");
  });

  it("rejects credentials in receipts", () => {
    expect(() => parseConnectionCapabilityReceipt({
      contract: "noxconnect.connection-receipt",
      version: 1,
      commandId: "command-1",
      idempotencyKey: "key-1",
      capability: "ai.complete",
      provider: "ai",
      status: "completed",
      result: { text: "ok", model: "m", apiKey: "leaked" },
    })).toThrow("cannot contain credentials");
  });

  it("executes GitHub with the internal token but never returns it", async () => {
    const DB = new CapabilityDb();
    const result = await executeConnectionCapability({ DB: DB as unknown as D1Database, TASK_QUEUE: {} as Queue }, githubCreate());
    expect(provider.installationToken).toHaveBeenCalledOnce();
    expect(provider.createIssue).toHaveBeenCalledWith(
      "provider-secret-token",
      "acme",
      "checkout",
      expect.objectContaining({ body: expect.stringContaining("<!-- noxcue:checkout -->") }),
    );
    expect(JSON.stringify(result)).not.toContain("provider-secret-token");
    expect(result).toMatchObject({ provider: "github", status: "completed", result: { issueNumber: 42, created: true } });
  });

  it("returns the stored receipt for an identical retry", async () => {
    const DB = new CapabilityDb();
    const env = { DB: DB as unknown as D1Database, TASK_QUEUE: {} as Queue };
    const first = await executeConnectionCapability(env, githubCreate());
    const second = await executeConnectionCapability(env, githubCreate());
    expect(second).toEqual(first);
    expect(provider.createIssue).toHaveBeenCalledOnce();
  });

  it("denies a repository outside the project before resolving credentials", async () => {
    const DB = new CapabilityDb();
    const command = githubCreate();
    command.input.repository = "another-project";
    await expect(executeConnectionCapability(
      { DB: DB as unknown as D1Database, TASK_QUEUE: {} as Queue },
      command,
    )).rejects.toThrow("outside the command project scope");
    expect(provider.installationToken).not.toHaveBeenCalled();
  });

  it("stages Slack through NoxConnect routing and returns a bounded receipt", async () => {
    const DB = new CapabilityDb();
    const result = await executeConnectionCapability(
      { DB: DB as unknown as D1Database, TASK_QUEUE: {} as Queue },
      {
        ...BASE,
        service: "noxfeed",
        commandId: "slack-command",
        idempotencyKey: "release:42",
        capability: "slack.message.deliver",
        input: { route: "noxfeed_release_notes", message: { text: "Released", blocks: [] } },
      },
    );
    expect(provider.stageSlack).toHaveBeenCalledWith(DB, expect.objectContaining({ channelId: "channel-1" }));
    expect(result).toMatchObject({ provider: "slack", status: "queued", result: { deliveryId: "delivery-1", queued: true } });
  });

  it("executes managed AI without accepting a service credential", async () => {
    const DB = new CapabilityDb();
    const result = await executeConnectionCapability(
      { DB: DB as unknown as D1Database, TASK_QUEUE: {} as Queue },
      {
        ...BASE,
        service: "noxfeed",
        commandId: "ai-command",
        idempotencyKey: "narrative:42",
        capability: "ai.complete",
        input: { purpose: "release-note", system: "Summarize", user: "PR 42", maxTokens: 500, responseFormat: "text" },
      },
    );
    expect(provider.complete).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ provider: "ai", result: { text: "Summary", model: "managed-model" } });
  });
});
