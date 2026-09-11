import {
  checkSlackOrgHealth,
  exchangeOAuthCode,
  resolveSlackOAuthRedirectUri,
  saveSlackInstall,
  verifyOAuthState,
} from "../../../lib/slack";
import { requeueBlockedForOrg } from "../../../lib/delivery-outbox.js";

// GET /api/slack/oauth/callback?code=...&state=...
//
// Bypassed by the auth middleware (browser redirect from Slack carries no
// Authorization header). Verifies state against the ut_slack_state cookie
// (set by /start), exchanges the code, persists the bot token. On success
// or failure we redirect back to /?slack=ok|error so the SPA can refresh
// the Slack section.
export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const errorParam = url.searchParams.get("error");

  // User cancelled in Slack's confirm screen — just send them home.
  if (errorParam) {
    return redirectHome(url, "cancelled");
  }

  if (!code || !state) return redirectHome(url, "missing-code-or-state");

  const cookies = parseCookies(context.request.headers.get("Cookie") || "");
  const cookieState = cookies["ut_slack_state"] || "";
  if (!cookieState || cookieState !== state) {
    return redirectHome(url, "csrf");
  }

  const clientId = context.env.SLACK_CLIENT_ID;
  const clientSecret = context.env.SLACK_CLIENT_SECRET;
  if (!clientId || !clientSecret) return redirectHome(url, "app-not-configured");

  // Verify the HMAC on the state BEFORE trusting any embedded orgId. The
  // cookie comparison above is the CSRF gate; this is defense-in-depth
  // against a client managing to craft a matching state+cookie pair.
  const verified = await verifyOAuthState(clientSecret, state);
  if (!verified) return redirectHome(url, "bad-state");
  const { orgId, userLogin: rawUser, projectId: rawProject } = verified;
  const userLogin = rawUser ? decodeURIComponent(rawUser) : "";
  const projectId = rawProject ? decodeURIComponent(rawProject) : null;

  if (projectId) {
    // OAuth state carries the organization id but projects use the GitHub
    // organization login as owner. Resolve that server-side before accepting
    // the assignment; never trust a project id from the browser alone.
    const ownedProject = await context.env.DB.prepare(
      `SELECT project.id FROM projects project
       JOIN orgs org ON org.github_login = project.owner_id
       JOIN project_routing_settings routing
         ON routing.project_id = project.id AND routing.org_id = org.id
       WHERE project.id = ? AND org.id = ? AND routing.enabled = 1
         AND COALESCE(project.archived, 0) = 0`,
    ).bind(projectId, orgId).first();
    if (!ownedProject) return redirectHome(url, "project-not-found");
  }

  let install;
  try {
    install = await exchangeOAuthCode({
      clientId,
      clientSecret,
      code,
      redirectUri: resolveSlackOAuthRedirectUri(),
    });
  } catch (err) {
    console.error("[noxconnect slack oauth] exchange failed:", err?.message ?? err);
    return redirectHome(url, "exchange-failed");
  }

  try {
    const connectionId = await saveSlackInstall(
      context.env,
      orgId,
      { ...install, installedBy: userLogin },
      projectId,
    );
    // Validate the new token immediately. The redirect target can now render
    // authoritative health instead of the previous install's cached result.
    const health = await checkSlackOrgHealth(context.env, orgId, connectionId);
    if (health.status === "ok") {
      await requeueBlockedForOrg(context.env, orgId).catch((error) => {
        console.error("[noxconnect slack oauth] delivery replay failed:", error?.message ?? error);
      });
    }
  } catch (err) {
    console.error("[noxconnect slack oauth] persist failed:", err?.message ?? err);
    return redirectHome(url, "persist-failed");
  }

  return redirectHome(url, "ok");
}

function redirectHome(url, status) {
  return new Response(null, {
    status: 302,
    headers: {
      Location: `${url.origin}/?tab=admin&slack=${encodeURIComponent(status)}`,
      "Cache-Control": "no-store",
      // Always clear the CSRF cookie even on failure paths.
      "Set-Cookie": "ut_slack_state=; Path=/; Max-Age=0; SameSite=Lax; Secure; HttpOnly",
    },
  });
}

function parseCookies(cookieHeader) {
  const cookies = {};
  for (const pair of cookieHeader.split(";")) {
    const [key, ...rest] = pair.trim().split("=");
    if (!key) continue;
    cookies[key.trim()] = rest.join("=").trim();
  }
  return cookies;
}
