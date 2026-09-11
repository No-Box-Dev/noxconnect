import { describe, it, expect } from "vitest";
import { onRequestGet, onRequestPut } from "../llm-settings";

function makeCtx({
  row = null,
  body,
  isAdmin = true,
  orgId = 7,
  key = "managed-key",
  noxfeedAvailable = true,
  generationInfoError = null,
} = {}) {
  const calls = { batches: [] };
  const DB = {
    prepare(sql) {
      return {
        sql,
        args: [],
        bind(...args) { this.args = args; return this; },
        async first() { return row; },
      };
    },
    async batch(statements) {
      calls.batches.push(statements);
      return statements.map(() => ({ success: true }));
    },
  };

  return {
    ctx: {
      env: {
        DB,
        ANTHROPIC_API_KEY: key,
        NOXFEED_RESPONSE: {
          async generationInfo() {
            if (generationInfoError) throw generationInfoError;
            return {
              contract: "noxfeed.response",
              version: 1,
              provider: "anthropic",
              model: "noxfeed-model",
              available: noxfeedAvailable,
            };
          },
        },
      },
      data: { orgId, isAdmin, orgLogin: "acme", userLogin: "admin" },
      request: new Request("https://example.com/api/llm-settings", {
        method: body === undefined ? "GET" : "PUT",
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    },
    calls,
  };
}

describe("managed AI settings", () => {
  it("returns the managed default without exposing a key", async () => {
    const response = await onRequestGet(makeCtx().ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      mode: "managed",
      managed: {
        provider: "anthropic",
        model: "noxfeed-model",
        available: true,
        services: {
          noxfeed: { provider: "anthropic", model: "noxfeed-model", available: true },
          noxconnect: {
            provider: "anthropic",
            model: "claude-haiku-4-5-20251001",
            available: true,
          },
        },
      },
    });
  });

  it("reports per-service readiness and requires both services for aggregate readiness", async () => {
    const response = await onRequestGet(makeCtx({ noxfeedAvailable: false }).ctx);
    expect(await response.json()).toMatchObject({
      managed: {
        available: false,
        services: {
          noxfeed: { available: false },
          noxconnect: { available: true },
        },
      },
    });
  });

  it("degrades safely when the private NoxFeed RPC is unavailable", async () => {
    const response = await onRequestGet(makeCtx({ generationInfoError: new Error("private detail") }).ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      managed: {
        available: false,
        services: { noxfeed: { available: false }, noxconnect: { available: true } },
      },
    });
  });

  it("returns a stored disabled mode", async () => {
    const response = await onRequestGet(makeCtx({ row: { mode: "disabled" } }).ctx);
    expect(await response.json()).toMatchObject({ mode: "disabled" });
  });

  it("admin can disable AI and the change is audited", async () => {
    const { ctx, calls } = makeCtx({ body: { mode: "disabled" } });
    expect((await onRequestPut(ctx)).status).toBe(200);
    expect(calls.batches[0][0].sql).toContain("INSERT INTO ai_settings");
    expect(calls.batches[0][1].args).toEqual([7, "admin", "disabled"]);
  });

  it("rejects BYOK fields and missing managed infrastructure", async () => {
    expect((await onRequestPut(makeCtx({ body: { mode: "byok" } }).ctx)).status).toBe(400);
    expect((await onRequestPut(makeCtx({ body: { mode: "managed", apiKey: "never" } }).ctx)).status).toBe(400);
    const missingNoxConnect = await onRequestPut(makeCtx({ body: { mode: "managed" }, key: null }).ctx);
    expect(missingNoxConnect.status).toBe(503);
    expect(await missingNoxConnect.json()).toMatchObject({ code: "dependency_unavailable" });
    expect((await onRequestPut(makeCtx({ body: { mode: "managed" }, noxfeedAvailable: false }).ctx)).status).toBe(503);
  });

  it("preserves admin and organization boundaries", async () => {
    expect((await onRequestGet(makeCtx({ isAdmin: false }).ctx)).status).toBe(403);
    expect((await onRequestGet(makeCtx({ orgId: null }).ctx)).status).toBe(400);
  });
});
