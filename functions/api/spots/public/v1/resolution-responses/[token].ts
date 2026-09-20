type Context = {
  request: Request;
  env: { NOXSPOT_RESPONSE: Fetcher };
  params: { token: string };
};

export async function onRequestPost(context: Context): Promise<Response> {
  const token = encodeURIComponent(context.params.token);
  const init = {
    method: "POST",
    headers: context.request.headers,
    body: context.request.body,
    duplex: "half",
  } as RequestInit;
  return context.env.NOXSPOT_RESPONSE.fetch(
    new Request(`https://noxspot.internal/api/spots/public/v1/resolution-responses/${token}`, init),
  );
}

export function onRequest(): Response {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}
