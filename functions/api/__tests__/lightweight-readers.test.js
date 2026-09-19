import { describe, it, expect, vi } from "vitest";

import { onRequestGet as bootstrapGet } from "../bootstrap-status.js";
import { onRequestGet as meGet } from "../me.js";
import { onRequestGet as membersGet } from "../members.js";
import { onRequestGet as reposGet } from "../repos.js";
import { onRequestGet as teamsGet } from "../teams.js";

vi.mock("../../lib/inactive-repos.js", () => ({
  getInactiveRepoSet: vi.fn(),
}));
import { getInactiveRepoSet } from "../../lib/inactive-repos.js";

function makeDb({ firstResult = null, allResultsBySqlFragment = {} } = {}) {
  return {
    prepare(sql) {
      return {
        _sql: sql,
        bind() { return this; },
        async first() { return firstResult; },
        async all() {
          for (const [frag, results] of Object.entries(allResultsBySqlFragment)) {
            if (sql.includes(frag)) return { results };
          }
          return { results: [] };
        },
      };
    },
  };
}

function makeCtx({ db, url = "http://x/api", data = { orgId: 1, orgLogin: "acme", userLogin: "alice", isAdmin: false, token: "tok" } } = {}) {
  return { request: new Request(url), env: { DB: db }, data };
}

describe("GET /api/bootstrap-status", () => {
  it("returns bootstrapping=true when installation_id is set but bootstrapped_at is null", async () => {
    const db = makeDb({ firstResult: { installation_id: 42, bootstrapped_at: null } });
    const res = await bootstrapGet(makeCtx({ db }));
    expect(await res.json()).toEqual({ bootstrapping: true });
  });

  it("returns bootstrapping=false once bootstrapped_at is set", async () => {
    const db = makeDb({ firstResult: { installation_id: 42, bootstrapped_at: "2025-01-01" } });
    const res = await bootstrapGet(makeCtx({ db }));
    expect(await res.json()).toEqual({ bootstrapping: false });
  });

  it("returns bootstrapping=false when there's no installation (legacy/PAT orgs)", async () => {
    const db = makeDb({ firstResult: null });
    const res = await bootstrapGet(makeCtx({ db }));
    expect(await res.json()).toEqual({ bootstrapping: false });
  });
});

describe("GET /api/me", () => {
  const memberAccess = {
    accessLevel: "member",
    allowedServices: ["noxticket", "noxfeed", "noxspot", "noxcue"],
  };

  it("returns login, org, and isAdmin from context", async () => {
    const res = await meGet(makeCtx({ data: { userLogin: "alice", orgLogin: "acme", isAdmin: true } }));
    expect(await res.json()).toEqual({ login: "alice", org: "acme", isAdmin: true, isPlatformOperator: false, ...memberAccess });
  });

  it("coerces isAdmin to boolean", async () => {
    const res = await meGet(makeCtx({ data: { userLogin: "alice", orgLogin: "acme", isAdmin: 0 } }));
    expect(await res.json()).toEqual({ login: "alice", org: "acme", isAdmin: false, isPlatformOperator: false, ...memberAccess });
  });

  it("reports platform access independently from organization admin access", async () => {
    const res = await meGet(makeCtx({ data: { userLogin: "alice", orgLogin: "acme", isAdmin: false, isPlatformOperator: true } }));
    expect(await res.json()).toEqual({ login: "alice", org: "acme", isAdmin: false, isPlatformOperator: true, ...memberAccess });
  });

  it("returns only the selected project's invited tools for a guest", async () => {
    const res = await meGet(makeCtx({ data: {
      userLogin: "guest@example.com", orgLogin: "acme", isAdmin: false, projectId: "project-1",
      auth: { accessLevel: "guest", guestAccess: { organizationWide: false, projects: { "project-1": ["noxspot"] } } },
    } }));
    expect(await res.json()).toMatchObject({ accessLevel: "guest", allowedServices: ["noxspot"] });
  });
});

describe("GET /api/members", () => {
  it("returns member rows from D1", async () => {
    const db = makeDb({
      allResultsBySqlFragment: {
        "FROM members": [{ login: "alice", avatar_url: "a.png", kind: "human" }],
      },
    });
    const res = await membersGet(makeCtx({ db }));
    expect(await res.json()).toEqual([{ login: "alice", avatar_url: "a.png", kind: "human" }]);
  });
});

describe("GET /api/repos", () => {
  it("returns active repos by default", async () => {
    getInactiveRepoSet.mockResolvedValue(new Set(["drafty"]));
    const db = makeDb({
      allResultsBySqlFragment: {
        "FROM repos": [
          { name: "api", language: "TS", pushed_at: "2025-01-01" },
          { name: "drafty", language: "TS", pushed_at: "2024-12-01" },
        ],
      },
    });
    const res = await reposGet(makeCtx({ db }));
    const json = await res.json();
    expect(json).toEqual([{ name: "api", language: "TS", pushed_at: "2025-01-01" }]);
  });

  it("?include=all returns all rows with an `inactive` flag", async () => {
    getInactiveRepoSet.mockResolvedValue(new Set(["drafty"]));
    const db = makeDb({
      allResultsBySqlFragment: {
        "FROM repos": [
          { name: "api", language: "TS", pushed_at: "2025-01-01" },
          { name: "drafty", language: "TS", pushed_at: "2024-12-01" },
        ],
      },
    });
    const res = await reposGet(makeCtx({ db, url: "http://x/api/repos?include=all" }));
    expect(await res.json()).toEqual([
      { name: "api", language: "TS", pushed_at: "2025-01-01", inactive: false },
      { name: "drafty", language: "TS", pushed_at: "2024-12-01", inactive: true },
    ]);
  });
});

describe("GET /api/teams", () => {
  it("400s when orgLogin is missing", async () => {
    const res = await teamsGet(makeCtx({ db: makeDb(), data: { orgId: 1, orgLogin: null } }));
    expect(res.status).toBe(400);
  });

  it("returns teams + memberships map", async () => {
    const db = makeDb({
      allResultsBySqlFragment: {
        "FROM teams": [
          { github_id: 1, slug: "eng", name: "Engineering" },
          { github_id: 2, slug: "des", name: "Design" },
        ],
        "FROM team_memberships": [
          { team_name: "Engineering", login: "alice" },
          { team_name: "Design", login: "alice" },
          { team_name: "Engineering", login: "bob" },
        ],
      },
    });
    const res = await teamsGet(makeCtx({ db }));
    expect(await res.json()).toEqual({
      teams: [
        { slug: "eng", name: "Engineering" },
        { slug: "des", name: "Design" },
      ],
      memberships: {
        alice: ["Engineering", "Design"],
        bob: ["Engineering"],
      },
    });
  });
});
