import { describe, expect, it } from "vitest";
import { verifyNoxHereAssertion, type NoxHereAuthContext } from "../noxhere-assertion";

const secret = "test-internal-secret";
const encoder = new TextEncoder();

const auth: NoxHereAuthContext = {
  credentialType: "api_token",
  credentialId: "noxkey_test",
  principalId: null,
  userLogin: "api-token:noxkey_test",
  userId: null,
  orgId: 7,
  orgLogin: "acme",
  isAdmin: false,
  projectId: "project-a",
  scopes: ["noxfeed:read"],
  connectionId: null,
};

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function requestWithAssertion(overrides: Record<string, unknown> = {}): Promise<Request> {
  const now = Math.floor(Date.now() / 1000);
  const assertion = {
    version: 1,
    issuer: "noxhere",
    audience: "noxconnect",
    issuedAt: now,
    expiresAt: now + 30,
    method: "GET",
    path: "/api/v1/feed?limit=5",
    auth,
    ...overrides,
  };
  const payload = base64Url(encoder.encode(JSON.stringify(assertion)));
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const signature = base64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(payload))));
  return new Request("https://connector.internal/api/v1/feed?limit=5", { headers: {
    "X-NoxHere-Internal-Assertion": payload,
    "X-NoxHere-Internal-Signature": signature,
  } });
}

describe("NoxHere internal authorization assertion", () => {
  it("accepts a valid method-and-path-bound assertion", async () => {
    await expect(verifyNoxHereAssertion(await requestWithAssertion(), secret)).resolves.toEqual(auth);
  });

  it("accepts the previous key during coordinated rotation", async () => {
    await expect(verifyNoxHereAssertion(await requestWithAssertion(), "next-secret", secret)).resolves.toEqual(auth);
  });

  it("rejects a signature changed after signing", async () => {
    const request = await requestWithAssertion();
    request.headers.set("X-NoxHere-Internal-Signature", "tampered");
    await expect(verifyNoxHereAssertion(request, secret)).rejects.toThrow("invalid_internal_assertion");
  });

  it("rejects replay against a different path", async () => {
    const signed = await requestWithAssertion();
    const replay = new Request("https://connector.internal/api/v1/feed?limit=100", { headers: signed.headers });
    await expect(verifyNoxHereAssertion(replay, secret)).rejects.toThrow("invalid_internal_assertion");
  });

  it("rejects expired assertions", async () => {
    const now = Math.floor(Date.now() / 1000);
    await expect(verifyNoxHereAssertion(await requestWithAssertion({
      issuedAt: now - 60,
      expiresAt: now - 1,
    }), secret)).rejects.toThrow("invalid_internal_assertion");
  });

  it("ignores requests without internal assertion headers", async () => {
    await expect(verifyNoxHereAssertion(new Request("https://connector.internal/api/v1/feed"), secret))
      .resolves.toBeNull();
  });
});
