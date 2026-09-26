import { describe, expect, it, vi } from "vitest";
import { onRequestPost } from "../projects.js";

function context({ isAdmin = true, name = "Client portal", duplicate = null } = {}) {
  const statements = [];
  const db = {
    prepare(sql) {
      const statement = {
        sql,
        values: [],
        bind(...values) { this.values = values; return this; },
        async first() {
          if (sql.includes("SELECT id FROM projects")) return duplicate;
          if (sql.includes("SELECT data FROM config")) return { data: JSON.stringify({ apps: { noxspot: false } }) };
          return null;
        },
      };
      statements.push(statement);
      return statement;
    },
    batch: vi.fn(async () => []),
  };
  return {
    db,
    statements,
    value: {
      request: new Request("https://app.noxhere.com/api/v1/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      }),
      env: { DB: db },
      data: { orgId: 7, orgLogin: "acme", isAdmin },
    },
  };
}

describe("project creation", () => {
  it("creates an enabled empty project for the authenticated organization", async () => {
    const state = context();
    const response = await onRequestPost(state.value);
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.project).toMatchObject({
      name: "Client portal",
      slug: "client-portal",
      org: "acme",
      repo: null,
      routing_enabled: 1,
      enabled_services: ["noxticket", "noxfeed", "noxcue"],
    });
    expect(body.project.id).toMatch(/^proj_acme_client-portal_[a-f0-9-]{8}$/);
    expect(state.db.batch).toHaveBeenCalledTimes(1);
    expect(state.db.batch.mock.calls[0][0]).toHaveLength(2);
  });

  it("requires an organization admin", async () => {
    expect((await onRequestPost(context({ isAdmin: false }).value)).status).toBe(403);
  });

  it("rejects duplicate active project names", async () => {
    expect((await onRequestPost(context({ duplicate: { id: "existing" } }).value)).status).toBe(409);
  });
});
