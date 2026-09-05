import {
  clearSessionCookies,
  parseCookies,
  resolveBrowserSession,
  SESSION_COOKIE,
  sha256,
  validateSessionCsrf,
} from "../../lib/api-auth.js";

export async function onRequestPost(context) {
  const cookies = parseCookies(context.request.headers.get("Cookie") || "");
  const sessionToken = cookies[SESSION_COOKIE];
  if (sessionToken) {
    const session = await resolveBrowserSession(context.env.DB, context.env.ENCRYPTION_KEY, context.request);
    if (!session || !(await validateSessionCsrf(session, context.request))) {
      return new Response(JSON.stringify({ error: "CSRF validation failed" }), {
        status: 403,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }
    const hash = await sha256(sessionToken);
    await context.env.DB.prepare(
      "UPDATE browser_sessions SET revoked_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE token_hash = ?",
    ).bind(hash).run();
  }
  const headers = new Headers({ "Content-Type": "application/json", "Cache-Control": "no-store" });
  for (const cookie of clearSessionCookies()) headers.append("Set-Cookie", cookie);
  return new Response(JSON.stringify({ loggedOut: true }), { headers });
}
