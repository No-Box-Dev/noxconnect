import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { apiFetch, apiGet, apiPut, apiPost, ApiError, shouldNotRetry } from "../api";

let storage: Record<string, string> = {};

beforeEach(() => {
  storage = {};

  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage[key] ?? null,
    setItem: (key: string, val: string) => { storage[key] = val; },
    removeItem: (key: string) => { delete storage[key]; },
  });

  // Stub window.dispatchEvent so force-logout doesn't break tests
  vi.stubGlobal("dispatchEvent", vi.fn());
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Server Error",
    json: () => Promise.resolve(body),
    headers: new Headers(),
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("apiFetch", () => {
  it("uses the HttpOnly session and injects only the selected organization", async () => {
    storage.ut_token = "tok123";
    storage.ut_org = "my-org";
    const fn = mockFetch(200, {});

    await apiFetch("/api/test");

    expect(fn).toHaveBeenCalledWith("/api/test", expect.objectContaining({
      headers: expect.objectContaining({
        "X-Org": "my-org",
      }),
      credentials: "same-origin",
    }));
  });

  it("uses empty strings when localStorage is empty", async () => {
    const fn = mockFetch(200, {});

    await apiFetch("/api/test");

    expect(fn).toHaveBeenCalledWith("/api/test", expect.objectContaining({
      headers: expect.objectContaining({
        "X-Org": "",
      }),
    }));
  });

  it("merges caller-provided headers", async () => {
    storage.ut_token = "tok";
    const fn = mockFetch(200, {});

    await apiFetch("/api/test", {
      headers: { "X-Custom": "val" },
    });

    const passedHeaders = fn.mock.calls[0][1].headers;
    expect(passedHeaders["X-Custom"]).toBe("val");
    expect(passedHeaders["Authorization"]).toBeUndefined();
  });

  it("mirrors the CSRF cookie on state-changing requests", async () => {
    document.cookie = "nox_csrf=csrf-123; Path=/";
    const fn = mockFetch(200, {});
    await apiFetch("/api/test", { method: "POST" });
    expect(fn).toHaveBeenCalledWith("/api/test", expect.objectContaining({
      headers: expect.objectContaining({ "X-CSRF-Token": "csrf-123" }),
    }));
  });
});

describe("apiGet", () => {
  it("returns parsed JSON on 200", async () => {
    mockFetch(200, { data: "hello" });
    const result = await apiGet("/api/data");
    expect(result).toEqual({ data: "hello" });
  });

  it("throws with body.error on non-ok response", async () => {
    mockFetch(400, { error: "bad request" });
    await expect(apiGet("/api/data")).rejects.toThrow("bad request");
  });

  it("reads the standardized v1 error message", async () => {
    mockFetch(403, { apiVersion: 1, error: { code: "insufficient_scope", message: "Missing noxfeed:write" } });
    await expect(apiGet("/api/v1/services/noxfeed/config")).rejects.toThrow("Missing noxfeed:write");
  });

  it("throws with status text when body unparseable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      json: () => Promise.reject(new Error("parse fail")),
      headers: new Headers(),
    }));
    await expect(apiGet("/api/data")).rejects.toThrow("Internal Server Error");
  });
});

describe("apiPut", () => {
  it("sends PUT with JSON body", async () => {
    const fn = mockFetch(200, { ok: true });
    await apiPut("/api/config/features", [1, 2]);

    expect(fn).toHaveBeenCalledWith("/api/config/features", expect.objectContaining({
      method: "PUT",
      body: JSON.stringify([1, 2]),
    }));
  });

  it("throws on non-ok", async () => {
    mockFetch(403, { error: "forbidden" });
    await expect(apiPut("/api/x", {})).rejects.toThrow("forbidden");
  });
});

describe("apiPost", () => {
  it("sends POST with JSON body", async () => {
    const fn = mockFetch(200, { ok: true });
    await apiPost("/api/sync", { force: true });

    expect(fn).toHaveBeenCalledWith("/api/sync", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ force: true }),
    }));
  });

  it("omits body when undefined", async () => {
    const fn = mockFetch(200, { ok: true });
    await apiPost("/api/sync");

    expect(fn).toHaveBeenCalledWith("/api/sync", expect.objectContaining({
      method: "POST",
      body: undefined,
    }));
  });
});

describe("401 force-logout", () => {
  it("clears legacy token residue and dispatches ut:force-logout on 401", async () => {
    storage.ut_token = "stale-tok";
    mockFetch(401, { error: "Invalid token" });

    await expect(apiGet("/api/data")).rejects.toThrow("Invalid token");
    expect(storage.ut_token).toBeUndefined();
    expect(dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "ut:force-logout" }),
    );
  });

  it("throws ApiError with status 401", async () => {
    mockFetch(401, { error: "Invalid token" });
    await expect(apiGet("/api/data")).rejects.toMatchObject({
      name: "ApiError",
      status: 401,
    });
  });
});

describe("429 rate limiting", () => {
  it("throws ApiError with status 429", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      json: () => Promise.resolve({ error: "rate limited" }),
      headers: new Headers({ "retry-after": "30" }),
    }));

    await expect(apiGet("/api/data")).rejects.toMatchObject({
      name: "ApiError",
      status: 429,
      message: expect.stringContaining("Try again in 30s"),
    });
  });
});

describe("shouldNotRetry", () => {
  it("returns true for 401 ApiError", () => {
    expect(shouldNotRetry(new ApiError("unauthorized", 401))).toBe(true);
  });

  it("returns true for 429 ApiError", () => {
    expect(shouldNotRetry(new ApiError("rate limited", 429))).toBe(true);
  });

  it("returns true for 403 ApiError", () => {
    expect(shouldNotRetry(new ApiError("forbidden", 403))).toBe(true);
  });

  it("returns true for rate limit Error messages", () => {
    expect(shouldNotRetry(new Error("GitHub API rate limit exceeded"))).toBe(true);
  });

  it("returns false for generic errors", () => {
    expect(shouldNotRetry(new Error("network error"))).toBe(false);
    expect(shouldNotRetry(new ApiError("not found", 404))).toBe(false);
  });
});
