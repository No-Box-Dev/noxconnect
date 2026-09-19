import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../github-app.js", () => ({
  getInstallationToken: vi.fn(async () => "installation-token"),
}));

import {
  generateNoxSpotResolutionSummary,
  NOXSPOT_RESOLUTION_SYSTEM_PROMPT,
  validateResolutionSummary,
} from "../noxspot-resolution-ai.js";

const report = {
  id: "report-1",
  org_id: 2,
  project_id: "project-1",
  owner_id: "acme",
  installation_id: 42,
  repo: "web",
  issue_number: 7,
  title: "Could not deselect a collection on mobile",
  resolved_at: "2026-09-19T01:00:00Z",
  reporter_name: "Private Person",
  reporter_email_encrypted: "private@example.com",
};

afterEach(() => vi.restoreAllMocks());

describe("NoxSpot resolution AI", () => {
  it("sends only the issue title and trusted bounded GitHub evidence to NoxConnect AI", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ data: { repository: { issue: {
      closedByPullRequestsReferences: { nodes: [{
        number: 12,
        title: "Fix collection deselection",
        body: "Tapping a selected collection now removes the membership.",
        mergedAt: "2026-09-19T00:00:00Z",
      }] },
      comments: { nodes: [{
        body: "Confirmed on mobile.", authorAssociation: "MEMBER", createdAt: "2026-09-19T00:10:00Z",
      }, {
        body: "My private user comment", authorAssociation: "NONE", createdAt: "2026-09-19T00:20:00Z",
      }] },
    } } } }));
    const execute = vi.fn(async () => ({ result: {
      text: "We found that the collection tray did not remove a selected collection when tapped. We updated the selection behavior so tapping it again removes the game from that collection.\n\nYou should now be able to change collection membership normally on mobile and desktop.",
      model: "managed-model",
    } }));

    const result = await generateNoxSpotResolutionSummary({ NOXCONNECT: { execute } }, report);

    expect(result).toMatchObject({ status: "ready", evidenceSource: "closing_pull_request" });
    const command = execute.mock.calls[0][0];
    const input = JSON.parse(command.input.user);
    expect(input).toEqual({
      issueTitle: report.title,
      closingPullRequests: [{ number: 12, title: "Fix collection deselection", description: "Tapping a selected collection now removes the membership." }],
      maintainerResolutionComments: [{ body: "Confirmed on mobile.", createdAt: "2026-09-19T00:10:00Z" }],
    });
    expect(JSON.stringify(command)).not.toContain("Private Person");
    expect(JSON.stringify(command)).not.toContain("private@example.com");
  });

  it("does not call AI without a closing PR or maintainer evidence", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ data: { repository: { issue: {
      closedByPullRequestsReferences: { nodes: [] }, comments: { nodes: [] },
    } } } }));
    const execute = vi.fn();
    expect(await generateNoxSpotResolutionSummary({ NOXCONNECT: { execute } }, report))
      .toEqual({ status: "insufficient_evidence", evidenceSource: "none" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("enforces concise body-only output", () => {
    expect(NOXSPOT_RESOLUTION_SYSTEM_PROMPT).toContain("exactly two sentences");
    expect(NOXSPOT_RESOLUTION_SYSTEM_PROMPT).toContain("State each fact once");
    expect(validateResolutionSummary("Hi Jasper,\n\nThis is fixed.")).toBeNull();
    const valid = "We found that the collection tray did not remove a selected collection when tapped. We updated the selection behavior so tapping it again removes the game from that collection.\n\nYou should now be able to change collection membership normally on mobile and desktop.";
    expect(validateResolutionSummary(valid, report.title)).toBe(valid);
    expect(validateResolutionSummary(valid.replace("normally on mobile and desktop", "on mobile and your changes save automatically"), report.title)).toBeNull();
  });
});
