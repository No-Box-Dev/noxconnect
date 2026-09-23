import { describe, it, expect, vi } from "vitest";
import { onRequestGet, onRequestPost } from "../features";
import { onRequestPatch, onRequestDelete } from "../features/[number]";

const feature = { number: 3, title: "Dark mode", status: "todo", backlog: false, state: "open" };

function makeService() {
  return {
    listFeatures: vi.fn(async () => ({ ok: true, status: 200, data: [feature] })),
    createFeature: vi.fn(async () => ({ ok: true, status: 201, data: feature })),
    updateFeature: vi.fn(async () => ({ ok: true, status: 200, data: feature })),
  };
}

function makeCtx({ service = makeService(), url = "http://x/api/features", method = "GET", body, params = {}, projectId = "project-1" } = {}) {
  const request = body !== undefined
    ? new Request(url, { method, headers: { "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) })
    : new Request(url, { method });
  return {
    request,
    env: service ? { NOXTICKET_SERVICE: service } : {},
    data: { orgId: 1, projectId, userLogin: "jasper", isAdmin: false },
    params,
  };
}

const scope = { orgId: 1, projectId: "project-1", userLogin: "jasper", isAdmin: false };

describe("/api/features", () => {
  it("lists the project's features from NoxTicket with the requested state", async () => {
    const ctx = makeCtx({ url: "http://x/api/features?state=closed" });
    const response = await onRequestGet(ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([feature]);
    expect(ctx.env.NOXTICKET_SERVICE.listFeatures).toHaveBeenCalledWith(scope, "closed");
  });

  it("creates a feature through NoxTicket", async () => {
    const ctx = makeCtx({ method: "POST", body: { title: "Dark mode" } });
    const response = await onRequestPost(ctx);
    expect(response.status).toBe(201);
    expect(ctx.env.NOXTICKET_SERVICE.createFeature).toHaveBeenCalledWith(scope, { title: "Dark mode" });
  });

  it("passes NoxTicket validation errors through", async () => {
    const service = makeService();
    service.createFeature.mockResolvedValueOnce({ ok: false, status: 422, error: "Invalid status: nope" });
    const response = await onRequestPost(makeCtx({ service, method: "POST", body: { title: "x", status: "nope" } }));
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "Invalid status: nope" });
  });

  it("400s on bad JSON", async () => {
    const response = await onRequestPost(makeCtx({ method: "POST", body: "{nope" }));
    expect(response.status).toBe(400);
  });

  it("requires a project", async () => {
    const ctx = makeCtx({ projectId: null });
    expect((await onRequestGet(ctx)).status).toBe(400);
    expect(ctx.env.NOXTICKET_SERVICE.listFeatures).not.toHaveBeenCalled();
  });

  it("503s when the NoxTicket binding is missing", async () => {
    const response = await onRequestGet(makeCtx({ service: null }));
    expect(response.status).toBe(503);
  });

  it("503s when NoxTicket throws", async () => {
    const service = makeService();
    service.listFeatures.mockRejectedValueOnce(new Error("boom"));
    expect((await onRequestGet(makeCtx({ service }))).status).toBe(503);
  });
});

describe("/api/features/:number", () => {
  it("updates a feature through NoxTicket", async () => {
    const ctx = makeCtx({ method: "PATCH", params: { number: "3" }, body: { status: "staging" } });
    const response = await onRequestPatch(ctx);
    expect(response.status).toBe(200);
    expect(ctx.env.NOXTICKET_SERVICE.updateFeature).toHaveBeenCalledWith(scope, 3, { status: "staging" });
  });

  it("closes a feature on DELETE", async () => {
    const ctx = makeCtx({ method: "DELETE", params: { number: "3" } });
    expect((await onRequestDelete(ctx)).status).toBe(200);
    expect(ctx.env.NOXTICKET_SERVICE.updateFeature).toHaveBeenCalledWith(scope, 3, { state: "closed" });
  });

  it("400s on a bad feature number", async () => {
    const ctx = makeCtx({ method: "PATCH", params: { number: "abc" }, body: {} });
    expect((await onRequestPatch(ctx)).status).toBe(400);
    expect((await onRequestDelete(makeCtx({ method: "DELETE", params: { number: "0" } }))).status).toBe(400);
  });
});
