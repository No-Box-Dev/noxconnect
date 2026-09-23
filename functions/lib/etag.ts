/**
 * Conditional-request helpers shared by every revisioned endpoint.
 *
 * We emit strong ETags, but Cloudflare rewrites them to the weak form
 * (`W/"…"`) whenever it compresses the response, and a browser echoes back
 * exactly what it was given. A parser that only understood the strong form
 * therefore rejected the client's own unmodified revision with 412.
 */
export function quotedEtag(revision: string) {
  return `"${revision}"`;
}

export function ifMatchRevision(request: Request): string | null {
  const value = request.headers.get("If-Match")?.trim();
  if (!value) return null;
  const tag = value.startsWith("W/") ? value.slice(2).trim() : value;
  return tag.startsWith('"') && tag.endsWith('"') ? tag.slice(1, -1) : tag;
}
