import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/inactive-repos.js", () => ({
  getActiveRepoNames: vi.fn(async () => ["web"]),
}));
vi.mock("../../lib/github-app.js", () => ({
  getInstallationIdForOrg: vi.fn(async () => 42),
  getInstallationToken: vi.fn(async () => "installation-token"),
}));

import { onRequestGet as getComments } from "../github/comments.js";
import { onRequestGet as getDetails } from "../github/details.js";
import { onRequestGet as getRateLimit } from "../github/rate-limit.js";

function context(path, { token = "user-token", orgId = 7, orgLogin = "acme" } = {}) {
  return {
    request: new Request(`https://app.noxhere.com${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }),
    data: { orgId, orgLogin, userLogin: "ada" },
    env: { DB: {} },
  };
}

describe("NoxConnect GitHub facade", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("returns a bounded live issue projection using an installation token", async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({
      body: "Details", comments: 3, reactions: { total_count: 4 }, secret: "must-not-cross",
    }) }));
    const response = await getDetails(context("/api/github/details?kind=issue&repo=web&number=9"));
    expect(await response.json()).toEqual({ body: "Details", comments: 3, reactions_total: 4 });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/acme/web/issues/9",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer installation-token" }) }),
    );
  });

  it("combines PR conversation streams in chronological order", async () => {
    const response = (items) => ({
      ok: true,
      headers: new Headers(),
      json: async () => items,
    });
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(response([{
        id: 3, body: "General note", created_at: "2026-08-30T03:00:00Z",
        updated_at: "2026-08-30T03:00:00Z", html_url: "https://github/comment/3",
        user: { login: "ada", avatar_url: "https://img/ada" },
      }]))
      .mockResolvedValueOnce(response([
        { id: 1, body: "Looks good", state: "APPROVED", created_at: "2026-08-30T01:00:00Z", user: { login: "lin" } },
        { id: 9, body: "", state: "COMMENTED", created_at: "2026-08-30T04:00:00Z", user: { login: "skip" } },
      ]))
      .mockResolvedValueOnce(response([{
        id: 2, body: "Please rename this", path: "src/app.ts", line: 42,
        diff_hunk: "@@ -1 +1 @@", created_at: "2026-08-30T02:00:00Z", user: { login: "grace" },
      }]));

    const result = await getComments(context("/api/github/comments?repo=web&number=9"));

    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({
      comments: [
        expect.objectContaining({ id: "review:1", kind: "review", body: "Looks good", state: "approved" }),
        expect.objectContaining({ id: "review_comment:2", kind: "review_comment", path: "src/app.ts", line: 42 }),
        expect.objectContaining({ id: "comment:3", kind: "comment", body: "General note" }),
      ],
      truncated: false,
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    expect(globalThis.fetch.mock.calls.every(([, init]) => init.headers.Authorization === "Bearer installation-token")).toBe(true);
  });

  it("returns installation rate-limit state through NoxConnect", async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ resources: { core: { limit: 5000, remaining: 4999, reset: 1, used: 1 } } }) }));
    const response = await getRateLimit(context("/api/github/rate-limit"));
    expect(await response.json()).toEqual({ limit: 5000, remaining: 4999, reset: 1, used: 1 });
  });
});
