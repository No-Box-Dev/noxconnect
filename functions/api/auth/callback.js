import { saveOAuthTokens } from "../../lib/oauth-tokens";
import { createBrowserSession, sessionCookies } from "../../lib/api-auth.js";

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const code = url.searchParams.get("code");
  const setupAction = url.searchParams.get("setup_action");

  // GitHub App post-install redirect: no OAuth state, just installation_id +
  // setup_action=install. The installation itself fires an `installation`
  // webhook that captures repos_json; here we only need to bounce the user
  // back into the app.
  if (setupAction === "install" || setupAction === "update") {
    return new Response(null, {
      status: 302,
      headers: {
        Location: `${url.origin}/?install=ok`,
        "Cache-Control": "no-store",
      },
    });
  }

  if (!code) {
    return new Response(JSON.stringify({ error: "Missing code" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const clientId = context.env.GITHUB_APP_CLIENT_ID;
  const clientSecret = context.env.GITHUB_APP_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return new Response(JSON.stringify({ error: "OAuth not configured" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  // --- Server-side CSRF validation ---
  // The client sets a cookie `ut_oauth_state` before redirecting to GitHub.
  // GitHub sends the same state back as a query param. We compare both.
  const stateParam = url.searchParams.get("state") || "";
  const cookies = parseCookies(context.request.headers.get("Cookie") || "");
  const stateCookie = cookies["ut_oauth_state"] || "";

  if (!stateParam || !stateCookie || stateParam !== stateCookie) {
    return new Response(JSON.stringify({ error: "OAuth state mismatch — possible CSRF attack" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Exchange code for token with GitHub
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
    }),
  });

  if (!tokenRes.ok) {
    console.error("[noxconnect oauth] token exchange returned", tokenRes.status);
    return new Response(JSON.stringify({ error: "Authentication service temporarily unavailable" }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }

  let data;
  try {
    data = await tokenRes.json();
  } catch (e) {
    console.error("[noxconnect oauth] token exchange returned non-JSON:", e);
    return new Response(JSON.stringify({ error: "Authentication service returned invalid response" }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (data.error) {
    return new Response(JSON.stringify({ error: data.error_description }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!data.access_token) {
    return new Response(JSON.stringify({ error: "OAuth response missing access token" }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }

  const encryptionKey = context.env.ENCRYPTION_KEY;
  if (!encryptionKey) return jsonError("Authentication service is not configured", 500);

  // Resolve identity before creating a NoxConnect session. The browser never
  // receives the provider access token; it receives only an opaque HttpOnly
  // cookie whose hash is persisted in D1.
  let user;
  try {
    const userRes = await fetch("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${data.access_token}`, "User-Agent": "NoxConnect" },
    });
    if (!userRes.ok) throw Object.assign(new Error("GitHub identity lookup failed"), { status: userRes.status });
    user = await userRes.json();
    if (!user?.login) throw new Error("GitHub identity response is incomplete");
  } catch (error) {
    console.error("[noxconnect oauth] failed to resolve identity:", error);
    return jsonError("Authentication service temporarily unavailable", 502);
  }

  // Persist refresh token (if the GitHub App has token expiration enabled).
  // Lookup the GitHub login server-side so we don't trust client-provided
  // identity. Failure is non-fatal — without a refresh token, the user will
  // simply re-authenticate after the access token expires.
  if (data.refresh_token) {
    try {
      await saveOAuthTokens(context.env.DB, {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresInSec: data.expires_in,
        refreshTokenExpiresInSec: data.refresh_token_expires_in,
        githubLogin: user.login,
        encryptionKey,
      });
    } catch (e) {
      console.error("[noxconnect oauth] failed to persist refresh token:", e);
    }
  }

  let session;
  try {
    const accessExpiresAt = Number.isFinite(Number(data.expires_in))
      ? new Date(Date.now() + Number(data.expires_in) * 1000).toISOString()
      : null;
    session = await createBrowserSession(context.env.DB, encryptionKey, {
      githubLogin: user.login,
      githubToken: data.access_token,
      githubTokenExpiresAt: accessExpiresAt,
    });
  } catch (error) {
    console.error("[noxconnect oauth] failed to create browser session:", error);
    return jsonError("Authentication service temporarily unavailable", 503);
  }

  const origin = url.origin;
  const headers = new Headers({
    Location: `${origin}/?login=ok`,
    "Cache-Control": "no-store, no-cache, must-revalidate, private",
    "CDN-Cache-Control": "no-store",
    "Cloudflare-CDN-Cache-Control": "no-store",
    Pragma: "no-cache",
    Vary: "*",
  });
  for (const cookie of sessionCookies(session.sessionToken, session.csrfToken)) {
    headers.append("Set-Cookie", cookie);
  }
  headers.append("Set-Cookie", "ut_oauth_state=; Path=/; Max-Age=0; SameSite=Lax; Secure");
  return new Response(null, {
    status: 302,
    headers,
  });
}

function parseCookies(cookieHeader) {
  const cookies = {};
  for (const pair of cookieHeader.split(";")) {
    const [key, ...rest] = pair.trim().split("=");
    if (key) cookies[key.trim()] = rest.join("=").trim();
  }
  return cookies;
}

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
