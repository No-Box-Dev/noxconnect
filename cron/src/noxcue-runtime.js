import { createNoxCue } from "@noxcue/sdk/server";

const ENDPOINT = "https://noxcue.internal/v1/events";

function serviceFetch(service) {
  return (input, init) => service.fetch(input instanceof Request ? input : new Request(input, init));
}

function safeOperation(value) {
  return String(value ?? "unknown").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").slice(0, 80) || "unknown";
}

export function isTenantConfigurationFailure(error) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /github api error:\s*(401|403|404)\b/i.test(message);
}

export async function reportNoxCueRuntimeFailure(env, error, options = {}) {
  const key = env.NOXCUE_INGEST_KEY?.trim();
  if (!env.NOXCUE_INGEST || !key) return null;
  const operation = safeOperation(options.operation);
  const errorKind = safeOperation(error?.code ?? error?.name ?? "error");
  try {
    const client = createNoxCue({
      key,
      environment: "production",
      endpoint: ENDPOINT,
      release: env.CF_VERSION_METADATA?.id,
      fetch: serviceFetch(env.NOXCUE_INGEST),
    });
    return await client.error(error, {
      title: options.title ?? `NoxConnect ${operation} failed`,
      message: options.message ?? "A NoxConnect background operation failed and needs attention.",
      component: options.component ?? "noxconnect.cron-worker",
      fingerprint: `noxconnect.runtime|cron-worker|${operation}|${errorKind}`,
      fatal: false,
      unhandled: true,
      attributes: { operation, errorKind },
    });
  } catch (reportingError) {
    console.error("[noxconnect-cron] NoxCue reporting failed:", reportingError?.message ?? reportingError);
    return null;
  }
}
