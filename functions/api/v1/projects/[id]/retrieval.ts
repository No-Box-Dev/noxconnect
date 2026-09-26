import { errorResponse, getCtx, jsonResponse } from "../../../../lib/db";
import { onRequestGet as searchWorkspace } from "../../../search";

interface Ctx {
  env: { DB: D1Database };
  request: Request;
  params: { id: string };
  data: { orgId: number; orgLogin: string; projectId?: string | null };
}

interface SearchResult {
  id: string;
  kind: "person" | "pull_request" | "issue" | "feature" | "post" | "release_note";
  title: string;
  subtitle: string;
  login: string | null;
}

export async function onRequestGet(context: Ctx): Promise<Response> {
  const { orgLogin, projectId } = getCtx(context);
  if (!projectId || projectId !== String(context.params.id || "")) return errorResponse("Project scope mismatch", 403);
  const incoming = new URL(context.request.url);
  const query = incoming.searchParams.get("q")?.trim() ?? "";
  if (query.length < 2) return jsonResponse([]);

  const searchUrl = new URL(context.request.url);
  searchUrl.pathname = "/api/v1/search";
  searchUrl.search = new URLSearchParams({ q: query, limit: "40" }).toString();
  const response = await searchWorkspace({ ...context, request: new Request(searchUrl, context.request) } as never);
  if (!response.ok) return response;
  const body = await response.json<{ results?: SearchResult[] }>();
  return jsonResponse((body.results ?? []).map((result) => ({
    id: result.id,
    serviceId: serviceForKind(result.kind),
    kind: labelForKind(result.kind),
    title: result.title,
    context: result.subtitle,
    href: hrefForResult(orgLogin, projectId, result),
  })));
}

function serviceForKind(kind: SearchResult["kind"]): "connect" | "ticket" | "feed" {
  if (kind === "person") return "connect";
  if (kind === "feature") return "ticket";
  return "feed";
}

function labelForKind(kind: SearchResult["kind"]): string {
  return ({ person: "Person", pull_request: "Pull request", issue: "Issue", feature: "Feature", post: "Post", release_note: "Release note" })[kind];
}

function hrefForResult(org: string, projectId: string, result: SearchResult): string {
  const base = `/${encodeURIComponent(org)}/${encodeURIComponent(projectId)}`;
  if (result.kind === "person" && result.login) return `${base}/feed/current/${encodeURIComponent(result.login)}`;
  if (result.kind === "feature") return `${base}/ticket/board`;
  if (result.kind === "issue") return `${base}/feed/issues`;
  if (result.kind === "release_note") return `${base}/feed/merged`;
  return `${base}/feed/opened`;
}
