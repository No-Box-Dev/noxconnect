import { describe, expect, it, vi } from "vitest";
import { onRequestGet, onRequestPatch } from "../spots/sites/[id]/resolution-template";
import { onRequestPost as previewTemplate } from "../spots/sites/[id]/resolution-template/preview";
import { onRequestPost as testTemplate } from "../spots/sites/[id]/resolution-template/test";
import { DEFAULT_NOXSPOT_RESOLUTION_TEMPLATE } from "../../lib/noxspot-resolution-template.js";

function database(widgetConfig = "{}", changes = 1, persistUpdate = false) {
  const runs: Array<{ sql: string; binds: unknown[] }> = [];
  let storedWidgetConfig = widgetConfig;
  return {
    runs,
    prepare(sql: string) {
      const statement = {
        binds: [] as unknown[],
        bind(...binds: unknown[]) { statement.binds = binds; return statement; },
        async first() {
          if (sql.includes("FROM spot_sites")) {
            return { id: "site-1", name: "Playnist", project_id: "playnist", widget_config: storedWidgetConfig };
          }
          return null;
        },
        async run() {
          runs.push({ sql, binds: statement.binds });
          if (persistUpdate && sql.includes("UPDATE spot_sites")) storedWidgetConfig = String(statement.binds[0]);
          return { success: true, meta: { changes: sql.includes("UPDATE spot_sites") ? changes : 1 } };
        },
      };
      return statement;
    },
  };
}

function context(options: { method?: string; body?: unknown; etag?: string; isAdmin?: boolean; apiToken?: boolean; db?: ReturnType<typeof database>; email?: { sendEmail: ReturnType<typeof vi.fn> } } = {}) {
  const headers = new Headers();
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  if (options.etag) headers.set("If-Match", options.etag);
  const db = options.db ?? database();
  return {
    db,
    ctx: {
      env: { DB: db, ...(options.email ? { NOXCONNECT_EMAIL: options.email } : {}) },
      data: {
        orgId: 7,
        projectId: "playnist",
        userLogin: options.apiToken ? "api-token:test" : "admin",
        isAdmin: options.isAdmin ?? true,
        ...(options.apiToken ? { auth: { type: "api_token" } } : {}),
      },
      params: { id: "site-1" },
      request: new Request("https://app.noxhere.com/api/v1/spots/sites/site-1/resolution-template", {
        method: options.method ?? "GET",
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      }),
    },
  };
}

describe("NoxSpot resolution template API", () => {
  it("returns defaults with an ETag and requires admin access", async () => {
    const response = await onRequestGet(context().ctx as never);
    const body = await response.json() as any;
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ usingDefault: true, template: DEFAULT_NOXSPOT_RESOLUTION_TEMPLATE });
    expect(response.headers.get("ETag")).toBe(`"${body.revision}"`);
    expect((await onRequestGet(context({ isAdmin: false }).ctx as never)).status).toBe(403);
    expect((await onRequestGet(context({ isAdmin: false, apiToken: true }).ctx as never)).status).toBe(200);
  });

  it("saves with If-Match and preserves unrelated widget configuration", async () => {
    const initial = context({ db: database('{"buttonText":"Report"}') });
    const etag = (await onRequestGet(initial.ctx as never)).headers.get("ETag")!;
    const custom = { ...DEFAULT_NOXSPOT_RESOLUTION_TEMPLATE, tone: "formal" as const, replyTo: "jasper@noboxdev.com" };
    const update = context({ db: initial.db, method: "PATCH", etag, body: { template: custom } });
    const response = await onRequestPatch(update.ctx as never);
    expect(response.status).toBe(200);
    const stored = initial.db.runs.find((run) => run.sql.includes("UPDATE spot_sites"));
    expect(JSON.parse(String(stored?.binds[0]))).toMatchObject({ buttonText: "Report", resolutionEmail: custom });
  });

  it("rejects missing and stale revisions without recording an update audit", async () => {
    expect((await onRequestPatch(context({ method: "PATCH", body: { template: null } }).ctx as never)).status).toBe(428);
    const racedDb = database("{}", 0);
    const changedTemplate = { ...DEFAULT_NOXSPOT_RESOLUTION_TEMPLATE, tone: "formal" as const };
    const response = await onRequestPatch(context({ db: racedDb, method: "PATCH", etag: await currentEtag(), body: { template: changedTemplate } }).ctx as never);
    expect(response.status).toBe(412);
    expect(racedDb.runs.filter((run) => run.sql.includes("noxspot_config_audit"))).toHaveLength(0);
  });

  it("confirms a persisted update when D1 reports an unreliable change count", async () => {
    const db = database("{}", 0, true);
    const etag = (await onRequestGet(context({ db }).ctx as never)).headers.get("ETag")!;
    const custom = { ...DEFAULT_NOXSPOT_RESOLUTION_TEMPLATE, buttonLabel: "Reopen the ticket" };
    const response = await onRequestPatch(context({ db, method: "PATCH", etag, body: { template: custom } }).ctx as never);
    expect(response.status).toBe(200);
    expect(db.runs.filter((run) => run.sql.includes("noxspot_config_audit"))).toHaveLength(1);
  });

  it("previews substitutions and sends a test through the private email capability", async () => {
    const preview = await previewTemplate(context({ method: "POST", body: { template: DEFAULT_NOXSPOT_RESOLUTION_TEMPLATE } }).ctx as never);
    expect(await preview.json()).toMatchObject({ preview: { subject: "Resolved: Could not update a collection on mobile", closing: expect.stringContaining("Playnist") } });

    const sendEmail = vi.fn(async () => ({ messageId: "postmark-test-1" }));
    const test = context({ method: "POST", body: { recipient: "jasper@noboxdev.com", template: DEFAULT_NOXSPOT_RESOLUTION_TEMPLATE }, email: { sendEmail } });
    const response = await testTemplate(test.ctx as never);
    expect(response.status).toBe(200);
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      recipient: "jasper@noboxdev.com",
      template: "noxspot.resolution",
      model: expect.objectContaining({ presentation: DEFAULT_NOXSPOT_RESOLUTION_TEMPLATE }),
    }));
    expect(JSON.stringify(test.db.runs)).not.toContain("jasper@noboxdev.com");
  });
});

async function currentEtag() {
  return (await onRequestGet(context().ctx as never)).headers.get("ETag")!;
}
