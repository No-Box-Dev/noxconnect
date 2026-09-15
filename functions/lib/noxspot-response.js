const CONTRACT = "noxspot.response";
const VERSION = 1;
const MAX_SLACK_PAYLOAD_BYTES = 64_000;

export async function getNoxSpotIssueResponse(env, capture) {
  const service = requireResponseService(env);
  const response = await service.buildIssueResponse(responseCapture(capture));
  return validateIssueResponse(response);
}

export async function getNoxSpotSlackResponse(env, capture, issue) {
  const service = requireResponseService(env);
  const response = await service.buildSlackResponse(responseCapture(capture), {
    number: issue.number,
    url: issue.html_url,
  });
  return validateSlackResponse(response);
}

export async function getNoxSpotTestResponse(env, orgLogin) {
  const service = requireResponseService(env);
  if (typeof service.buildTestResponse !== "function") {
    throw new Error("NoxSpot test response service binding is unavailable");
  }
  return validateSlackResponse(await service.buildTestResponse(orgLogin));
}

export async function getNoxSpotDailyDigestResponse(env, siteName, period, filed, solved, totals) {
  const service = env?.NOXSPOT_RESPONSE;
  if (!service || typeof service.buildDailyDigestResponse !== "function") {
    throw new Error("NoxSpot daily digest response service binding is unavailable");
  }
  const response = await service.buildDailyDigestResponse(siteName, period, filed, solved, totals);
  return validateSlackResponse(
    response,
  );
}

function requireResponseService(env) {
  const service = env?.NOXSPOT_RESPONSE;
  if (!service || typeof service.buildIssueResponse !== "function" || typeof service.buildSlackResponse !== "function") {
    throw new Error("NoxSpot response service binding is unavailable");
  }
  return service;
}

function responseCapture(capture) {
  return {
    captureId: capture.captureId,
    siteId: capture.siteId,
    siteName: capture.siteName,
    issueType: capture.issueType,
    title: capture.title,
    description: capture.description ?? null,
    reporter: capture.reporter ?? null,
    reporterGithubLogin: capture.reporterGithubLogin ?? null,
    reporterEmail: capture.reporterEmail ?? null,
    environment: capture.environment ?? null,
    screenshotUrl: capture.screenshotUrl ?? null,
    metadata: capture.metadata ?? null,
    elements: capture.elements ?? null,
    context: capture.context ?? null,
    blockValues: capture.blockValues ?? null,
    rating: capture.rating ?? null,
  };
}

function validateIssueResponse(response) {
  requireContract(response);
  const marker = response.idempotencyMarker;
  const issue = response.issue;
  if (typeof marker !== "string" || !/^<!-- noxspot:[^<>]{1,160} -->$/.test(marker)) {
    throw new Error("Invalid NoxSpot response idempotency marker");
  }
  if (!plainObject(issue) || typeof issue.title !== "string" || !issue.title || issue.title.length > 256) {
    throw new Error("Invalid NoxSpot issue title");
  }
  if (typeof issue.body !== "string" || issue.body.length > 65_536 || !issue.body.includes(marker)) {
    throw new Error("Invalid NoxSpot issue body");
  }
  if (!Array.isArray(issue.labels) || issue.labels.length < 1 || issue.labels.length > 10) {
    throw new Error("Invalid NoxSpot issue labels");
  }
  for (const label of issue.labels) {
    if (!plainObject(label) || typeof label.name !== "string" || !label.name || label.name.length > 50 ||
        typeof label.color !== "string" || !/^[0-9a-f]{6}$/i.test(label.color) ||
        typeof label.description !== "string" || label.description.length > 100) {
      throw new Error("Invalid NoxSpot issue label definition");
    }
  }
  return response;
}

function validateSlackResponse(response) {
  requireContract(response);
  const message = response.message;
  if (!plainObject(message) || typeof message.text !== "string" || !message.text || message.text.length > 4_000 ||
      !Array.isArray(message.blocks) || message.blocks.length < 1 || message.blocks.length > 50) {
    throw new Error("Invalid NoxSpot Slack message");
  }
  let serialized;
  try { serialized = JSON.stringify(message); }
  catch { throw new Error("Invalid NoxSpot Slack message"); }
  if (new TextEncoder().encode(serialized).byteLength > MAX_SLACK_PAYLOAD_BYTES) {
    throw new Error("NoxSpot Slack message is too large");
  }
  return response;
}

function requireContract(response) {
  if (!plainObject(response) || response.contract !== CONTRACT || response.version !== VERSION) {
    throw new Error("Unsupported NoxSpot response contract");
  }
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
