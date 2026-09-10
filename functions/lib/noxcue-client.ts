import { createNoxCue } from "@noxcue/sdk/server";

interface NoxCueEnv {
  NOXCUE_INGEST?: Fetcher;
  NOXCUE_INGEST_KEY?: string;
}

interface NoxCueContext {
  env: NoxCueEnv;
  request: Request;
  waitUntil?: (promise: Promise<unknown>) => void;
}

const NOXCUE_ENDPOINT = "https://noxcue.internal/v1/events";
const NOXCUE_PUBLIC_INGEST_PATHS = new Set([
  "/api/cues/public/v1/events",
  "/api/v1/cues/public/events",
]);

function serviceFetch(service: Fetcher): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    return service.fetch(request);
  }) as typeof fetch;
}

export function createNoxCueServer(env: NoxCueEnv, key = env.NOXCUE_INGEST_KEY?.trim()) {
  if (!env.NOXCUE_INGEST || !key) return null;
  return createNoxCue({
    key,
    environment: "production",
    endpoint: NOXCUE_ENDPOINT,
    fetch: serviceFetch(env.NOXCUE_INGEST),
  });
}

export function normalizedIncidentRoute(pathname: string): string {
  return pathname
    .replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,}(?=\/|$)/gi, "/:id")
    .replace(/\/[0-9a-f]{32,}(?=\/|$)/gi, "/:id")
    .replace(/\/\d+(?=\/|$)/g, "/:id")
    .slice(0, 160);
}

export function reportNoxCueHttpFailure(
  context: NoxCueContext,
  error: unknown,
  status?: number,
): Promise<unknown> | null {
  const url = new URL(context.request.url);
  if (NOXCUE_PUBLIC_INGEST_PATHS.has(url.pathname)) return null;
  const client = createNoxCueServer(context.env);
  if (!client) return null;
  const route = normalizedIncidentRoute(url.pathname);
  const method = context.request.method.toUpperCase();
  const evidence = error ?? Object.assign(new Error(`HTTP ${status ?? 500} returned by the API handler`), {
    name: "HTTPResponseError",
    code: `HTTP_${status ?? 500}`,
    status: status ?? 500,
  });
  const delivery = client.error(evidence, {
    title: `NoxConnect ${method} ${route} failed`,
    message: "A NoxConnect API request returned an unexpected server error.",
    component: "noxconnect.pages-api",
    fingerprint: `noxconnect.http|${method}|${route}|${status ?? "exception"}`,
    url: `${url.origin}${url.pathname}`,
    fatal: false,
    unhandled: true,
    attributes: { method, route, ...(status === undefined ? {} : { status }) },
  });
  try { context.waitUntil?.(delivery); } catch { /* reporting must not affect the request */ }
  return delivery;
}
