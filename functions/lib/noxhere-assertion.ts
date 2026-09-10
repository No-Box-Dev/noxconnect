const encoder = new TextEncoder();

export interface NoxHereAuthContext {
  credentialType: "session" | "native_session" | "api_token";
  credentialId: string;
  principalId: string | null;
  userLogin: string;
  userId: number | null;
  orgId: number;
  orgLogin: string;
  isAdmin: boolean;
  projectId: string | null;
  scopes: string[];
  connectionId: string | null;
}

interface NoxHereAssertion {
  version: 1;
  issuer: "noxhere";
  audience: "noxconnect";
  issuedAt: number;
  expiresAt: number;
  method: string;
  path: string;
  auth: NoxHereAuthContext;
}

export async function verifyNoxHereAssertion(
  request: Request,
  secret: string | undefined,
  previousSecret?: string,
): Promise<NoxHereAuthContext | null> {
  const payload = request.headers.get("X-NoxHere-Internal-Assertion");
  const signature = request.headers.get("X-NoxHere-Internal-Signature");
  if (!payload && !signature) return null;
  if (!payload || !signature || !secret) throw new Error("invalid_internal_assertion");

  let signatureBytes: Uint8Array;
  try { signatureBytes = base64UrlDecode(signature); }
  catch { throw new Error("invalid_internal_assertion"); }
  const valid = await verifyWithSecret(payload, signatureBytes, secret)
    || Boolean(previousSecret && await verifyWithSecret(payload, signatureBytes, previousSecret));
  if (!valid) throw new Error("invalid_internal_assertion");

  let assertion: NoxHereAssertion;
  try { assertion = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload))) as NoxHereAssertion; }
  catch { throw new Error("invalid_internal_assertion"); }
  const now = Math.floor(Date.now() / 1000);
  const url = new URL(request.url);
  if (assertion.version !== 1
      || assertion.issuer !== "noxhere"
      || assertion.audience !== "noxconnect"
      || assertion.expiresAt < now
      || assertion.expiresAt > now + 60
      || assertion.issuedAt > now + 5
      || assertion.method !== request.method.toUpperCase()
      || assertion.path !== `${url.pathname}${url.search}`
      || !validAuth(assertion.auth)) {
    throw new Error("invalid_internal_assertion");
  }
  return assertion.auth;
}

async function verifyWithSecret(payload: string, signature: Uint8Array, secret: string): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"],
  );
  return crypto.subtle.verify("HMAC", key, signature, encoder.encode(payload));
}

function validAuth(auth: NoxHereAuthContext): boolean {
  return Boolean(auth
    && ["session", "native_session", "api_token"].includes(auth.credentialType)
    && typeof auth.credentialId === "string" && auth.credentialId.length > 0 && auth.credentialId.length <= 256
    && (auth.principalId === null || typeof auth.principalId === "string")
    && typeof auth.userLogin === "string" && auth.userLogin.length > 0 && auth.userLogin.length <= 256
    && (auth.userId === null || Number.isSafeInteger(auth.userId))
    && Number.isSafeInteger(auth.orgId) && auth.orgId > 0
    && typeof auth.orgLogin === "string" && auth.orgLogin.length > 0 && auth.orgLogin.length <= 256
    && typeof auth.isAdmin === "boolean"
    && Array.isArray(auth.scopes) && auth.scopes.length <= 16
    && auth.scopes.every((scope) => typeof scope === "string" && scope.length <= 64)
    && (auth.projectId === null || typeof auth.projectId === "string")
    && (auth.connectionId === null || typeof auth.connectionId === "string"));
}

function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
