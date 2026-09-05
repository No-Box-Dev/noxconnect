import { describe, expect, it, vi } from "vitest";
import { onRequest } from "../_middleware.js";

describe("asset fallback middleware", () => {
  it("passes through real assets", async () => {
    const response = new Response("export {};", { headers: { "Content-Type": "application/javascript" } });
    const next = vi.fn(async () => response);
    expect(await onRequest({ next })).toBe(response);
  });

  it("turns the SPA HTML fallback into a safe 404", async () => {
    const next = vi.fn(async () => new Response("<html></html>", { headers: { "Content-Type": "text/html" } }));
    const response = await onRequest({ next });
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });
});
