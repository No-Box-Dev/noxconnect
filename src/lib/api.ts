/** Broadcast an error so the UI can show it in a banner. */
export function broadcastError(message: string, status?: number) {
  window.dispatchEvent(
    new CustomEvent("ut:error", { detail: { message, status } }),
  );
}

/** Custom error that preserves HTTP status for downstream handling. */
export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }

  get isUnauthorized() {
    return this.status === 401;
  }

  get isRateLimited() {
    return this.status === 429;
  }
}

/** Returns true if an error should NOT be retried by TanStack Query. */
export function shouldNotRetry(error: unknown): boolean {
  if (error instanceof ApiError) {
    // 401 = stale token, 429/403 = rate limiting surfaced by NoxConnect.
    return error.status === 401 || error.status === 429 || error.status === 403;
  }
  // Network/client errors that indicate auth or rate limit problems.
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return (
      msg.includes("bad credentials") ||
      msg.includes("rate limit") ||
      msg.includes("not authenticated")
    );
  }
  return false;
}

/**
 * Force-logout clears local tenant selection. The actual credential is an
 * HttpOnly cookie and is therefore intentionally inaccessible to JavaScript.
 */
function forceLogout() {
  localStorage.removeItem("ut_token"); // remove credentials left by pre-session releases
  localStorage.removeItem("ut_org");
  // Dispatch event so AuthProvider can react without circular imports
  window.dispatchEvent(new CustomEvent("ut:force-logout"));
}

function cookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const prefix = `${encodeURIComponent(name)}=`;
  const part = document.cookie.split(";").map((value) => value.trim()).find((value) => value.startsWith(prefix));
  return part ? decodeURIComponent(part.slice(prefix.length)) : null;
}

function buildRequestInit(options?: RequestInit): RequestInit {
  const org = localStorage.getItem("ut_org");
  // FormData bodies need the browser to set Content-Type itself so it can
  // include the `boundary=...` parameter. Setting a plain
  // `application/json` here would strip the boundary and the server would
  // read the raw multipart bytes as JSON — reproducibly failing at parse.
  const isFormData =
    typeof FormData !== "undefined" && options?.body instanceof FormData;
  const method = (options?.method ?? "GET").toUpperCase();
  const csrf = !["GET", "HEAD", "OPTIONS"].includes(method) ? cookie("nox_csrf") : null;
  const devToken = import.meta.env.DEV ? import.meta.env.VITE_DEV_TOKEN as string | undefined : undefined;
  return {
    ...options,
    credentials: "same-origin",
    headers: {
      "X-Org": org ?? "",
      ...(csrf ? { "X-CSRF-Token": csrf } : {}),
      ...(devToken ? { Authorization: `Bearer ${devToken}` } : {}),
      ...(isFormData ? {} : { "Content-Type": "application/json" }),
      ...options?.headers,
    },
  };
}

export async function apiFetch(path: string, options?: RequestInit): Promise<Response> {
  return fetch(path, buildRequestInit(options));
}

async function handleResponse<T>(res: Response): Promise<T> {
  if (res.ok) return res.json() as Promise<T>;

  const body = await res.json().catch(() => ({ error: res.statusText }));
  const error = (body as { error?: string | { message?: string } }).error;
  const message = typeof error === "string"
    ? error
    : error?.message ?? `API error: ${res.status}`;

  // Stale / revoked token → force logout so user re-authenticates
  if (res.status === 401) {
    forceLogout();
    broadcastError(message, 401);
    throw new ApiError(message, 401);
  }

  // Rate limited — our server returns 429 with Retry-After header
  if (res.status === 429) {
    const resetHeader = res.headers.get("retry-after");
    const resetInfo = resetHeader
      ? `. Try again in ${resetHeader}s`
      : "";
    const msg = `Rate limit exceeded${resetInfo}`;
    broadcastError(msg, 429);
    throw new ApiError(msg, 429);
  }

  broadcastError(message, res.status);
  throw new ApiError(message, res.status);
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await apiFetch(path);
  return handleResponse<T>(res);
}

export async function apiPut<T>(path: string, data: unknown): Promise<T> {
  const res = await apiFetch(path, {
    method: "PUT",
    body: JSON.stringify(data),
  });
  return handleResponse<T>(res);
}

export async function apiPost<T>(path: string, data?: unknown): Promise<T> {
  const res = await apiFetch(path, {
    method: "POST",
    body: data ? JSON.stringify(data) : undefined,
  });
  return handleResponse<T>(res);
}

export async function apiPatch<T>(path: string, data: unknown): Promise<T> {
  const res = await apiFetch(path, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
  return handleResponse<T>(res);
}

export async function apiDelete<T>(path: string): Promise<T> {
  const res = await apiFetch(path, { method: "DELETE" });
  return handleResponse<T>(res);
}
