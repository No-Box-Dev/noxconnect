import { decryptToken } from "./crypto.js";

const APPLE_API_ORIGIN = "https://api.appstoreconnect.apple.com";
const MAX_JSON_BYTES = 1_000_000;
const MAX_SEGMENT_BYTES = 8_000_000;
const MAX_DECOMPRESSED_BYTES = 32_000_000;
const MAX_INSTANCE_BATCHES_PER_SYNC = 8;

const REPORT_KINDS = [
  { key: "downloads", includes: ["app store downloads"] },
  { key: "installs", includes: ["app store installations and deletions"] },
  { key: "sessions", includes: ["app sessions"] },
  { key: "crashes", includes: ["app crashes"] },
];

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function encodeJson(value) {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function decodePem(privateKey) {
  const body = privateKey
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s/g, "");
  if (!body || !/^[A-Za-z0-9+/=]+$/.test(body)) throw new Error("Invalid App Store Connect private key");
  const binary = atob(body);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export async function createAppStoreConnectToken({ issuerId, keyId, privateKey, now = Date.now() }) {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    decodePem(privateKey),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const issuedAt = Math.floor(now / 1_000);
  const header = encodeJson({ alg: "ES256", kid: keyId, typ: "JWT" });
  const claims = encodeJson({ iss: issuerId, iat: issuedAt, exp: issuedAt + 600, aud: "appstoreconnect-v1" });
  const signingInput = `${header}.${claims}`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
}

async function readLimited(stream, maxBytes) {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error("App Store Connect response exceeded the size limit");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function jsonFromResponse(response) {
  const bytes = await readLimited(response.body, MAX_JSON_BYTES);
  if (bytes.byteLength === 0) return {};
  return JSON.parse(new TextDecoder().decode(bytes));
}

function appleError(status, payload) {
  const first = Array.isArray(payload?.errors) ? payload.errors[0] : null;
  const detail = first?.detail || first?.title;
  return new Error(detail ? `App Store Connect (${status}): ${String(detail).slice(0, 300)}` : `App Store Connect request failed (${status})`);
}

export async function appStoreConnectRequest(credentials, path, options = {}) {
  const url = new URL(path, APPLE_API_ORIGIN);
  if (url.origin !== APPLE_API_ORIGIN) throw new Error("Invalid App Store Connect API URL");
  const token = await createAppStoreConnectToken(credentials);
  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    redirect: "error",
  });
  const payload = await jsonFromResponse(response);
  if (!response.ok) throw appleError(response.status, payload);
  return payload;
}

async function collectPages(credentials, path, maxPages = 5) {
  const items = [];
  let next = path;
  for (let page = 0; next && page < maxPages; page += 1) {
    const payload = await appStoreConnectRequest(credentials, next);
    if (Array.isArray(payload.data)) items.push(...payload.data);
    const nextUrl = payload?.links?.next;
    if (!nextUrl) break;
    const parsed = new URL(nextUrl);
    if (parsed.origin !== APPLE_API_ORIGIN) throw new Error("App Store Connect returned an invalid pagination URL");
    next = parsed.href;
  }
  return items;
}

export async function connectAppleAnalytics(credentials, appId) {
  await appStoreConnectRequest(credentials, `/v1/apps/${encodeURIComponent(appId)}`);
  const requests = await collectPages(
    credentials,
    `/v1/apps/${encodeURIComponent(appId)}/analyticsReportRequests?filter%5BaccessType%5D=ONGOING&limit=200`,
    2,
  );
  const existing = requests.find((item) => item?.attributes?.accessType === "ONGOING");
  if (existing?.id) return { reportRequestId: String(existing.id), created: false };

  const created = await appStoreConnectRequest(credentials, "/v1/analyticsReportRequests", {
    method: "POST",
    body: {
      data: {
        type: "analyticsReportRequests",
        attributes: { accessType: "ONGOING" },
        relationships: { app: { data: { type: "apps", id: appId } } },
      },
    },
  });
  if (!created?.data?.id) throw new Error("App Store Connect did not return a report request ID");
  return { reportRequestId: String(created.data.id), created: true };
}

function reportKind(name) {
  const normalized = String(name ?? "").toLowerCase();
  if (normalized.includes("context")) return null;
  return REPORT_KINDS.find((candidate) => candidate.includes.every((part) => normalized.includes(part)))?.key ?? null;
}

function reportPreference(name) {
  const normalized = String(name ?? "").toLowerCase();
  if (normalized.includes("detailed")) return 0;
  if (normalized.includes("standard") || normalized.includes("summary")) return 2;
  return 1;
}

export function selectAppleReports(reports) {
  const selected = new Map();
  for (const report of reports) {
    const kind = reportKind(report?.attributes?.name);
    if (!kind || !report?.id) continue;
    const current = selected.get(kind);
    if (!current || reportPreference(report.attributes.name) > reportPreference(current.attributes?.name)) {
      selected.set(kind, report);
    }
  }
  return [...selected.entries()].map(([kind, report]) => ({ kind, id: String(report.id), name: String(report.attributes?.name ?? "") }));
}

export function parseDelimited(text) {
  const firstLineEnd = text.search(/[\r\n]/);
  const headerText = firstLineEnd === -1 ? text : text.slice(0, firstLineEnd);
  const delimiter = headerText.includes("\t") ? "\t" : ",";
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"') quoted = true;
    else if (character === delimiter) {
      row.push(field);
      field = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field);
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      field = "";
    } else field += character;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  if (rows.length < 2) return [];
  const headers = rows[0].map((value) => value.replace(/^\uFEFF/, "").trim());
  return rows.slice(1).map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
}

function numberField(row, key) {
  const value = Number(row[key]);
  return Number.isFinite(value) ? value : 0;
}

export function aggregateAppleRows(kind, rows, appId) {
  const periods = new Map();
  for (const row of rows) {
    if (String(row["App Apple Identifier"] ?? "") !== appId) continue;
    const period = String(row.Date ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(period)) continue;
    const metrics = periods.get(period) ?? {};
    if (kind === "downloads") {
      const count = numberField(row, "Counts");
      metrics["apple.downloads.total"] = (metrics["apple.downloads.total"] ?? 0) + count;
      const type = String(row["Download Type"] ?? "").toLowerCase();
      if (type === "first-time download") {
        metrics["apple.downloads.first_time"] = (metrics["apple.downloads.first_time"] ?? 0) + count;
      } else if (type === "redownload") {
        metrics["apple.downloads.redownloads"] = (metrics["apple.downloads.redownloads"] ?? 0) + count;
      }
    } else if (kind === "installs") {
      const count = numberField(row, "Counts");
      const event = String(row.Event ?? "").toLowerCase();
      if (event === "install") metrics["apple.installations"] = (metrics["apple.installations"] ?? 0) + count;
      if (event === "delete") metrics["apple.deletions"] = (metrics["apple.deletions"] ?? 0) + count;
    } else if (kind === "sessions") {
      metrics["apple.sessions"] = (metrics["apple.sessions"] ?? 0) + numberField(row, "Sessions");
    } else if (kind === "crashes") {
      metrics["apple.crashes"] = (metrics["apple.crashes"] ?? 0) + numberField(row, "Crashes");
    }
    periods.set(period, metrics);
  }
  return [...periods.entries()].filter(([, metrics]) => Object.keys(metrics).length > 0)
    .map(([period, metrics]) => ({ period, metrics }));
}

async function downloadSegment(url, expectedSize) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error("App Store Connect returned an insecure segment URL");
  if (Number.isFinite(expectedSize) && expectedSize > MAX_SEGMENT_BYTES) {
    throw new Error("App Store Connect segment exceeded the size limit");
  }
  const response = await fetch(parsed, { redirect: "error" });
  if (!response.ok) throw new Error(`App Store Connect segment download failed (${response.status})`);
  const compressed = await readLimited(response.body, MAX_SEGMENT_BYTES);
  if (Number.isFinite(expectedSize) && compressed.byteLength !== expectedSize) {
    throw new Error("App Store Connect segment size verification failed");
  }
  const isGzip = compressed[0] === 0x1f && compressed[1] === 0x8b;
  if (!isGzip) return new TextDecoder().decode(compressed);
  const decompressed = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new TextDecoder().decode(await readLimited(decompressed, MAX_DECOMPRESSED_BYTES));
}

export async function syncAppleAnalyticsConnection(env, connection) {
  const credentials = {
    issuerId: connection.issuer_id,
    keyId: connection.key_id,
    privateKey: await decryptToken(connection.encrypted_private_key, env.ENCRYPTION_KEY),
  };
  const reports = selectAppleReports(await collectPages(
    credentials,
    `/v1/analyticsReportRequests/${encodeURIComponent(connection.report_request_id)}/reports?limit=200`,
  ));
  let processed = 0;
  let latestPeriod = connection.last_successful_period ?? null;

  for (const report of reports) {
    const instances = await collectPages(
      credentials,
      `/v1/analyticsReports/${encodeURIComponent(report.id)}/instances?filter%5Bgranularity%5D=DAILY&limit=200`,
      3,
    );
    for (const instance of instances) {
      if (processed >= MAX_INSTANCE_BATCHES_PER_SYNC) break;
      const instanceId = String(instance?.id ?? "");
      if (!instanceId) continue;
      const alreadyProcessed = await env.DB.prepare(
        "SELECT 1 AS present FROM cue_apple_processed_instances WHERE source_id = ? AND instance_id = ?",
      ).bind(connection.source_id, instanceId).first();
      if (alreadyProcessed) continue;

      const segments = await collectPages(
        credentials,
        `/v1/analyticsReportInstances/${encodeURIComponent(instanceId)}/segments?limit=200`,
        3,
      );
      const rows = [];
      for (const segment of segments) {
        const url = segment?.attributes?.url;
        if (typeof url === "string") {
          rows.push(...parseDelimited(await downloadSegment(url, Number(segment?.attributes?.sizeInBytes))));
        }
      }
      const values = aggregateAppleRows(report.kind, rows, String(connection.app_id));
      if (values.length > 0) {
        for (let offset = 0; offset < values.length; offset += 62) {
          await env.NOXCUE_RESPONSE.ingestAppleAnalyticsBatch({
            version: 1,
            provider: "apple-app-store-connect",
            organizationId: Number(connection.org_id),
            sourceId: connection.source_id,
            batchId: `apple:${report.id}:${instanceId}:${Math.floor(offset / 62)}`,
            values: values.slice(offset, offset + 62),
          });
        }
        for (const value of values) {
          if (!latestPeriod || value.period > latestPeriod) latestPeriod = value.period;
        }
      }
      await env.DB.prepare(
        `INSERT OR IGNORE INTO cue_apple_processed_instances
           (source_id, report_id, instance_id, processing_date)
         VALUES (?, ?, ?, ?)`,
      ).bind(connection.source_id, report.id, instanceId, instance?.attributes?.processingDate ?? null).run();
      processed += 1;
    }
    if (processed >= MAX_INSTANCE_BATCHES_PER_SYNC) break;
  }

  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE cue_apple_connections
        SET status = ?, last_synced_at = ?, last_successful_period = ?, last_error = NULL, updated_at = ?
      WHERE source_id = ?`,
  ).bind(reports.length > 0 ? "active" : "waiting_for_reports", now, latestPeriod, now, connection.source_id).run();
  return { processed, reportCount: reports.length, lastSuccessfulPeriod: latestPeriod };
}

export async function syncAppleAnalyticsSource(env, sourceId) {
  const connection = await env.DB.prepare(
    "SELECT * FROM cue_apple_connections WHERE source_id = ?",
  ).bind(sourceId).first();
  if (!connection) throw new Error("Apple analytics connection not found");
  try {
    return await syncAppleAnalyticsConnection(env, connection);
  } catch (error) {
    await env.DB.prepare(
      `UPDATE cue_apple_connections
          SET status = 'error', last_synced_at = ?, last_error = ?, updated_at = ?
        WHERE source_id = ?`,
    ).bind(
      new Date().toISOString(), error instanceof Error ? error.message.slice(0, 500) : "Apple analytics sync failed",
      new Date().toISOString(), sourceId,
    ).run();
    throw error;
  }
}

export async function syncDueAppleAnalytics(env) {
  const result = await env.DB.prepare(
    `SELECT * FROM cue_apple_connections
      WHERE last_synced_at IS NULL OR last_synced_at <= datetime('now', '-6 hours')
      ORDER BY COALESCE(last_synced_at, created_at)
      LIMIT 3`,
  ).all();
  const outcomes = [];
  for (const connection of result.results ?? []) {
    try {
      outcomes.push({ sourceId: connection.source_id, ...(await syncAppleAnalyticsConnection(env, connection)) });
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : "Apple analytics sync failed";
      await env.DB.prepare(
        `UPDATE cue_apple_connections
            SET status = 'error', last_synced_at = ?, last_error = ?, updated_at = ?
          WHERE source_id = ?`,
      ).bind(new Date().toISOString(), message, new Date().toISOString(), connection.source_id).run();
      outcomes.push({ sourceId: connection.source_id, error: message });
    }
  }
  return outcomes;
}
