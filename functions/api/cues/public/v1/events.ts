interface NoxCueIngestContext {
  env: { NOXCUE_RESPONSE?: Fetcher };
  request: Request;
}

function unavailableResponse(): Response {
  return Response.json(
    { error: "ingest_unavailable" },
    {
      status: 503,
      headers: {
        "Cache-Control": "no-store",
        "Retry-After": "60",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

// Stable same-origin public entry point. NoxCue still owns authentication,
// validation, rate limiting, deduplication, and storage behind the binding.
export async function onRequest(context: NoxCueIngestContext): Promise<Response> {
  const service = context.env.NOXCUE_RESPONSE;
  if (!service) return unavailableResponse();

  const upstreamUrl = new URL(context.request.url);
  upstreamUrl.pathname = "/v1/events";
  const requestInit: RequestInit & { duplex: "half" } = {
    method: context.request.method,
    headers: context.request.headers,
    body: context.request.method === "GET" || context.request.method === "HEAD" ? null : context.request.body,
    redirect: context.request.redirect,
    // Required by Node's Request implementation in tests; ignored by workerd.
    duplex: "half",
  };
  const upstreamRequest = new Request(upstreamUrl, requestInit);
  try {
    const response = await service.fetch(upstreamRequest);
    const contentType = response.headers.get("Content-Type") ?? "";
    if (response.status >= 500 && !contentType.includes("application/json")) {
      return unavailableResponse();
    }
    return response;
  } catch {
    return unavailableResponse();
  }
}
