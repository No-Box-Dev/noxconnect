import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the cross-package helpers the queue consumer dispatches to.
vi.mock("../reconcile.js", () => ({ reconcileOrg: vi.fn() }));
vi.mock("../../../functions/lib/narrator.js", () => ({ narrateEvent: vi.fn() }));
vi.mock("../../../functions/lib/github-sync.js", () => ({
  bootstrapInstallation: vi.fn(),
  syncRepo: vi.fn(),
}));
vi.mock("../../../functions/lib/github-app.js", () => ({
  getInstallationToken: vi.fn().mockResolvedValue("install-token"),
}));
vi.mock("../../../functions/lib/op-failures.js", () => ({ recordFailure: vi.fn() }));
vi.mock("../../../functions/lib/noxspot.js", () => ({
  createNoxSpotGitHubIssue: vi.fn(),
}));
vi.mock("../../../functions/lib/noxspot-resolution.js", () => ({
  deliverNoxSpotResolutionEmail: vi.fn(),
  prepareNoxSpotResolutionEmail: vi.fn(),
  recoverNoxSpotResolutionPreparations: vi.fn(),
  recoverNoxSpotResolutionEmails: vi.fn(),
}));
vi.mock("../../../functions/lib/noxcue-github.js", () => ({
  createOrUpdateNoxCueGitHubIssue: vi.fn(), recoverNoxCueGithubIncidents: vi.fn(),
}));
vi.mock("../../../functions/lib/delivery-outbox.js", () => ({
  deliverSlackOutbox: vi.fn(), markOutboxFailed: vi.fn(), recoverOutboxDeliveries: vi.fn(), requeueBlockedForOrg: vi.fn(),
}));
vi.mock("../../../functions/lib/slack.js", () => ({ checkSlackOrgHealth: vi.fn() }));

import worker from "../index.js";
import { narrateEvent } from "../../../functions/lib/narrator.js";
import { syncRepo } from "../../../functions/lib/github-sync.js";
import { getInstallationToken } from "../../../functions/lib/github-app.js";
import { recordFailure } from "../../../functions/lib/op-failures.js";
import { createNoxSpotGitHubIssue } from "../../../functions/lib/noxspot.js";
import { prepareNoxSpotResolutionEmail } from "../../../functions/lib/noxspot-resolution.js";
import { createOrUpdateNoxCueGitHubIssue } from "../../../functions/lib/noxcue-github.js";
import { deliverSlackOutbox, markOutboxFailed } from "../../../functions/lib/delivery-outbox.js";

const env = { DB: {} };

function msg(body, attempts = 1) {
  return { body, attempts, ack: vi.fn(), retry: vi.fn() };
}

beforeEach(() => vi.clearAllMocks());

describe("cron queue consumer", () => {
  it("dispatches a narrate task and acks", async () => {
    const m = msg({ type: "narrate", eventId: 7 });
    await worker.queue({ messages: [m] }, env);
    expect(narrateEvent).toHaveBeenCalledWith(env, 7);
    expect(m.ack).toHaveBeenCalledOnce();
    expect(m.retry).not.toHaveBeenCalled();
  });

  it("resolves an install token before running sync_repo", async () => {
    const m = msg({ type: "sync_repo", orgId: 1, accountLogin: "acme", installationId: 100, repo: "api" });
    await worker.queue({ messages: [m] }, env);
    expect(getInstallationToken).toHaveBeenCalledWith(env, 100);
    expect(syncRepo).toHaveBeenCalledWith(env.DB, "install-token", 1, "acme", "api", true);
    expect(m.ack).toHaveBeenCalledOnce();
  });

  it("routes NoxSpot captures through NoxConnect's GitHub worker", async () => {
    const capture = { type: "spot_create_github_issue", captureId: "spot-1" };
    const m = msg(capture);
    await worker.queue({ messages: [m] }, env);
    expect(createNoxSpotGitHubIssue).toHaveBeenCalledWith(env, capture);
    expect(m.ack).toHaveBeenCalledOnce();
  });

  it("routes NoxSpot resolution preparation through the durable worker", async () => {
    const task = { type: "spot_prepare_resolution_email", reportId: "spot-1" };
    const m = msg(task);
    await worker.queue({ messages: [m] }, env);
    expect(prepareNoxSpotResolutionEmail).toHaveBeenCalledWith(env, "spot-1");
    expect(m.ack).toHaveBeenCalledOnce();
  });

  it("routes a durable NoxCue incident through the GitHub worker", async () => {
    const task = { type: "noxcue_github_issue", incidentId: "incident-1" };
    const m = msg(task);
    await worker.queue({ messages: [m] }, env);
    expect(createOrUpdateNoxCueGitHubIssue).toHaveBeenCalledWith(env, task);
    expect(m.ack).toHaveBeenCalledOnce();
  });

  it("routes Slack notifications through the durable outbox worker", async () => {
    const task = { type: "deliver_slack", outboxId: "delivery-1" };
    const m = msg(task);
    await worker.queue({ messages: [m] }, env);
    expect(deliverSlackOutbox).toHaveBeenCalledWith(env, "delivery-1");
    expect(m.ack).toHaveBeenCalledOnce();
  });

  it("retries (does not ack) a failing task before the delivery limit", async () => {
    narrateEvent.mockRejectedValueOnce(new Error("boom"));
    const m = msg({ type: "narrate", eventId: 1 }, 1);
    await worker.queue({ messages: [m] }, env);
    expect(m.retry).toHaveBeenCalledOnce();
    expect(m.ack).not.toHaveBeenCalled();
    expect(recordFailure).not.toHaveBeenCalled();
  });

  it("records to op_failures and acks once the delivery limit is reached", async () => {
    narrateEvent.mockRejectedValueOnce(new Error("boom"));
    // MAX_DELIVERIES = 5 (1 initial + max_retries 4); the 5th delivery is terminal.
    const m = msg({ type: "narrate", eventId: 1, ownerId: "acme", deliveryId: "d-1" }, 5);
    await worker.queue({ messages: [m] }, env);
    expect(recordFailure).toHaveBeenCalledWith(
      env.DB,
      expect.objectContaining({ ownerId: "acme", op: "task:narrate", deliveryId: "d-1" }),
    );
    expect(m.ack).toHaveBeenCalledOnce();
    expect(m.retry).not.toHaveBeenCalled();
  });

  it("marks an exhausted Slack outbox delivery as failed", async () => {
    deliverSlackOutbox.mockRejectedValueOnce(new Error("Slack unavailable"));
    const m = msg({ type: "deliver_slack", outboxId: "delivery-1", ownerId: "acme" }, 5);
    await worker.queue({ messages: [m] }, env);
    expect(markOutboxFailed).toHaveBeenCalledWith(env.DB, "delivery-1", expect.any(Error));
    expect(m.ack).toHaveBeenCalledOnce();
  });

  it("treats an unknown task type as a failure", async () => {
    const m = msg({ type: "nope" }, 1);
    await worker.queue({ messages: [m] }, env);
    expect(m.retry).toHaveBeenCalledOnce();
  });
});
