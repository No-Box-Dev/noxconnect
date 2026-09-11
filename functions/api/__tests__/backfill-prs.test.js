import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/github-app.js", () => ({
  getInstallationToken: vi.fn(async () => "installation-token"),
}));

import { onRequestPost } from "../projects/[id]/backfill-prs.js";

afterEach(() => vi.restoreAllMocks());

describe("pull-request post backfill dependencies", () => {
  it("returns a sanitized dependency error when NoxFeed generation info is unreachable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify([{
      number: 42,
      title: "Improve login",
      user: { login: "alex" },
      created_at: "2026-09-11T10:00:00Z",
      updated_at: "2026-09-11T10:00:00Z",
      merged_at: null,
      closed_at: null,
    }]), { status: 200, headers: { "Content-Type": "application/json" } }));

    const DB = {
      prepare(sql) {
        return {
          bind() { return this; },
          async first() {
            if (sql.includes("FROM projects")) {
              return { id: "project-1", name: "App", org: "acme", repo: "app", owner_id: "acme" };
            }
            if (sql.includes("FROM installations")) return { installation_id: 123 };
            return null;
          },
          async all() { return { results: [] }; },
        };
      },
    };
    const context = {
      env: {
        DB,
        NOXFEED_RESPONSE: {
          async generationInfo() { throw new Error("secret internal binding detail"); },
        },
      },
      data: { orgLogin: "acme", isAdmin: true },
      params: { id: "project-1" },
      request: new Request("https://example.com/api/v1/projects/project-1/backfill-prs", {
        method: "POST",
        body: JSON.stringify({ rewriteOtherModels: true }),
      }),
      waitUntil: vi.fn(),
    };

    const response = await onRequestPost(context);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "NoxFeed generation service is unavailable",
      code: "dependency_unavailable",
    });
    expect(context.waitUntil).not.toHaveBeenCalled();
  });
});
