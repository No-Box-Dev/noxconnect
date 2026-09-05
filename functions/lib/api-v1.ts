import { getCtx } from "./db.js";

export const API_VERSION = 1 as const;

type ErrorDetails = Record<string, unknown> | unknown[];

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
  if (response.ok) return response;
  const body = await response.clone().json().catch(() => null) as Record<string, unknown> | null;
  const message = typeof body?.error === "string" ? body.error : "Request failed";
  const code = {
    400: "invalid_request",
    401: "unauthorized",
    403: "forbidden",
    404: "not_found",
    409: "conflict",
    412: "precondition_failed",
    413: "payload_too_large",
    422: "validation_failed",
    428: "precondition_required",
  }[response.status] ?? "internal_error";
  const details = body ? Object.fromEntries(Object.entries(body).filter(([key]) => key !== "error")) : undefined;
  return v1Error(code, message, response.status, details && Object.keys(details).length ? details : undefined);
}
