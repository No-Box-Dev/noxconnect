export function onRequestGet(): Response {
  return Response.json(
    { service: "noxconnect", status: "ok" },
    { headers: { "Cache-Control": "no-store" } },
  );
}
