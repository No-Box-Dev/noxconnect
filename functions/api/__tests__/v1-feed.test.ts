import { describe, it, expect } from "vitest";
import { onRequestGet as feed } from "../v1/feed";

function makeDb({ allResult = [] as unknown[] } = {}) {
  const calls = { all: [] as Array<{ sql: string; binds: unknown[] }> };
  return {
    prepare(sql: string) {
      const stmt: {
        _sql: string;
        _binds: unknown[];
        bind: (...b: unknown[]) => typeof stmt;
        all: () => Promise<{ results: unknown[] }>;
      } = {
        _sql: sql,
        _binds: [],
        bind(...binds: unknown[]) {
          this._binds = binds;
          return this;
        },
        async all() {
          calls.all.push({ sql, binds: this._binds });
          return { results: allResult };
        },
      };
      return stmt;
    },
    _calls: calls,
  };
}

function makeCtx({
  db,
  url = "http://x/api/v1/feed",
  orgLogin = "acme" as string | null,
  projectId = null as string | null,
}: {
  db: ReturnType<typeof makeDb>;
  url?: string;
  orgLogin?: string | null;
  projectId?: string | null;
}) {
  return {
    request: new Request(url),
    env: { DB: db as unknown as D1Database },
    data: { orgLogin: orgLogin as string, projectId },
  };
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 200,
    type: "narrative",
    created_at: "2025-01-15T10:00:00Z",
    repo: "noxconnect",
    summary: "shipped a thing",
    technical_summary: "What it does: Ships a thing\nHow it works: Updates the flow\nWhat it touches: NoxConnect",
    payload_json: JSON.stringify({
      trigger_type: "github:pr:merged",
      pr: {
        number: 42,
        title: "Feature X",
        html_url: "https://github.com/acme/noxconnect/pull/42",
        author: { login: "alice", name: "Alice A", avatar_url: "https://gh/a.png" },
      },
    }),
    ...overrides,
  };
}

describe("GET /api/v1/feed", () => {
  it("400s when orgLogin is missing", async () => {
    const res = await feed(makeCtx({ db: makeDb(), orgLogin: null }));
    expect(res.status).toBe(400);
  });

  it("returns events mapped to the public shape", async () => {
    const db = makeDb({ allResult: [row()] });
    const res = await feed(makeCtx({ db }));
    const body = (await res.json()) as { events: Array<Record<string, unknown>>; nextCursor: string | null };

    expect(res.status).toBe(200);
    expect(body.events).toHaveLength(1);
    const e = body.events[0];

    // Public shape: no actor_id / project_id / payload_json / trigger_type.
    expect(e).toEqual({
      id: "200",
      type: "merged",
      createdAt: "2025-01-15T10:00:00Z",
      actor: { login: "alice", name: "Alice A", avatarUrl: "https://gh/a.png" },
      repo: "noxconnect",
      summary: "shipped a thing",
      technicalSummary: "What it does: Ships a thing\nHow it works: Updates the flow\nWhat it touches: NoxConnect",
      pr: {
        number: 42,
        title: "Feature X",
        url: "https://github.com/acme/noxconnect/pull/42",
      },
    });
    expect(e).not.toHaveProperty("payload_json");
    expect(e).not.toHaveProperty("actor_id");
  });

  it("computes nextCursor only when a full page came back", async () => {
    // limit defaults to 25 — one row means partial page, so no cursor.
    const dbShort = makeDb({ allResult: [row()] });
    let body = (await (await feed(makeCtx({ db: dbShort }))).json()) as { nextCursor: string | null };
    expect(body.nextCursor).toBeNull();

    // Full page of `limit` rows → cursor from last row.
    const full = Array.from({ length: 25 }, (_, i) =>
      row({ id: 200 - i, created_at: `2025-01-15T${String(10 - Math.min(i, 9)).padStart(2, "0")}:00:00Z` }),
    );
    const dbFull = makeDb({ allResult: full });
    body = (await (await feed(makeCtx({ db: dbFull }))).json()) as { nextCursor: string | null };
    expect(body.nextCursor).toBe(`${full[full.length - 1].created_at}:${full[full.length - 1].id}`);
  });

  it("maps mode=opened to the pr_narrative type + pr:opened trigger", async () => {
    const db = makeDb();
    await feed(makeCtx({ db, url: "http://x/api/v1/feed?mode=opened" }));
    const { binds } = db._calls.all[0];
    expect(binds).toContain("pr_narrative");
    expect(binds).toContain("github:pr:opened");
  });

  it("maps mode=release-notes to the release_notes type", async () => {
    const db = makeDb();
    await feed(makeCtx({ db, url: "http://x/api/v1/feed?mode=release-notes" }));
    const { binds } = db._calls.all[0];
    expect(binds).toContain("release_notes");
    expect(binds).toContain("github:pr:merged");
  });

  it("adds repo filter to SQL + binds", async () => {
    const db = makeDb();
    await feed(makeCtx({ db, url: "http://x/api/v1/feed?repo=noxconnect" }));
    const { sql, binds } = db._calls.all[0];
    expect(sql).toMatch(/repo = \?/);
    expect(binds).toContain("noxconnect");
  });

  it("enforces the API token project in SQL", async () => {
    const db = makeDb();
    await feed(makeCtx({ db, projectId: "project_playnist" }));
    const { sql, binds } = db._calls.all[0];
    expect(sql).toMatch(/project_id = \?/);
    expect(binds).toContain("project_playnist");
  });

  it("adds case-insensitive actor filter to SQL + binds", async () => {
    const db = makeDb();
    await feed(makeCtx({ db, url: "http://x/api/v1/feed?actor=Alice" }));
    const { sql, binds } = db._calls.all[0];
    expect(sql).toMatch(/LOWER\(json_extract\(payload_json, '\$\.pr\.author\.login'\)\) = LOWER\(\?\)/);
    expect(binds).toContain("Alice");
  });

  it("applies composite cursor when 'before' is parseable", async () => {
    const db = makeDb();
    await feed(makeCtx({ db, url: "http://x/api/v1/feed?before=2025-01-15T09:00:00Z:199" }));
    const { sql, binds } = db._calls.all[0];
    expect(sql).toMatch(/created_at < \? OR \(created_at = \? AND id < \?\)/);
    expect(binds).toContain(199);
    expect(binds).toContain("2025-01-15T09:00:00Z");
  });

  it("400s on invalid mode", async () => {
    const res = await feed(makeCtx({ db: makeDb(), url: "http://x/api/v1/feed?mode=bogus" }));
    expect(res.status).toBe(400);
  });

  it("400s on limit above 200", async () => {
    const res = await feed(makeCtx({ db: makeDb(), url: "http://x/api/v1/feed?limit=999" }));
    expect(res.status).toBe(400);
  });

  it("handles malformed payload_json gracefully (actor=unknown, pr=null)", async () => {
    const db = makeDb({
      allResult: [
        row({
          payload_json: "{ this is not json",
          repo: "somerepo",
          summary: "raw",
        }),
      ],
    });
    const res = await feed(makeCtx({ db }));
    const body = (await res.json()) as { events: Array<Record<string, unknown>>; nextCursor: string | null };
    expect(body.events[0]).toEqual({
      id: "200",
      type: "merged",
      createdAt: "2025-01-15T10:00:00Z",
      actor: { login: "unknown", name: null, avatarUrl: null },
      repo: "somerepo",
      summary: "raw",
      technicalSummary: "What it does: Ships a thing\nHow it works: Updates the flow\nWhat it touches: NoxConnect",
      pr: null,
    });
  });
});
