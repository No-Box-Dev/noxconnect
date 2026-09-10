const CONTRACT = "noxcue.response";
const VERSION = 1;
const MAX_SLACK_PAYLOAD_BYTES = 64_000;

export async function getNoxCueTestResponse(env, orgLogin) {
  const service = env?.NOXCUE_RESPONSE;
  if (!service || typeof service.buildTestResponse !== "function") {
    throw new Error("NoxCue response service binding is unavailable");
  }
  return validateResponse(await service.buildTestResponse(orgLogin));
}

export async function getNoxCueDigestResponse(env, sourceName, period, metrics, comparisons = {}, metricLabels = {}, scope) {
  const service = env?.NOXCUE_RESPONSE;
  if (!service || typeof service.buildDigestResponse !== "function") {
    throw new Error("NoxCue response service binding is unavailable");
  }
  const response = validateResponse(await service.buildDigestResponse(sourceName, period, metrics, comparisons, metricLabels, scope));
  if (response.kind !== "daily_digest") throw new Error("Invalid NoxCue digest response");
  return response;
}

function validateResponse(response) {
  if (!plainObject(response) || response.contract !== CONTRACT || response.version !== VERSION) {
    throw new Error("Unsupported NoxCue response contract");
  }
  const message = response.message;
  if (!plainObject(message) || typeof message.text !== "string" || !message.text || message.text.length > 4_000 ||
      !Array.isArray(message.blocks) || message.blocks.length < 1 || message.blocks.length > 50) {
    throw new Error("Invalid NoxCue Slack message");
  }
  let serialized;
  try { serialized = JSON.stringify(message); }
  catch { throw new Error("Invalid NoxCue Slack message"); }
  if (new TextEncoder().encode(serialized).byteLength > MAX_SLACK_PAYLOAD_BYTES) {
    throw new Error("NoxCue Slack message is too large");
  }
  return response;
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
