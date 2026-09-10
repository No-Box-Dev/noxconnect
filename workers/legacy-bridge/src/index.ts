type BridgeEnv = {
  UPSTREAM_ORIGIN: string;
};

export function upstreamRequest(request: Request, upstreamOrigin: string): Request {
  const incoming = new URL(request.url);
  const upstream = new URL(upstreamOrigin);
  upstream.pathname = incoming.pathname;
  upstream.search = incoming.search;

  const headers = new Headers(request.headers);
  headers.delete("CF-Connecting-IP");
  headers.delete("CF-IPCountry");
  headers.delete("CF-Ray");
  headers.delete("CF-Visitor");
  headers.delete("Forwarded");
  headers.delete("X-Forwarded-For");

  const forwarded = new Request(upstream, request);
  return new Request(forwarded, { headers, redirect: "manual" });
}

export function bridgeResponse(response: Response, originalOrigin: string, upstreamOrigin: string): Response {
  const headers = new Headers(response.headers);
  const location = headers.get("Location");
  if (location) {
    const resolved = new URL(location, upstreamOrigin);
    if (resolved.origin === new URL(upstreamOrigin).origin) {
      headers.set("Location", `${originalOrigin}${resolved.pathname}${resolved.search}${resolved.hash}`);
    }
  }
  headers.set("X-NoxConnect-Bridge", "1");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request, env): Promise<Response> {
    const originalOrigin = new URL(request.url).origin;
    const response = await fetch(upstreamRequest(request, env.UPSTREAM_ORIGIN));
    return bridgeResponse(response, originalOrigin, env.UPSTREAM_ORIGIN);
  },
} satisfies ExportedHandler<BridgeEnv>;
