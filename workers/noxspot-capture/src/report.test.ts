import { describe, expect, it } from "vitest";
import { buildCaptureTask, screenshotTarget, validateQueueTask, validateReportInput, type ReportParams } from "./report";
import type { CaptureSite } from "./site-config";

const site: CaptureSite = {
  id: "site-1",
  org_id: 1,
  project_id: "project-1",
  repo: "web",
  site_name: "Web",
  slack_channel_id: "C123",
  slack_connection_id: "slack-1",
  github_login: "acme",
  widget_config: "{}",
};

describe("capture validation", () => {
  it("normalizes a valid report and preserves custom values", () => {
    const result = validateReportInput({
      siteId: "site-1",
      title: "Broken button",
      reporter: " Ada ",
      reporterEmail: "ada@example.com",
      blockValues: { impact: "Checkout blocked" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.params.reporter).toBe("Ada");
    expect(result.params.blockValues).toEqual({ impact: "Checkout blocked" });
  });

  it("rejects oversized nested context", () => {
    const result = validateReportInput({ siteId: "site-1", title: "Bug", context: { state: "x".repeat(25_000) } });
    expect(result.ok).toBe(false);
  });

  it("rejects unsafe or oversized attempt IDs", () => {
    expect(validateReportInput({ siteId: "site-1", title: "Bug", attemptId: "../../shared" }).ok).toBe(false);
    expect(validateReportInput({ siteId: "site-1", title: "Bug", attemptId: "x".repeat(101) }).ok).toBe(false);
  });

  it("creates a versioned task with connection routing and idempotency", () => {
    const params: ReportParams = {
      attemptId: "capture-1",
      siteId: site.id,
      title: "Broken button",
      description: null,
      reporter: null,
      reporterEmail: null,
      environment: "Production",
      screenshot: null,
      metadata: null,
      elements: null,
      context: null,
      type: "bug",
      rating: null,
      blockValues: null,
    };
    const task = validateQueueTask(buildCaptureTask({ site, params, captureId: "capture-1", screenshotUrl: null }));
    expect(task).toMatchObject({
      version: 1,
      deliveryId: "noxspot:capture-1",
      slackConnectionId: "slack-1",
      environment: "Production",
    });
  });

  it("creates deterministic screenshot keys under the site prefix", () => {
    const target = screenshotTarget(site.id, "capture-1", "data:image/png;base64,AA==", "https://cdn.example.com");
    expect(target?.key).toBe("screenshots/site-1/capture-1.png");
    expect(target?.url).toContain(target?.key);
  });
});
