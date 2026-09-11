// NoxConnect's server-owned Anthropic route. Customers never provide keys or
// endpoints; an organization can only disable AI when policy requires it.

export const AI_MODE_MANAGED = "managed";
export const AI_MODE_DISABLED = "disabled";
export const PROVIDER_ANTHROPIC = "anthropic";

export const MANAGED_LLM = Object.freeze({
  provider: PROVIDER_ANTHROPIC,
  baseUrl: "https://api.anthropic.com",
  model: "claude-haiku-4-5-20251001",
});

export function managedLlmConfig(env) {
  if (!env?.ANTHROPIC_API_KEY) {
    return { status: "error", mode: AI_MODE_MANAGED, errorCode: "managed_key_missing" };
  }
  return {
    status: "ready",
    mode: AI_MODE_MANAGED,
    ...MANAGED_LLM,
    apiKey: env.ANTHROPIC_API_KEY,
    source: "managed",
  };
}

export async function resolveAiMode(env, orgId) {
  if (!env?.DB || !orgId) {
    return { status: "error", mode: AI_MODE_MANAGED, errorCode: "routing_context_missing" };
  }

  try {
    const row = await env.DB.prepare("SELECT mode FROM ai_settings WHERE org_id = ?")
      .bind(orgId)
      .first();

    if (row?.mode === AI_MODE_DISABLED) {
      return { status: "disabled", mode: AI_MODE_DISABLED };
    }
    if (row?.mode && row.mode !== AI_MODE_MANAGED) {
      return { status: "error", mode: AI_MODE_MANAGED, errorCode: "routing_mode_invalid" };
    }
    return { status: "enabled", mode: AI_MODE_MANAGED };
  } catch (error) {
    console.error(JSON.stringify({
      event: "ai_route_lookup_failed",
      orgId,
      error: error instanceof Error ? error.message : String(error),
    }));
    return { status: "error", mode: AI_MODE_MANAGED, errorCode: "routing_lookup_failed" };
  }
}

export async function resolveLlmConfig(env, orgId) {
  const mode = await resolveAiMode(env, orgId);
  return mode.status === "enabled" ? managedLlmConfig(env) : mode;
}
