import { afterEach, describe, expect, it, vi } from "vitest";
import { summarizeNoxSpotResolutions } from "../noxspot-digest-ai.js";

function env() {
  return {
    ANTHROPIC_API_KEY: "managed-key",
    DB: { prepare: () => ({ bind: () => ({ first: async () => null }) }) },
  };
}

const solvedIssue = (overrides = {}) => ({
  number: 30,
  title: "Image is blank",
  resolution: {
    kind: "pull_request",
    number: 55,
    title: "Serve shared images through the proxy",
    body: "The portal could not load private image URLs. This routes each image through our signed proxy before the page renders.",
    ...overrides,
  },
});

describe("NoxSpot digest fix summaries", () => {
  afterEach(() => vi.restoreAllMocks());

  it("uses one managed Anthropic summary for every issue closed by the same PR", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      content: [{ type: "text", text: '[{"prNumber":55,"summary":"Images now load through a signed proxy before the shared page appears."}]' }],
      stop_reason: "end_turn",
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const result = await summarizeNoxSpotResolutions(env(), 7, "project-1", [solvedIssue(), { ...solvedIssue(), number: 31 }]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(2);
    expect(result.every((issue) => issue.resolution.summary === "Images now load through a signed proxy before the shared page appears.")).toBe(true);
    expect(result.every((issue) => !("body" in issue.resolution))).toBe(true);
  });

  it("keeps the PR-title fallback when the model finds no described fix", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      content: [{ type: "text", text: '[{"prNumber":55,"summary":null}]' }],
      stop_reason: "end_turn",
    }), { status: 200 }));

    const [result] = await summarizeNoxSpotResolutions(env(), 7, "project-1", [solvedIssue({ body: "Fixes #30" })]);
    expect(result.resolution.summary).toBeUndefined();
    expect(result.resolution.title).toBe("Serve shared images through the proxy");
    expect(result.resolution.body).toBeUndefined();
  });

  it("does not call AI when no closing PR has a description", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const [result] = await summarizeNoxSpotResolutions(env(), 7, "project-1", [solvedIssue({ body: null })]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.resolution.title).toBe("Serve shared images through the proxy");
  });
});
