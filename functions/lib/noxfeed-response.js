const CONTRACT = "noxfeed.response";
const VERSION = 1;
const MAX_SLACK_PAYLOAD_BYTES = 64_000;

export async function generateNoxFeedContent(env, kind, input, systemOverride) {
  const service = requireMethod(env, "generate");
  const response = await service.generate(kind, input, systemOverride);
  requireContract(response);
  const generation = response.generation;
  if (!plainObject(generation) || !["generated", "unavailable"].includes(generation.status) ||
      typeof generation.model !== "string" || !generation.model || generation.model.length > 200) {
    throw new Error("Invalid NoxFeed generation response");
  }
  if (generation.status === "unavailable") {
    if (typeof generation.errorCode !== "string" || !generation.errorCode || generation.errorCode.length > 200) {
      throw new Error("Invalid NoxFeed unavailable response");
    }
    return generation;
  }
  if (!plainObject(generation.output) || typeof generation.output.summary !== "string" ||
      !generation.output.summary || generation.output.summary.length > 2_400) {
    throw new Error("Invalid NoxFeed generated output");
  }
  if (kind !== "release_notes" && (typeof generation.output.technicalSummary !== "string" ||
      !generation.output.technicalSummary || generation.output.technicalSummary.length > 1_200)) {
    throw new Error("Invalid NoxFeed technical output");
  }
  return generation;
}

export async function getNoxFeedGenerationInfo(env) {
  const service = requireMethod(env, "generationInfo");
  const response = await service.generationInfo();
  requireContract(response);
  if (typeof response.model !== "string" || !response.model || response.model.length > 200 ||
      typeof response.provider !== "string" || !response.provider || response.provider.length > 100 ||
      typeof response.available !== "boolean") {
    throw new Error("Invalid NoxFeed generation info");
  }
  return { model: response.model, provider: response.provider, available: response.available };
}

export async function getNoxFeedDefaultPrompt(env, kind) {
  const service = requireMethod(env, "getDefaultPrompt");
  const response = await service.getDefaultPrompt(kind);
  requireContract(response);
  const system = response?.prompt?.system;
  if (typeof system !== "string" || !system || system.length > 20_000) {
    throw new Error("Invalid NoxFeed default prompt response");
  }
  return system;
}

export async function getNoxFeedSlackResponse(env, kind, input) {
  const service = requireMethod(env, "buildSlackResponse");
  return validateSlack(await service.buildSlackResponse(kind, input));
}

export async function getNoxFeedTestResponse(env, orgLogin, stream) {
  const service = requireMethod(env, "buildTestResponse");
  return validateSlack(await service.buildTestResponse(orgLogin, stream));
}

function requireMethod(env, method) {
  const service = env?.NOXFEED_RESPONSE;
  if (!service || typeof service[method] !== "function") {
    throw new Error(`NoxFeed ${method} service binding is unavailable`);
  }
  return service;
}

function validateSlack(response) {
  requireContract(response);
  const message = response.message;
  if (!plainObject(message) || typeof message.text !== "string" || !message.text || message.text.length > 4_000 || !Array.isArray(message.blocks) || message.blocks.length < 1 || message.blocks.length > 50) {
    throw new Error("Invalid NoxFeed Slack message");
  }
  if (new TextEncoder().encode(JSON.stringify(message)).byteLength > MAX_SLACK_PAYLOAD_BYTES) throw new Error("NoxFeed Slack message is too large");
  return response;
}

function requireContract(response) {
  if (!plainObject(response) || response.contract !== CONTRACT || response.version !== VERSION) throw new Error("Unsupported NoxFeed response contract");
}

function plainObject(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
