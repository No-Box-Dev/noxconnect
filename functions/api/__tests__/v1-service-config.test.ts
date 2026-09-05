import { describe, expect, it } from "vitest";
import { onRequestGet, onRequestPatch } from "../v1/services/[service]/config";

function makeDb(raw: string | null, changes = 1, projectFound = true) {
  const calls = { runs: [] as Array<{ sql: string; binds: unknown[] }> };
  return {
    prepare(sql: string) {
      const statement = {
        binds: [] as unknown[],
        bind(...binds: unknown[]) { statement.binds = binds; return statement; },
        async first() {
          if (sql.includes("FROM projects")) return projectFound ? { found: 1 } : null;
          return raw == null ? null : { data: raw };
        },
        async run() { calls.runs.push({ sql, binds: statement.binds }); return { meta: { changes } }; },
        async all() { return { results: [] }; },
      };
      return statement;
    },
    async batch(statements: Array<{ run: () => Promise<unknown> }>) {
      return Promise.all(statements.map((statement) => statement.run()));
    },
    calls,
  };
}

interface ContextOptions {
  service?: string;
  raw?: string | null;
  method?: string;
  body?: unknown;
  etag?: string;
  isAdmin?: boolean;
  changes?: number;
  projectFound?: boolean;
}

function context({ service = "noxticket", raw = null, method = "GET", body, etag, isAdmin = true, changes = 1, projectFound = true }: ContextOptions = {}) {
  const db = makeDb(raw, changes, projectFound);
  const headers = new Headers();
  if (body !== undefined) headers.set("Content-Type", "application/json");
  if (etag) headers.set("If-Match", etag);
  return {
    db,
    ctx: {
      env: { DB: db },
      data: { orgId: 7, orgLogin: "acme", userLogin: "alice", isAdmin },
      params: { service },
      request: new Request(`https://app.unticket.ai/api/v1/services/${service}/config`, {
        method,
        headers,
        body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      }),
    },
  };
}

describe("service-scoped configuration API", () => {
  it("returns defaults, a revision, links, and an ETag", async () => {
    const { ctx } = context();
    const response = await onRequestGet(ctx as never);
    const body = await response.json() as any;
    expect(response.status).toBe(200);
    expect(response.headers.get("ETag")).toBe(`"${body.revision}"`);
    expect(body).toMatchObject({
      apiVersion: 1,
      organization: { login: "acme" },
      service: "noxticket",
      schemaVersion: 1,
      configuration: { mode: "service", writable: true, writableFields: ["featureRepository", "workflow.stages"] },
      config: { featureRepository: "noxconnect", workflow: { stages: expect.any(Array) } },
      links: { setup: "/api/v1/services/noxticket/setup" },
    });
  });

  it("requires admin access and an If-Match revision", async () => {
    const denied = context({ method: "PATCH", body: {}, isAdmin: false });
    expect((await onRequestPatch(denied.ctx as never)).status).toBe(403);
    const missing = context({ method: "PATCH", body: {} });
    expect((await onRequestPatch(missing.ctx as never)).status).toBe(428);
  });

  it("rejects stale revisions and unknown service fields", async () => {
    const stale = context({ method: "PATCH", body: { featureRepository: "product" }, etag: '"stale"' });
    expect((await onRequestPatch(stale.ctx as never)).status).toBe(412);

    const current = context();
    const getResponse = await onRequestGet(current.ctx as never);
    const etag = getResponse.headers.get("ETag")!;
    const invalid = context({ method: "PATCH", body: { slackToken: "never" }, etag });
    expect((await onRequestPatch(invalid.ctx as never)).status).toBe(422);
  });

  it("patches only fields owned by the selected service using compare-and-swap", async () => {
    const raw = JSON.stringify({ noxTicketRepo: "old", releaseNotesPrompt: "keep me", custom: { retained: true } });
    const initial = context({ raw });
    const getResponse = await onRequestGet(initial.ctx as never);
    const etag = getResponse.headers.get("ETag")!;

    const update = context({ raw, method: "PATCH", body: { featureRepository: "product" }, etag });
    const response = await onRequestPatch(update.ctx as never);
    const body = await response.json() as any;
    expect(response.status).toBe(200);
    expect(body.config.featureRepository).toBe("product");
    const written = JSON.parse(String(update.db.calls.runs[0].binds[0]));
    expect(written).toMatchObject({ noxTicketRepo: "product", releaseNotesPrompt: "keep me", custom: { retained: true } });
    expect(update.db.calls.runs[0].sql).toContain("AND data = ?");
  });

  it("maps a compare-and-swap race after validation to the standard 412 response", async () => {
    const raw = JSON.stringify({ noxTicketRepo: "old" });
    const initial = context({ raw });
    const etag = (await onRequestGet(initial.ctx as never)).headers.get("ETag")!;
    const raced = context({ raw, method: "PATCH", body: { featureRepository: "product" }, etag, changes: 0 });
    const response = await onRequestPatch(raced.ctx as never);
    expect(response.status).toBe(412);
    expect(await response.json()).toEqual({
      apiVersion: 1,
      error: {
        code: "revision_conflict",
        message: "Settings changed concurrently; fetch config and retry",
      },
    });
  });

  it("rejects a NoxFeed project scope that is not an active organization project", async () => {
    const initial = context({ service: "noxfeed" });
    const etag = (await onRequestGet(initial.ctx as never)).headers.get("ETag")!;
    const invalid = context({
      service: "noxfeed",
      method: "PATCH",
      body: { projectScope: "all" },
      etag,
      projectFound: false,
    });
    const response = await onRequestPatch(invalid.ctx as never);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: { code: "project_not_found", details: { field: "projectScope" } },
    });
    expect(invalid.db.calls.runs).toHaveLength(0);
  });

  it("directs resource-owned service config to its resource API", async () => {
    const initial = context({ service: "noxspot" });
    const getResponse = await onRequestGet(initial.ctx as never);
    const etag = getResponse.headers.get("ETag")!;
    const update = context({ service: "noxspot", method: "PATCH", body: {}, etag });
    const response = await onRequestPatch(update.ctx as never);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "resource_scoped_config" },
    });
    expect(response.headers.get("Allow")).toBe("GET");
    expect(update.db.calls.runs).toHaveLength(0);
  });
});
