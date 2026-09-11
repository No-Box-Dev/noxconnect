import { describe, expect, it } from "vitest";
import { acceptanceHostname, findCueEvent, findIssue, findRelease, hasTestLabel, validateSafety, WRITE_CONFIRMATION } from "./staging-acceptance-lib.mjs";

const safe = {
  baseUrl: "https://noxhere-staging.jasper-414.workers.dev",
  noxspotUrl: "https://noxspot-api-staging.jasper-414.workers.dev",
  noxspotOrigin: "https://widget-test.example.com",
  org: "No-Box-Dev",
  repo: "test",
  slackConnectionId: "connection-1",
  slackChannelId: "C123456",
  projectId: "project-1",
  accessToken: "nox_at_redacted",
  noxcueSourceId: "source-1",
  noxcueIngestKey: "cue-redacted",
  noxspotSiteId: "site-1",
  confirm: WRITE_CONFIRMATION,
};

describe("staging acceptance safety", () => {
  it("accepts shared provider apps with a test-labelled repository", () => {
    expect(validateSafety(safe, { writes: true })).toEqual([]);
    expect(acceptanceHostname("app.noxhere.com", "noxhere")).toBe(true);
    expect(acceptanceHostname("api.noxspot.dev", "noxspot")).toBe(true);
    expect(hasTestLabel("nox-acceptance")).toBe(true);
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
    expect(errors).toHaveLength(3);
    expect(errors).toContain("NOX_ACCEPTANCE_REPO must be an explicitly named staging/sandbox/test repository");
  });

  it("requires an organization without requiring a second staging organization", () => {
    expect(validateSafety({ ...safe, org: "" })).toContain("NOX_ACCEPTANCE_ORG is required");
    expect(validateSafety({ ...safe, org: "No-Box-Dev" })).toEqual([]);
  });

  it("requires an explicit Slack connection and channel", () => {
    expect(validateSafety({ ...safe, slackConnectionId: "" })).toContain("NOX_ACCEPTANCE_SLACK_CONNECTION_ID is required");
    expect(validateSafety({ ...safe, slackChannelId: "general" })).toContain("NOX_ACCEPTANCE_SLACK_CHANNEL_ID must be a Slack channel ID");
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
