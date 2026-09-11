import { describe, expect, it } from "vitest";
import { findCueEvent, findIssue, findRelease, stagingHostname, validateSafety, WRITE_CONFIRMATION } from "./staging-acceptance-lib.mjs";

const safe = {
  baseUrl: "https://noxhere-staging.jasper-414.workers.dev",
  noxspotUrl: "https://noxspot-api-staging.jasper-414.workers.dev",
  noxspotOrigin: "https://widget-test.example.com",
  org: "nox-staging-cert",
  repo: "staging-cert",
  projectId: "project-1",
  accessToken: "nox_at_redacted",
  noxcueSourceId: "source-1",
  noxcueIngestKey: "cue-redacted",
  noxspotSiteId: "site-1",
  confirm: WRITE_CONFIRMATION,
};

describe("staging acceptance safety", () => {
  it("accepts only dedicated staging hosts and scopes", () => {
    expect(validateSafety(safe, { writes: true })).toEqual([]);
    expect(stagingHostname("staging.noxhere.com", "noxhere")).toBe(true);
  });

  it("refuses production provider writes", () => {
    const errors = validateSafety({
      ...safe,
      baseUrl: "https://app.noxhere.com",
      noxspotUrl: "https://api.noxspot.dev",
      noxspotOrigin: "https://app.noxhere.com",
      org: "No-Box-Dev",
      repo: "noxconnect",
      confirm: "yes",
    }, { writes: true });
    expect(errors).toHaveLength(6);
  });

  it("requires an explicit write confirmation", () => {
    expect(validateSafety({ ...safe, confirm: "" }, { writes: true })).toContain(
      `Set NOX_ACCEPTANCE_CONFIRM=${WRITE_CONFIRMATION} to enable provider writes`,
    );
  });
});

describe("staging acceptance receipts", () => {
  it("finds provider resources by the unique marker", () => {
    const issue = { number: 2, title: "NoxSpot [nox-acceptance:abc]" };
    expect(findIssue([{ pull_request: {}, title: issue.title }, issue], "[nox-acceptance:abc]")).toBe(issue);
    expect(findRelease([{ repo: "staging-cert", pr: { number: 3, title: "Release [nox-acceptance:abc]" } }], "staging-cert", 3, "[nox-acceptance:abc]")).toBeTruthy();
    expect(findCueEvent([{ title: "Failure [nox-acceptance:abc]" }], "[nox-acceptance:abc]")).toBeTruthy();
  });
});
