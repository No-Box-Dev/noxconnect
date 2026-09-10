const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";

// Provider refresh remains a NoxConnect capability. Application session and
// API-token persistence lives in NoxHere.
export async function refreshWithGitHub({ clientId, clientSecret, refreshToken }) {
  const res = await fetch(GITHUB_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) return { transportError: `GitHub refresh returned ${res.status}` };
  const data = await res.json().catch(() => null);
  if (!data) return { transportError: "GitHub refresh returned non-JSON" };
  if (data.error) return { error: data.error, errorDescription: data.error_description };
  if (!data.access_token) return { error: "missing_access_token" };
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? refreshToken,
    expiresInSec: Number(data.expires_in) || null,
    refreshTokenExpiresInSec: Number(data.refresh_token_expires_in) || null,
  };
}
