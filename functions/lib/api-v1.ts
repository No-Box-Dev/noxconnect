import { getCtx } from "./db.js";

export const API_VERSION = 1 as const;

type ErrorDetails = Record<string, unknown> | unknown[];
const MAX_LEGACY_ERROR_BYTES = 64 * 1024;

export function v1Response(body: unknown, status = 200, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Content-Type", "application/json");
  responseHeaders.set("Cache-Control", "no-store");
  responseHeaders.set("X-Content-Type-Options", "nosniff");
  responseHeaders.set("Link", '</openapi.json>; rel="service-desc"');
  return new Response(JSON.stringify(body), { status, headers: responseHeaders });
}

export function v1Error(code: string, message: string, status: number, details?: ErrorDetails, headers?: HeadersInit): Response {
  return v1Response({
    apiVersion: API_VERSION,
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
    },
  }, status, headers);
}

/**
 * Apply the API v1 transport contract without buffering or changing the body.
 * This keeps streamed and binary responses intact while ensuring every
 * canonical endpoint advertises the same cache and discovery policy.
 */
export function normalizeV1Response(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Link", '</openapi.json>; rel="service-desc"');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function requireV1Member(context: unknown): Response | null {
  const { orgId, orgLogin } = getCtx(context as Parameters<typeof getCtx>[0]) ?? {};
  if (!orgId || !orgLogin) return v1Error("missing_org_context", "Missing organization context", 400);
  return null;
}

export function requireV1Admin(context: unknown): Response | null {
  const memberError = requireV1Member(context);
  if (memberError) return memberError;
  if (!getCtx(context as Parameters<typeof getCtx>[0]).isAdmin) {
    return v1Error("admin_required", "Only an organization admin can change this resource", 403);
  }
  return null;
}

export async function normalizeLegacyError(response: Response): Promise<Response> {
  if (response.ok) return normalizeV1Response(response);
  const body = await readBoundedJson(response);
  if (body?.apiVersion === API_VERSION && typeof body.error === "object" && body.error !== null) {
    return v1Response(body, response.status, response.headers);
  }
  const message = typeof body?.error === "string" ? body.error : "Request failed";
  const mappedCode = {
    400: "invalid_request",
    401: "unauthorized",
    403: "forbidden",
    404: "not_found",
    405: "method_not_allowed",
    409: "conflict",
    412: "precondition_failed",
    413: "payload_too_large",
    415: "unsupported_media_type",
    422: "validation_failed",
    428: "precondition_required",
    429: "rate_limited",
  }[response.status] ?? "internal_error";
  const code = typeof body?.code === "string" && /^[a-z][a-z0-9_]{1,63}$/.test(body.code)
    ? body.code
    : mappedCode;
  const details = body
    ? Object.fromEntries(Object.entries(body).filter(([key]) => key !== "error" && key !== "code"))
    : undefined;
  return v1Error(
    code,
    message,
    response.status,
    details && Object.keys(details).length ? details : undefined,
    response.headers,
  );
}

async function readBoundedJson(response: Response): Promise<Record<string, unknown> | null> {
  const declaredLength = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_LEGACY_ERROR_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!response.body) return null;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_LEGACY_ERROR_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}
