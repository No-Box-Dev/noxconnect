import { describe, expect, it, vi } from "vitest";
import { onRequest } from "../cues/public/v1/events";

describe("NoxCue stable ingest gateway", () => {
  it("forwards the request through the private service binding", async () => {
    const fetch = vi.fn(async (request: Request) => {
      expect(new URL(request.url).pathname).toBe("/v1/events");
      expect(request.headers.get("X-Nox-Ingest-Key")).toBe("nox_secret_test");
      return Response.json({ accepted: true }, { status: 202 });
    });
    const response = await onRequest({
      env: { NOXCUE_RESPONSE: { fetch } as unknown as Fetcher },
      request: new Request("https://app.unticket.ai/api/cues/public/v1/events", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Nox-Ingest-Key": "nox_secret_test" },
        body: JSON.stringify({ type: "user.active", userId: "user-1" }),
      }),
    });
    expect(response.status).toBe(202);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("returns a retriable response when the service binding is unavailable", async () => {
    const response = await onRequest({
      env: {},
      request: new Request("https://app.unticket.ai/api/cues/public/v1/events", { method: "POST" }),
    });
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(await response.json()).toEqual({ error: "ingest_unavailable" });
  });

  it("normalizes a disconnected local or unhealthy service binding", async () => {
    const response = await onRequest({
      env: {
        NOXCUE_RESPONSE: {
          fetch: vi.fn().mockRejectedValue(new Error("binding unavailable")),
        } as unknown as Fetcher,
      },
      request: new Request("https://app.unticket.ai/api/cues/public/v1/events", { method: "POST" }),
    });
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(await response.json()).toEqual({ error: "ingest_unavailable" });
  });

  it("normalizes a non-JSON binding failure response", async () => {
    const response = await onRequest({
      env: {
        NOXCUE_RESPONSE: {
          fetch: vi.fn().mockResolvedValue(new Response("Worker not found", { status: 503 })),
        } as unknown as Fetcher,
      },
      request: new Request("https://app.unticket.ai/api/cues/public/v1/events", { method: "POST" }),
    });
    expect(response.status).toBe(503);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(await response.json()).toEqual({ error: "ingest_unavailable" });
  });
});
