import { describe, expect, it, vi } from "vitest";
import {
  AI_MODE_DISABLED,
  AI_MODE_MANAGED,
  MANAGED_LLM,
  managedLlmConfig,
  resolveAiMode,
  resolveLlmConfig,
} from "../llm-config.js";

function dbResult(result) {
  return {
    prepare() {
      return {
        bind() { return this; },
        first: () => result instanceof Error ? Promise.reject(result) : Promise.resolve(result),
      };
    },
  };
}

describe("managedLlmConfig", () => {
  it("builds the server-owned Anthropic route", () => {
    expect(managedLlmConfig({ ANTHROPIC_API_KEY: "secret" })).toEqual({
      status: "ready",
      mode: AI_MODE_MANAGED,
      ...MANAGED_LLM,
      apiKey: "secret",
      source: "managed",
    });
  });

  it("fails closed when the managed key is missing", () => {
    expect(managedLlmConfig({})).toEqual({
      status: "error",
      mode: AI_MODE_MANAGED,
      errorCode: "managed_key_missing",
    });
  });
});

describe("resolveLlmConfig", () => {
  it("defaults an organization to managed AI", async () => {
    await expect(resolveLlmConfig({ DB: dbResult(null), ANTHROPIC_API_KEY: "secret" }, 7))
      .resolves.toMatchObject({ status: "ready", source: "managed" });
  });

  it("honors an explicit disabled mode", async () => {
    await expect(resolveLlmConfig({ DB: dbResult({ mode: "disabled" }) }, 7))
      .resolves.toEqual({ status: "disabled", mode: AI_MODE_DISABLED });
  });

  it("fails closed for invalid context, state, or database errors", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(resolveLlmConfig({}, 7)).resolves.toMatchObject({ errorCode: "routing_context_missing" });
    await expect(resolveLlmConfig({ DB: dbResult({ mode: "byok" }), ANTHROPIC_API_KEY: "secret" }, 7))
      .resolves.toMatchObject({ errorCode: "routing_mode_invalid" });
    await expect(resolveLlmConfig({ DB: dbResult(new Error("down")), ANTHROPIC_API_KEY: "secret" }, 7))
      .resolves.toMatchObject({ errorCode: "routing_lookup_failed" });
    spy.mockRestore();
  });
});

describe("resolveAiMode", () => {
  it("enables product-owned generation without requiring a provider key in NoxConnect", async () => {
    await expect(resolveAiMode({ DB: dbResult(null) }, 7)).resolves.toEqual({
      status: "enabled",
      mode: AI_MODE_MANAGED,
    });
  });

  it("preserves the organization disable switch", async () => {
    await expect(resolveAiMode({ DB: dbResult({ mode: "disabled" }) }, 7)).resolves.toEqual({
      status: "disabled",
      mode: AI_MODE_DISABLED,
    });
  });
});
