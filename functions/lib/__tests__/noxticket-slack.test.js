import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../delivery-outbox.js", () => ({
  stageSlackDelivery: vi.fn(async () => ({ id: "delivery-1", status: "pending" })),
  queueOutboxDelivery: vi.fn(async () => true),
}));
vi.mock("../inactive-repos.js", () => ({ getNoxTicketRepoName: vi.fn(async () => "noxconnect") }));
vi.mock("../apps.js", () => ({
  isAppEnabled: vi.fn(async () => true),
}));
vi.mock("../slack.js", () => ({
  resolveSlackChannels: vi.fn(async () => ({ fallbackChannelId: "C0", noxTicketChannelId: "CU" })),
  resolveSlackRoute: vi.fn((channels) => channels.noxTicketChannelId || channels.fallbackChannelId || ""),
  resolveSlackConnectionId: vi.fn((channels) => channels.noxTicketConnectionId || channels.fallbackConnectionId || ""),
}));

import { stageNoxTicketActivity } from "../noxticket-slack.js";
import { queueOutboxDelivery, stageSlackDelivery } from "../delivery-outbox.js";
import { isAppEnabled } from "../apps.js";

const DB = {
  prepare: () => ({ bind() { return this; }, first: async () => ({ project_id: "project-1" }) }),
};

describe("NoxTicket Slack routing", () => {
  beforeEach(() => vi.clearAllMocks());

  it("routes ticket lifecycle activity to the NoxTicket channel", async () => {
    await stageNoxTicketActivity(
      { DB, TASK_QUEUE: { send: vi.fn() } },
      { orgId: 7, ownerId: "acme", repo: "noxconnect", action: "opened", actor: "ada", issue: { number: 9, title: "Ship alerts", labels: [] } },
    );
    expect(stageSlackDelivery).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      source: "noxticket", sourceId: "noxconnect:9:opened", channelId: "CU",
    }));
    expect(queueOutboxDelivery).toHaveBeenCalledWith(expect.anything(), "delivery-1", "acme");
  });

  it("does not duplicate NoxSpot issues into NoxTicket", async () => {
    await stageNoxTicketActivity(
      { DB },
      { orgId: 7, ownerId: "acme", repo: "noxconnect", action: "opened", issue: { number: 9, labels: [{ name: "noxspot" }] } },
    );
    expect(stageSlackDelivery).not.toHaveBeenCalled();
  });

  it("does nothing while NoxTicket is off", async () => {
    vi.mocked(isAppEnabled).mockResolvedValueOnce(false);
    const result = await stageNoxTicketActivity(
      { DB, TASK_QUEUE: { send: vi.fn() } },
      { orgId: 7, ownerId: "acme", repo: "noxconnect", action: "opened", issue: { number: 9, labels: [] } },
    );
    expect(result).toEqual({ skipped: "service_disabled" });
    expect(stageSlackDelivery).not.toHaveBeenCalled();
  });
});
