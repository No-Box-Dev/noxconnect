import { describe, expect, it, vi } from "vitest";
vi.mock("../noxspot-resolution-ai.js", () => ({
  generateNoxSpotResolutionSummary: vi.fn(),
}));

import { deliverNoxSpotResolutionEmail, prepareNoxSpotResolutionEmail, storeNoxSpotReport, updateNoxSpotReport } from "../noxspot-resolution.js";
import { generateNoxSpotResolutionSummary } from "../noxspot-resolution-ai.js";
import { encryptToken } from "../crypto.js";

function statement(sql, firstValue, runValue = { success: true, meta: { changes: 1 } }) {
  return {
    sql,
    binds: [],
    bind(...values) { this.binds = values; return this; },
    async first() { return firstValue; },
    async run() { return runValue; },
  };
}

describe("NoxSpot report resolution", () => {
  it("encrypts an opted-in reporter email before storing it", async () => {
    const statements = [];
    const env = {
      ENCRYPTION_KEY: "cd".repeat(32),
      DB: {
        prepare(sql) { const value = statement(sql, null); statements.push(value); return value; },
        async batch(items) { return Promise.all(items.map((item) => item.run())); },
      },
    };
    await storeNoxSpotReport(env, {
      captureId: "capture-private", orgId: 7, projectId: "project-1", siteId: "site-1",
      repo: "web", title: "Private contact", reporter: "Ada",
      reporterEmail: "Ada@Example.com", notifyOnResolution: true,
    }, { number: 42, html_url: "https://github.com/acme/web/issues/42" });

    const values = statements[0].binds;
    expect(values[9]).toMatch(/^[a-f0-9]+:[a-f0-9]+$/);
    expect(values[9]).not.toContain("example.com");
    expect(values[10]).toMatch(/^[a-f0-9]{64}$/);
    expect(values[11]).toBe(1);
  });

  it("records a manual resolution and durably queues the opted-in email", async () => {
    const report = {
      id: "capture-1", org_id: 7, project_id: "project-1", site_id: "site-1",
      repo: "web", issue_number: 42, title: "Checkout", status: "open",
      notification_consent: 1, reporter_email_encrypted: "ciphertext",
      notification_status: "not_requested", site_name: "Website",
    };
    const statements = [];
    const env = {
      DB: {
        prepare(sql) { const value = statement(sql, sql.includes("SELECT report.id") ? report : null); statements.push(value); return value; },
        async batch(items) { return Promise.all(items.map((item) => item.run())); },
      },
      TASK_QUEUE: { send: vi.fn(async () => undefined) },
    };

    const result = await updateNoxSpotReport(env, {
      reportId: "capture-1", orgId: 7, projectId: "project-1", ownerId: "acme",
      actor: "maintainer", source: "platform", status: "resolved",
      summary: "Fixed in release 2.1.", notify: true,
    });

    expect(result).toMatchObject({ status: "resolved", notification: { eligible: true, requested: true, status: "pending" } });
    expect(statements.find((item) => item.sql.includes("UPDATE spot_reports")).binds[0]).toBe("resolved");
    expect(env.TASK_QUEUE.send).toHaveBeenCalledWith(expect.objectContaining({
      type: "spot_send_resolution_email", reportId: "capture-1", ownerId: "acme",
    }));
  });

  it("claims and sends a resolution email through the NoxConnect capability", async () => {
    const encryptionKey = "ab".repeat(32);
    const report = {
      id: "capture-1", title: "Checkout", issue_url: "https://github.com/acme/web/issues/42",
      resolution_summary: "Fixed.", resolved_at: "2026-09-19T01:00:00Z",
      reporter_email_encrypted: await encryptToken("reporter@example.com", encryptionKey), notification_consent: 1,
      notification_status: "pending", site_name: "Website",
    };
    const env = {
      DB: {
        prepare(sql) { return statement(sql, sql.includes("SELECT report.id") ? report : null); },
        async batch(items) { return Promise.all(items.map((item) => item.run())); },
      },
      ENCRYPTION_KEY: encryptionKey,
      NOXCONNECT_EMAIL: { sendEmail: vi.fn(async () => ({ messageId: "postmark-1" })) },
    };
    const result = await deliverNoxSpotResolutionEmail(env, "capture-1");

    expect(result).toEqual({ status: "accepted", messageId: "postmark-1" });
    expect(env.NOXCONNECT_EMAIL.sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      contract: "noxconnect.transactional-email",
      recipient: "reporter@example.com",
      template: "noxspot.resolution",
      requestId: "noxspot-resolution:capture-1:2026-09-19T01:00:00Z",
    }));
  });

  it("stores the generated summary before durably queueing the email", async () => {
    generateNoxSpotResolutionSummary.mockResolvedValueOnce({
      status: "ready",
      summary: "We fixed collection selection.\n\nIt now updates normally.",
      evidenceSource: "closing_pull_request",
      model: "managed-model",
    });
    const report = {
      id: "capture-1", org_id: 7, project_id: "project-1", repo: "web", issue_number: 42,
      title: "Checkout", resolved_at: "2026-09-19T01:00:00Z", notification_consent: 1,
      reporter_email_encrypted: "ciphertext", resolution_ai_status: "pending",
      owner_id: "acme", installation_id: 12,
    };
    const statements = [];
    const env = {
      DB: {
        prepare(sql) { const value = statement(sql, sql.includes("SELECT report.id") ? report : null); statements.push(value); return value; },
        async batch(items) { return Promise.all(items.map((item) => item.run())); },
      },
      TASK_QUEUE: { send: vi.fn(async () => undefined) },
    };

    const result = await prepareNoxSpotResolutionEmail(env, report.id);

    expect(result).toMatchObject({ status: "ready", evidenceSource: "closing_pull_request" });
    expect(generateNoxSpotResolutionSummary).toHaveBeenCalledWith(env, report);
    const update = statements.find((item) => item.sql.includes("resolution_ai_status = 'ready'"));
    expect(update.binds[0]).toContain("We fixed collection selection");
    expect(env.TASK_QUEUE.send).toHaveBeenCalledWith(expect.objectContaining({
      type: "spot_send_resolution_email", reportId: report.id,
    }));
  });
});
