import { errorResponse, jsonResponse } from "../../lib/db.js";
import { getGitHubUserOrganizations, getGitHubUserProfile } from "../../lib/github-user.js";
import { refreshBrowserSession, resolveBrowserSession } from "../../lib/api-auth.js";
import { NativeAuthError, refreshProviderIfNeeded, resolveNativeSession } from "../../lib/native-auth.js";

// GET /api/auth/profile — NoxConnect-owned GitHub identity facade. This route
// is outside the org middleware because native clients need their org list
// before selecting X-Org, so it performs its own bearer validation.
export async function onRequestGet(context) {
  let token = bearerToken(context.request);
  if (token?.startsWith("nox_at_")) {
    let nativeSession;
    try {
      nativeSession = await resolveNativeSession(context.env.DB, context.env.ENCRYPTION_KEY, token);
      if (nativeSession) nativeSession = await refreshProviderIfNeeded(context.env.DB, context.env, nativeSession);
    } catch (error) {
      console.error("[auth/profile] native session lookup failed", error);
      if (error instanceof NativeAuthError) return errorResponse(error.message, error.status);
    }
    if (!nativeSession) return errorResponse("Native session expired; sign in again", 401);
    token = nativeSession.githubToken;
  }
  if (!token) {
    let session;
    try {
      session = await resolveBrowserSession(context.env.DB, context.env.ENCRYPTION_KEY, context.request);
      if (session?.github_token_expires_at && Date.parse(session.github_token_expires_at) <= Date.now() + 60_000) {
        session = await refreshBrowserSession(context.env.DB, context.env, session);
      }
    } catch (error) {
      console.error("[auth/profile] session lookup failed", error);
    }
    if (!session) return errorResponse("Authentication required", 401);
    token = session.githubToken;
  }
  try {
    const scope = new URL(context.request.url).searchParams.get("scope");
    if (scope === "user") return jsonResponse({ user: await getGitHubUserProfile(token) });
    if (scope === "orgs") return jsonResponse({ orgs: await getGitHubUserOrganizations(token) });
    const [user, orgs] = await Promise.all([
      getGitHubUserProfile(token),
      getGitHubUserOrganizations(token),
    ]);
    return jsonResponse({ user, orgs });
  } catch (error) {
    const status = Number(error?.status);
    return errorResponse(
      status === 401 ? "GitHub token is invalid" : "GitHub identity is temporarily unavailable",
      status === 401 ? 401 : status === 403 || status === 429 ? 429 : 502,
    );
  }
}

function bearerToken(request) {
  const header = request.headers.get("Authorization") || "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}
