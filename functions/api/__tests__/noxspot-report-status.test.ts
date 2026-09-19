import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/noxspot-resolution.js", () => ({
  updateNoxSpotReport: vi.fn(),
}));

import { onRequestPatch } from "../spots/reports/[id]";
import { updateNoxSpotReport } from "../../lib/noxspot-resolution.js";

function context(body: unknown, data: Record<string, unknown> = {}) {
  return {
    env: { DB: {}, TASK_QUEUE: { send: vi.fn() } },
    data: {
      orgId: 7, orgLogin: "acme", userLogin: "maintainer", isAdmin: true,
      projectId: "project-1", auth: { type: "session" }, ...data,
    },
    params: { id: "capture-1" },
    request: new Request("https://app.noxhere.com/api/v1/spots/reports/capture-1", {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }),
  };
}

describe("NoxSpot report status API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(updateNoxSpotReport).mockResolvedValue({ id: "capture-1", status: "resolved" } as never);
  });

  it("lets an admin resolve and notify an opted-in reporter", async () => {
    const response = await onRequestPatch(context({ status: "resolved", summary: "Fixed.", notify: true }) as never);
    expect(response.status).toBe(200);
    expect(updateNoxSpotReport).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      reportId: "capture-1", orgId: 7, projectId: "project-1", status: "resolved",
      summary: "Fixed.", notify: true, source: "platform",
    }));
  });

  it("rejects notification requests for non-resolved states", async () => {
    const response = await onRequestPatch(context({ status: "investigating", notify: true }) as never);
    expect(response.status).toBe(400);
    expect(updateNoxSpotReport).not.toHaveBeenCalled();
  });

  it("allows a project API token and marks the audit source", async () => {
    const response = await onRequestPatch(context({ status: "investigating" }, {
      isAdmin: false, auth: { type: "api_token" }, userLogin: "api-token",
    }) as never);
    expect(response.status).toBe(200);
    expect(updateNoxSpotReport).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ source: "api" }));
  });

  it("rejects a non-admin browser member", async () => {
    const response = await onRequestPatch(context({ status: "resolved" }, { isAdmin: false }) as never);
    expect(response.status).toBe(403);
  });
});
