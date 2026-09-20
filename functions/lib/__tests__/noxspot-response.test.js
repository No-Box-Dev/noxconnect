import { describe, expect, it, vi } from "vitest";
import { getNoxSpotDailyDigestResponse, getNoxSpotIssueResponse, getNoxSpotSlackResponse } from "../noxspot-response.js";

const capture = {
  captureId: "capture-1",
  siteId: "site-1",
  siteName: "Website",
  issueType: "bug",
  title: "Broken button",
  description: "It does nothing",
  orgId: 7,
  ownerId: "must-not-cross",
  repo: "must-not-cross",
};

function responseService() {
  return {
    buildIssueResponse: vi.fn(async () => ({
      contract: "noxspot.response",
      version: 1,
      idempotencyMarker: "<!-- noxspot:capture-1 -->",
      issue: {
        title: "Broken button",
        body: "Issue body\n\n<!-- noxspot:capture-1 -->",
        labels: [{ name: "noxspot", color: "FE795D", description: "Captured with NoxSpot" }],
      },
    })),
    buildSlackResponse: vi.fn(async () => ({
      contract: "noxspot.response",
      version: 1,
      message: { text: "New issue", blocks: [{ type: "section", text: { type: "mrkdwn", text: "Broken" } }] },
    })),
    buildDailyDigestResponse: vi.fn(async () => ({
      contract: "noxspot.response",
      version: 1,
      message: { text: "Daily summary", blocks: [{ type: "section", text: { type: "mrkdwn", text: "Daily" } }] },
    })),
  };
}

describe("NoxSpot response service adapter", () => {
  it("sends only product capture data, not connector routing identity", async () => {
    const service = responseService();
    await getNoxSpotIssueResponse({ NOXSPOT_RESPONSE: service }, capture);

    expect(service.buildIssueResponse).toHaveBeenCalledWith(expect.objectContaining({ captureId: "capture-1" }));
    expect(service.buildIssueResponse.mock.calls[0][0]).not.toHaveProperty("orgId");
    expect(service.buildIssueResponse.mock.calls[0][0]).not.toHaveProperty("ownerId");
    expect(service.buildIssueResponse.mock.calls[0][0]).not.toHaveProperty("repo");
    expect(service.buildIssueResponse.mock.calls[0][0]).not.toHaveProperty("reporterAvatarUrl");
  });

  it("passes only the GitHub result needed to construct Slack content", async () => {
    const service = responseService();
    await getNoxSpotSlackResponse({ NOXSPOT_RESPONSE: service }, capture, {
      number: 42,
      html_url: "https://github.com/acme/web/issues/42",
      token: "must-not-cross",
    });

    expect(service.buildSlackResponse).toHaveBeenCalledWith(
      expect.objectContaining({ captureId: "capture-1" }),
      { number: 42, url: "https://github.com/acme/web/issues/42" },
    );
  });

  it("fails closed when the service or contract is missing", async () => {
    await expect(getNoxSpotIssueResponse({}, capture)).rejects.toThrow("service binding is unavailable");
    const service = responseService();
    service.buildIssueResponse.mockResolvedValue({ version: 2 });
    await expect(getNoxSpotIssueResponse({ NOXSPOT_RESPONSE: service }, capture))
      .rejects.toThrow("Unsupported NoxSpot response contract");
  });

  it("validates the daily digest from the product response service", async () => {
    const service = responseService();
    const filed = [{ number: 1, title: "Open", url: "https://github.com/acme/web/issues/1" }];
    const solved = [{ number: 2, title: "Done", url: "https://github.com/acme/web/issues/2" }];
    const result = await getNoxSpotDailyDigestResponse(
      { NOXSPOT_RESPONSE: service }, "Website", "2026-08-31", filed, solved, { filed: 1, solved: 1 },
    );

    expect(result.message.text).toBe("Daily summary");
    expect(service.buildDailyDigestResponse).toHaveBeenCalledWith(
      "Website", "2026-08-31", filed, solved, { filed: 1, solved: 1 },
    );
  });
});
