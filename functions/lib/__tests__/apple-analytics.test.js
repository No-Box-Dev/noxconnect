import { describe, expect, it } from "vitest";
import {
  aggregateAppleRows,
  createAppStoreConnectToken,
  parseDelimited,
  selectAppleReports,
} from "../apple-analytics.js";

function toPem(bytes) {
  const base64 = Buffer.from(bytes).toString("base64").match(/.{1,64}/g).join("\n");
  return `-----BEGIN PRIVATE KEY-----\n${base64}\n-----END PRIVATE KEY-----`;
}

describe("App Store Connect authentication", () => {
  it("creates a ten-minute ES256 token without embedding credentials", async () => {
    const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const privateKey = toPem(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey));
    const token = await createAppStoreConnectToken({
      issuerId: "69a6de78-1452-47e3-e053-5b8c7c11a4d1",
      keyId: "ABC123DEFG",
      privateKey,
      now: 1_700_000_000_000,
    });
    const [header, claims, signature] = token.split(".");
    const decode = (value) => JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    expect(decode(header)).toEqual({ alg: "ES256", kid: "ABC123DEFG", typ: "JWT" });
    expect(decode(claims)).toEqual({
      iss: "69a6de78-1452-47e3-e053-5b8c7c11a4d1",
      iat: 1_700_000_000,
      exp: 1_700_000_600,
      aud: "appstoreconnect-v1",
    });
    expect(Buffer.from(signature, "base64url")).toHaveLength(64);
    expect(token).not.toContain("PRIVATE KEY");
  });
});

describe("Apple report processing", () => {
  it("selects standard reports and excludes context and detailed duplicates", () => {
    expect(selectAppleReports([
      { id: "sessions-context", attributes: { name: "App Sessions Context" } },
      { id: "sessions-detail", attributes: { name: "App Sessions Detailed" } },
      { id: "sessions-standard", attributes: { name: "App Sessions Standard" } },
      { id: "downloads", attributes: { name: "App Store Downloads Standard" } },
    ])).toEqual([
      { kind: "sessions", id: "sessions-standard", name: "App Sessions Standard" },
      { kind: "downloads", id: "downloads", name: "App Store Downloads Standard" },
    ]);
  });

  it("parses quoted CSV and sums only the configured app", () => {
    const rows = parseDelimited([
      "Date,App Name,App Apple Identifier,Download Type,Counts",
      '2026-09-09,"Example, Inc.",1476097583,First-time Download,10',
      "2026-09-09,Example,1476097583,Redownload,3",
      "2026-09-09,Other,9999999999,Redownload,100",
    ].join("\n"));
    expect(aggregateAppleRows("downloads", rows, "1476097583")).toEqual([{
      period: "2026-09-09",
      metrics: {
        "apple.downloads.total": 13,
        "apple.downloads.first_time": 10,
        "apple.downloads.redownloads": 3,
      },
    }]);
  });

  it("parses tab-delimited installation batches", () => {
    const rows = parseDelimited([
      "Date\tApp Apple Identifier\tEvent\tCounts",
      "2026-09-09\t1476097583\tInstall\t8",
      "2026-09-09\t1476097583\tDelete\t2",
    ].join("\n"));
    expect(aggregateAppleRows("installs", rows, "1476097583")[0].metrics).toEqual({
      "apple.installations": 8,
      "apple.deletions": 2,
    });
  });
});
