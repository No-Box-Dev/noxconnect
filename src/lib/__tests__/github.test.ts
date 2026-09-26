import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/api", () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  refreshAccessToken: vi.fn(),
  ApiError: class ApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
  broadcastError: vi.fn(),
}));

import { apiGet } from "@/lib/api";
import {
  fetchUser,
  fetchOrgs,
  fetchRateLimit,
  fetchRepos,
  fetchOpenPRs,
  fetchMergedPRs,
  fetchOpenIssues,
  fetchClosedIssues,
  fetchOrgMembers,
  fetchPaginatedIssues,
  fetchPaginatedPrs,
  fetchIssueDetail,
  fetchPrDetail,
  fetchIssueBody,
  fetchPrBody,
  fetchEngineerStats,
  fetchEngineerActivity,
} from "../github";

const mockApiGet = vi.mocked(apiGet);

let storage: Record<string, string> = {};

beforeEach(() => {
  vi.clearAllMocks();
  storage = {};

  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage[key] ?? null,
    setItem: (key: string, val: string) => { storage[key] = val; },
    removeItem: (key: string) => { delete storage[key]; },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("NoxConnect GitHub facade", () => {
  it("loads identity and orgs through the core API", async () => {
    mockApiGet.mockResolvedValue({ user: { login: "ada" }, orgs: [{ login: "acme" }] });
    await expect(fetchUser()).resolves.toEqual({ login: "ada" });
    await expect(fetchOrgs()).resolves.toEqual([{ login: "acme" }]);
    expect(mockApiGet).toHaveBeenCalledWith("/api/v1/auth/profile?scope=user");
    expect(mockApiGet).toHaveBeenCalledWith("/api/v1/auth/profile?scope=orgs");
  });

  it("loads rate limits and live issue/PR details through core APIs", async () => {
    mockApiGet.mockResolvedValue({ body: "Details" });
    await fetchRateLimit();
    expect(mockApiGet).toHaveBeenCalledWith("/api/v1/github/rate-limit");
    await fetchIssueBody("ignored-owner", "web", 3);
    expect(mockApiGet).toHaveBeenCalledWith("/api/v1/github/details?kind=issue&repo=web&number=3");
    await fetchPrBody("ignored-owner", "web", 4);
    expect(mockApiGet).toHaveBeenCalledWith("/api/v1/github/details?kind=pr&repo=web&number=4");
  });
});

// ---------- fetchRepos ----------

describe("fetchRepos", () => {
  it("maps ApiRepo to RepoInfo shape with id=0 and visibility=private", async () => {
    mockApiGet.mockResolvedValue([
      { name: "repo-a", language: "TypeScript", pushed_at: "2026-01-01" },
    ]);

    const repos = await fetchRepos();
    expect(repos).toEqual([
      {
        id: 0,
        name: "repo-a",
        full_name: "repo-a",
        description: null,
        open_issues_count: 0,
        pushed_at: "2026-01-01",
        language: "TypeScript",
        visibility: "private",
        inactive: false,
        discoveredAt: null,
        acknowledgedAt: null,
        retiredAt: null,
        retirementReason: null,
        transferredTo: null,
      },
    ]);
  });
});

// ---------- fetchOpenPRs ----------

describe("fetchOpenPRs", () => {
  it("transforms author → user object", async () => {
    mockApiGet.mockResolvedValue([
      {
        id: 1, repo: "r", number: 10, title: "PR", state: "open",
        author: "alice", author_avatar: "https://img/alice",
        draft: false, head_ref: "feat", base_ref: "main",
        merged_at: null, created_at: "2026-01-01", updated_at: "2026-01-02",
        html_url: "https://github.com/org/r/pull/10",
        requested_reviewers: [], labels: [],
      },
    ]);

    const prs = await fetchOpenPRs();
    expect(prs[0].user).toEqual({ login: "alice", avatar_url: "https://img/alice" });
  });

  it("null author → null user", async () => {
    mockApiGet.mockResolvedValue([
      {
        id: 2, repo: "r", number: 11, title: "PR2", state: "open",
        author: null, author_avatar: null,
        draft: false, head_ref: null, base_ref: null,
        merged_at: null, created_at: "2026-01-01", updated_at: "2026-01-02",
        html_url: "https://github.com/org/r/pull/11",
        requested_reviewers: [], labels: [],
      },
    ]);

    const prs = await fetchOpenPRs();
    expect(prs[0].user).toBeNull();
  });

  it("maps head.repo from pr.repo string", async () => {
    mockApiGet.mockResolvedValue([
      {
        id: 3, repo: "my-repo", number: 12, title: "PR3", state: "open",
        author: "bob", author_avatar: "",
        draft: false, head_ref: "feat-x", base_ref: "main",
        merged_at: null, created_at: "2026-01-01", updated_at: "2026-01-02",
        html_url: "https://github.com/org/my-repo/pull/12",
        requested_reviewers: [], labels: [],
      },
    ]);

    const prs = await fetchOpenPRs();
    expect(prs[0].head.repo).toEqual({ name: "my-repo", full_name: "my-repo" });
  });
});

// ---------- fetchMergedPRs ----------

describe("fetchMergedPRs", () => {
  it("passes 'since' to query string", async () => {
    mockApiGet.mockResolvedValue([]);
    await fetchMergedPRs("2026-01-15");
    expect(mockApiGet).toHaveBeenCalledWith(
      expect.stringContaining("since=2026-01-15"),
    );
  });
});

// ---------- fetchOpenIssues ----------

describe("fetchOpenIssues", () => {
  it("transforms milestone_title → milestone object", async () => {
    mockApiGet.mockResolvedValue({ data: [
      {
        id: 1, repo: "r", number: 5, title: "Issue", state: "open",
        author: "alice", author_avatar: "https://img/alice",
        created_at: "2026-01-01", updated_at: "2026-01-02", closed_at: null,
        html_url: "https://github.com/org/r/issues/5",
        assignees: [], labels: [],
        milestone_title: "v1.0",
      },
    ], totalCount: 1 });

    const issues = await fetchOpenIssues();
    expect(issues[0].milestone).toEqual({ title: "v1.0" });
  });

  it("maps assignees with fallback avatar", async () => {
    mockApiGet.mockResolvedValue({ data: [
      {
        id: 2, repo: "r", number: 6, title: "Issue2", state: "open",
        author: "bob", author_avatar: "",
        created_at: "2026-01-01", updated_at: "2026-01-02", closed_at: null,
        html_url: "https://github.com/org/r/issues/6",
        assignees: [{ login: "charlie" }],
        labels: [], milestone_title: null,
      },
    ], totalCount: 1 });

    const issues = await fetchOpenIssues();
    expect(issues[0].assignees).toEqual([{ login: "charlie", avatar_url: "" }]);
  });
});

// ---------- fetchClosedIssues ----------

describe("fetchClosedIssues", () => {
  it("passes closed_since param", async () => {
    mockApiGet.mockResolvedValue({ data: [], totalCount: 0 });
    await fetchClosedIssues("2026-01-10");
    expect(mockApiGet).toHaveBeenCalledWith(
      expect.stringContaining("closed_since=2026-01-10"),
    );
  });
});

// ---------- fetchPaginatedIssues ----------

describe("fetchPaginatedIssues", () => {
  it("serializes stale=1 query flag", async () => {
    mockApiGet.mockResolvedValue({ data: [], totalCount: 0, page: 1, pageSize: 30 });
    await fetchPaginatedIssues({ state: "open", stale: true });
    expect(mockApiGet).toHaveBeenCalledWith(expect.stringContaining("stale=1"));
    expect(mockApiGet).toHaveBeenCalledWith(expect.stringContaining("state=open"));
  });

  it("omits stale flag when false", async () => {
    mockApiGet.mockResolvedValue({ data: [], totalCount: 0, page: 1, pageSize: 30 });
    await fetchPaginatedIssues({ state: "open" });
    expect(mockApiGet).not.toHaveBeenCalledWith(expect.stringContaining("stale="));
  });

  it("passes repos as comma-separated list", async () => {
    mockApiGet.mockResolvedValue({ data: [], totalCount: 0, page: 1, pageSize: 30 });
    await fetchPaginatedIssues({ repos: ["a", "b", "c"] });
    expect(mockApiGet).toHaveBeenCalledWith(expect.stringContaining("repos=a%2Cb%2Cc"));
  });
});

// ---------- fetchPaginatedPrs ----------

describe("fetchPaginatedPrs", () => {
  it("serializes draft=1 and stale=1 query flags", async () => {
    mockApiGet.mockResolvedValue({ data: [], totalCount: 0, page: 1, pageSize: 30 });
    await fetchPaginatedPrs({ state: "open", draft: true, stale: true });
    expect(mockApiGet).toHaveBeenCalledWith(expect.stringContaining("draft=1"));
    expect(mockApiGet).toHaveBeenCalledWith(expect.stringContaining("stale=1"));
  });

  it("omits flags when false", async () => {
    mockApiGet.mockResolvedValue({ data: [], totalCount: 0, page: 1, pageSize: 30 });
    await fetchPaginatedPrs({ state: "open" });
    const call = mockApiGet.mock.calls[0][0] as string;
    expect(call).not.toContain("draft=");
    expect(call).not.toContain("stale=");
  });
});

// ---------- fetchIssueDetail / fetchPrDetail ----------

describe("fetchIssueDetail", () => {
  it("calls /api/v1/issues/:repo/:number and transforms result", async () => {
    mockApiGet.mockResolvedValue({
      issue: {
        id: 99, repo: "my-repo", number: 7, title: "T", state: "open",
        author: "alice", author_avatar: "https://img/alice",
        created_at: "2026-01-01", updated_at: "2026-01-02", closed_at: null,
        html_url: "https://github.com/org/my-repo/issues/7",
        assignees: [{ login: "bob" }], labels: [{ name: "bug", color: "ff0000" }],
        milestone_title: null, closed_by: null,
      },
    });
    const issue = await fetchIssueDetail("my-repo", 7);
    expect(mockApiGet).toHaveBeenCalledWith("/api/v1/issues/my-repo/7");
    expect(issue.user).toEqual({ login: "alice", avatar_url: "https://img/alice" });
    expect(issue.assignees).toEqual([{ login: "bob", avatar_url: "" }]);
  });

  it("url-encodes repo names containing special characters", async () => {
    mockApiGet.mockResolvedValue({
      issue: {
        id: 1, repo: "repo.dot", number: 1, title: "T", state: "open",
        author: null, author_avatar: null,
        created_at: "2026-01-01", updated_at: "2026-01-02", closed_at: null,
        html_url: "x", assignees: [], labels: [], milestone_title: null, closed_by: null,
      },
    });
    await fetchIssueDetail("repo.dot", 1);
    expect(mockApiGet).toHaveBeenCalledWith("/api/v1/issues/repo.dot/1");
  });
});

describe("fetchPrDetail", () => {
  it("calls /api/v1/prs/:repo/:number and transforms result", async () => {
    mockApiGet.mockResolvedValue({
      pr: {
        id: 99, repo: "r", number: 12, title: "PR", state: "open",
        author: "alice", author_avatar: "",
        draft: true, head_ref: "feat", base_ref: "main",
        merged_at: null, created_at: "2026-01-01", updated_at: "2026-01-02",
        html_url: "https://github.com/org/r/pull/12",
        requested_reviewers: [{ login: "bob" }], labels: [],
      },
    });
    const pr = await fetchPrDetail("r", 12);
    expect(mockApiGet).toHaveBeenCalledWith("/api/v1/prs/r/12");
    expect(pr.draft).toBe(true);
    expect(pr.head.repo).toEqual({ name: "r", full_name: "r" });
  });
});

// ---------- fetchOrgMembers ----------

describe("fetchOrgMembers", () => {
  it("maps to {login, avatar_url, id:0, type:'User'}", async () => {
    mockApiGet.mockResolvedValue([
      { login: "alice", avatar_url: "https://img/alice" },
      { login: "bob", avatar_url: null },
    ]);

    const members = await fetchOrgMembers();
    expect(members).toEqual([
      { login: "alice", avatar_url: "https://img/alice", id: 0, type: "User" },
      { login: "bob", avatar_url: "", id: 0, type: "User" },
    ]);
  });
});


// ---------- fetchEngineerStats ----------

describe("fetchEngineerStats", () => {
  it("requests the aggregation endpoint and returns the count maps", async () => {
    const payload = {
      openPRs: { alice: 3 },
      reviewing: { alice: 2 },
      approvalsGiven: { alice: 12 },
      mergesOfOthers: { alice: 4 },
      assignedIssues: { bob: 1 },
      lifetimePRs: { alice: 40 },
      prsLast4Weeks: { alice: 5 },
      issuesClosed: { bob: 7 },
    };
    mockApiGet.mockResolvedValue(payload);

    const stats = await fetchEngineerStats();
    expect(mockApiGet).toHaveBeenCalledWith("/api/v1/engineer-stats");
    expect(stats).toEqual(payload);
  });
});

// ---------- fetchEngineerActivity ----------

describe("fetchEngineerActivity", () => {
  it("requests the activity endpoint with the login and returns daily maps", async () => {
    const payload = {
      login: "alice",
      month: "2026-06",
      firstMonth: "2026-01",
      prsOpened: { "2026-06-01": 5, "2026-06-03": 8 },
      prsReviewed: { "2026-06-02": 3 },
    };
    mockApiGet.mockResolvedValue(payload);
    const res = await fetchEngineerActivity("alice");
    expect(mockApiGet).toHaveBeenCalledWith("/api/v1/engineer-activity?login=alice");
    expect(res).toEqual(payload);
  });

  it("passes the month param when given", async () => {
    mockApiGet.mockResolvedValue({ login: "alice", month: "2026-05", firstMonth: "2026-01", prsOpened: {}, prsReviewed: {} });
    await fetchEngineerActivity("alice", "2026-05");
    expect(mockApiGet).toHaveBeenCalledWith(expect.stringContaining("month=2026-05"));
  });
});
