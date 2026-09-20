import { afterEach, describe, expect, it, vi } from "vitest";
import { sendTransactionalEmail } from "../transactional-email";
import { DEFAULT_NOXSPOT_RESOLUTION_TEMPLATE } from "../noxspot-resolution-template.js";

const env = {
  POSTMARK_SERVER_TOKEN: "test-server-token",
  PLATFORM_EMAIL_FROM: "invites@noxhere.com",
  NOXSPOT_EMAIL_FROM: "updates@noxhere.com",
};

afterEach(() => vi.unstubAllGlobals());

describe("NoxConnect transactional email", () => {
  it("owns platform email rendering and Postmark delivery", async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({
      ErrorCode: 0,
      MessageID: "message-id",
      SubmittedAt: "2026-09-18T00:00:00Z",
    }));
    vi.stubGlobal("fetch", request);

    const receipt = await sendTransactionalEmail(env, {
      contract: "noxconnect.transactional-email",
      version: 1,
      requestId: "invite:one",
      recipient: "guest@example.com",
      template: "platform.guest-invitation",
      model: {
        subject: "You are invited",
        heading: "Join <Nox>",
        detail: "Project access",
        actionUrl: "https://app.noxhere.com/auth/email/callback?token=one",
      },
    });

    const [url, init] = request.mock.calls[0];
    expect(url).toBe("https://api.postmarkapp.com/email");
    expect(init?.headers).toMatchObject({ "X-Postmark-Server-Token": "test-server-token" });
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      From: "Nox <invites@noxhere.com>",
      To: "guest@example.com",
      MessageStream: "outbound",
      TrackOpens: false,
      TrackLinks: "None",
      Tag: "guest-invitation",
      Metadata: { request_id: "invite:one", template: "platform.guest-invitation" },
    });
    expect(body.HtmlBody).toContain("Join &lt;Nox&gt;");
    expect(receipt).toMatchObject({ status: "accepted", provider: "postmark", messageId: "message-id" });
    expect(JSON.stringify(receipt)).not.toContain("guest@example.com");
  });

  it("routes NoxSpot resolution mail through its dedicated stream", async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ ErrorCode: 0, MessageID: "resolution-id" }));
    vi.stubGlobal("fetch", request);
    await sendTransactionalEmail(env, {
      contract: "noxconnect.transactional-email",
      version: 1,
      requestId: "resolution:report-1:v1",
      recipient: "reporter@example.com",
      template: "noxspot.resolution",
      model: {
        siteName: "Storefront",
        reportTitle: "Checkout failed",
        summary: "Thank you for reporting this issue. We fixed the checkout flow, which now completes normally.",
        reporterName: "Ada",
        responseUrl: "https://api.noxspot.dev/resolution/token-one",
        presentation: DEFAULT_NOXSPOT_RESOLUTION_TEMPLATE,
      },
    });
    const body = JSON.parse(String(request.mock.calls[0][1]?.body));
    expect(body).toMatchObject({
      From: "NoxSpot <updates@noxhere.com>",
      MessageStream: "noxspot-resolutions",
      Tag: "noxspot-resolution",
    });
    expect(body.HtmlBody).toContain("Reopen the ticket");
    expect(body.HtmlBody).toContain("NoxSpot <span");
    expect(body.HtmlBody).toContain("for Storefront");
    expect(body.HtmlBody).toContain("You received this transactional email because you asked to be notified");
    expect(body.HtmlBody).toContain("background:#f5f3ff");
    expect(body.HtmlBody).toContain("add more details or a screenshot if helpful");
    expect(body.HtmlBody).not.toContain("Thank you for reporting this issue");
    expect(body.TextBody).toContain("Reopen the ticket");
    expect(body.TextBody).not.toContain("Thank you for reporting this issue");
    const closing = "Thank you again for helping us improve Storefront.";
    expect(body.HtmlBody).toContain(closing);
    expect(body.TextBody.endsWith(closing)).toBe(true);
  });

  it("bounds long request IDs for Postmark metadata without losing uniqueness", async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ ErrorCode: 0, MessageID: "bounded-id" }));
    vi.stubGlobal("fetch", request);
    const requestId = `noxspot-resolution:${"report-with-a-long-id-".repeat(4)}:2026-09-20T13:04:21.273Z`;

    await sendTransactionalEmail(env, {
      contract: "noxconnect.transactional-email",
      version: 1,
      requestId,
      recipient: "reporter@example.com",
      template: "noxspot.resolution",
      model: {
        siteName: "Storefront",
        reportTitle: "Checkout failed",
        summary: "The checkout now works.",
      },
    });

    const body = JSON.parse(String(request.mock.calls[0][1]?.body));
    expect(body.Metadata.request_id).toHaveLength(80);
    expect(body.Metadata.request_id).toMatch(/^noxspot-resolution:report-with-a-long-id-.*:[0-9a-f]{16}$/);
    expect(body.Metadata.request_id).not.toBe(requestId.slice(0, 80));
  });

  it("renders a safe custom NoxSpot presentation and Postmark reply-to", async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ ErrorCode: 0, MessageID: "custom-id" }));
    vi.stubGlobal("fetch", request);
    await sendTransactionalEmail(env, {
      contract: "noxconnect.transactional-email", version: 1, requestId: "custom:one",
      recipient: "reporter@example.com", template: "noxspot.resolution",
      model: {
        siteName: "Storefront", reportTitle: "Checkout failed", summary: "The checkout now works.",
        responseUrl: "https://api.noxspot.dev/resolution/token-one",
        presentation: {
          ...DEFAULT_NOXSPOT_RESOLUTION_TEMPLATE,
          subject: "Update from {{site_name}}: {{report_title}}",
          buttonLabel: "Open this ticket again",
          replyTo: "support@example.com",
        },
      },
    });
    const body = JSON.parse(String(request.mock.calls[0][1]?.body));
    expect(body.Subject).toBe("Update from Storefront: Checkout failed");
    expect(body.HtmlBody).toContain("Open this ticket again");
    expect(body.HtmlBody).toContain("mailto:support@example.com");
    expect(body.ReplyTo).toBe("support@example.com");
  });

  it("rejects unbounded or unknown commands before contacting Postmark", async () => {
    const request = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", request);
    await expect(sendTransactionalEmail(env, {
      contract: "noxconnect.transactional-email",
      version: 1,
      requestId: "one",
      recipient: "guest@example.com",
      template: "platform.unknown",
      model: {},
    })).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it("fails closed when Postmark rejects the message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ErrorCode: 10 }, { status: 422 })));
    await expect(sendTransactionalEmail(env, {
      contract: "noxconnect.transactional-email",
      version: 1,
      requestId: "login:one",
      recipient: "guest@example.com",
      template: "platform.email-login",
      model: {
        subject: "Sign in",
        heading: "Sign in",
        detail: "Expires soon",
        actionUrl: "https://app.noxhere.com",
      },
    })).rejects.toThrow("Postmark email request failed (422:10)");
  });
});
