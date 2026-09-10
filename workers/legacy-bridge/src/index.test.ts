import { describe, expect, it } from "vitest";
import { bridgeResponse, upstreamRequest } from "./index";

describe("legacy bridge", () => {
  it("forwards only the path, query, method, and bounded request body", async () => {
    const request = new Request("https://app.noxhere.com/api/v1/services?org=acme", {
      method: "POST",
      headers: { Authorization: "Bearer opaque", "CF-Connecting-IP": "203.0.113.5" },
      body: "{}",
    });
    const upstream = upstreamRequest(request, "https://noxconnect.pages.dev");

    expect(upstream.url).toBe("https://noxconnect.pages.dev/api/v1/services?org=acme");
    expect(upstream.method).toBe("POST");
    expect(upstream.headers.get("Authorization")).toBe("Bearer opaque");
    expect(upstream.headers.get("CF-Connecting-IP")).toBeNull();
    await expect(upstream.text()).resolves.toBe("{}");
  });

  it("rewrites only same-upstream redirects back to the public NoxHere origin", () => {
    const response = bridgeResponse(
      new Response(null, { status: 302, headers: { Location: "https://noxconnect.pages.dev/?login=ok" } }),
      "https://app.noxhere.com",
      "https://noxconnect.pages.dev",
    );
    expect(response.headers.get("Location")).toBe("https://app.noxhere.com/?login=ok");
    expect(response.headers.get("X-NoxConnect-Bridge")).toBe("1");
  });

  it("does not rewrite third-party redirects", () => {
    const response = bridgeResponse(
      new Response(null, { status: 302, headers: { Location: "https://github.com/login/oauth/authorize" } }),
      "https://app.noxhere.com",
      "https://noxconnect.pages.dev",
    );
    expect(response.headers.get("Location")).toBe("https://github.com/login/oauth/authorize");
  });
});
