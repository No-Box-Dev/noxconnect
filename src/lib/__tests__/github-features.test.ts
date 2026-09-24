import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../api", () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPatch: vi.fn(),
  apiDelete: vi.fn(),
}));

import { apiGet, apiPost, apiPatch, apiDelete } from "../api";
import {
  fetchFeaturesFromD1,
  createFeature,
  updateFeature,
  deleteFeature,
  withStatusTransition,
} from "../github-features";

const mockGet = vi.mocked(apiGet);
const mockPost = vi.mocked(apiPost);
const mockPatch = vi.mocked(apiPatch);
const mockDelete = vi.mocked(apiDelete);

beforeEach(() => {
  vi.resetAllMocks();
});
afterEach(() => vi.restoreAllMocks());

describe("withStatusTransition", () => {
  const base = { id: 1, title: "x", status: "todo" as const, owners: [] };

  it("returns same feature when status matches", () => {
    const result = withStatusTransition({ ...base, statusHistory: [{ status: "todo", timestamp: "t" }] }, "todo");
    expect(result).toEqual({ ...base, statusHistory: [{ status: "todo", timestamp: "t" }] });
  });

  it("appends to statusHistory when status changes", () => {
    const result = withStatusTransition({ ...base, statusHistory: [{ status: "todo", timestamp: "t1" }] }, "staging");
    expect(result.status).toBe("staging");
    expect(result.statusHistory).toHaveLength(2);
    expect(result.statusHistory![1].status).toBe("staging");
  });

  it("creates statusHistory if missing", () => {
    const result = withStatusTransition(base, "ready");
    expect(result.statusHistory).toHaveLength(1);
    expect(result.statusHistory![0].status).toBe("ready");
  });
});

const row = (overrides: Record<string, unknown> = {}) => ({
  number: 5, title: "X", status: "todo", backlog: false, state: "open", plan: "", owners: [],
  statusHistory: [{ status: "todo", at: "2026-01-01T00:00:00Z" }],
  createdBy: "alice", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z", closedAt: null,
  ...overrides,
});

describe("fetchFeaturesFromD1", () => {
  it("maps NoxTicket features to the board shape", async () => {
    mockGet.mockResolvedValue([row({ status: "staging", backlog: true, owners: ["alice"] })]);
    const result = await fetchFeaturesFromD1("closed");
    expect(mockGet).toHaveBeenCalledWith("/api/v1/features?state=closed");
    expect(result).toEqual([{
      id: 5, title: "X", status: "staging", backlog: true, owners: ["alice"], updatedAt: "2026-01-02T00:00:00Z",
      statusHistory: [{ status: "todo", timestamp: "2026-01-01T00:00:00Z" }],
    }]);
  });
});

describe("createFeature", () => {
  it("POSTs to /api/v1/features with the requested fields", async () => {
    mockPost.mockResolvedValue(row({ title: "Add login" }));
    const result = await createFeature("org", "Add login", { status: "todo" });
    expect(mockPost).toHaveBeenCalledWith("/api/v1/features", {
      title: "Add login", status: "todo", owners: [], backlog: false,
    });
    expect(result.id).toBe(5);
    expect(result.title).toBe("Add login");
  });

  it("forwards owners and backlog when provided", async () => {
    mockPost.mockResolvedValue(row({ status: "staging", owners: ["alice"], backlog: true }));
    await createFeature("org", "X", { status: "staging", owners: ["alice"], backlog: true });
    expect(mockPost).toHaveBeenCalledWith("/api/v1/features", {
      title: "X", status: "staging", owners: ["alice"], backlog: true,
    });
  });

  it("propagates the error when the API helper rejects", async () => {
    mockPost.mockRejectedValue(new Error("title is required"));
    await expect(createFeature("org", "", { status: "todo" })).rejects.toThrow(/title is required/);
  });
});

describe("updateFeature", () => {
  it("PATCHes /api/v1/features/:id with only fields NoxTicket accepts", async () => {
    mockPatch.mockResolvedValue(row({ status: "ready", owners: ["alice"] }));
    const result = await updateFeature("org", {
      id: 5, title: "X", status: "ready", owners: ["alice"], specLinks: [],
    });
    expect(mockPatch).toHaveBeenCalledWith("/api/v1/features/5", {
      title: "X", status: "ready", owners: ["alice"], backlog: false,
    });
    expect(result.status).toBe("ready");
  });

  it("propagates the error when the API helper rejects", async () => {
    mockPatch.mockRejectedValue(new Error("Feature not found"));
    await expect(updateFeature("org", { id: 99, title: "X", status: "todo", owners: [] }))
      .rejects.toThrow(/Feature not found/);
  });
});

describe("deleteFeature", () => {
  it("DELETEs /api/v1/features/:id", async () => {
    mockDelete.mockResolvedValue({ ok: true });
    await deleteFeature("org", 5);
    expect(mockDelete).toHaveBeenCalledWith("/api/v1/features/5");
  });

  it("propagates the error when the API helper rejects", async () => {
    mockDelete.mockRejectedValue(new Error("boom"));
    await expect(deleteFeature("org", 5)).rejects.toThrow(/boom/);
  });
});
