import { describe, expect, it, vi } from "vitest";
import { onRequest, onRequestPost } from "../postmark/webhook";

const SECRET = "webhook-secret";
const ALLOWED_IP = "3.134.147.250";
const delivery = {
  RecordType: "Delivery",
  MessageID: "message-123",
  MessageStream: "noxspot-resolutions",
  Recipient: "Person@Example.com",
  DeliveredAt: "2026-09-18T01:02:03Z",
  Tag: "noxspot-resolved",
};

function context(options: { secret?: string; ip?: string; auth?: string; body?: unknown; trace?: string } = {}) {
  const run = vi.fn(async () => ({ success: true, meta: { changes: 1 } }));
  const bind = vi.fn(() => ({ run }));
  const prepare = vi.fn(() => ({ bind }));
  const batch = vi.fn(async (statements: Array<{ run: () => Promise<unknown> }>) => Promise.all(statements.map((statement) => statement.run())));
  const headers = new Headers({
    "CF-Connecting-IP": options.ip ?? ALLOWED_IP,
    Authorization: options.auth ?? `Basic ${btoa(`postmark:${options.secret ?? SECRET}`)}`,
    "Content-Type": "application/json",
  });
  if (options.trace) headers.set("X-PM-Webhook-Trace-Id", options.trace);
  return {
    context: {
      request: new Request("https://app.noxhere.com/api/postmark/webhook", {
        method: "POST",
        headers,
        body: JSON.stringify(options.body ?? delivery),
      }),
      env: { DB: { prepare, batch }, POSTMARK_WEBHOOK_SECRET: SECRET },
    } as never,
    prepare,
    bind,
    run,
    batch,
  };
}

describe("Postmark webhook", () => {
  it("stores a normalized, privacy-preserving delivery event", async () => {
    const input = context({ trace: "trace-123" });
    const response = await onRequestPost(input.context);

    expect(response.status).toBe(200);
    expect(input.prepare).toHaveBeenCalledWith(expect.stringContaining("ON CONFLICT(id) DO NOTHING"));
    expect(input.bind).toHaveBeenCalledWith(
      "trace:trace-123",
      "delivery",
      "message-123",
      "noxspot-resolutions",
      "noxspot-resolved",
      expect.stringMatching(/^[a-f0-9]{64}$/),
      "delivered",
      "2026-09-18T01:02:03Z",
      null,
    );
    expect(JSON.stringify(input.bind.mock.calls)).not.toContain("Person@Example.com");
    expect(input.batch).toHaveBeenCalledOnce();
  });

  it("suppresses future mail after a hard bounce", async () => {
    const input = context({ body: {
      RecordType: "Bounce",
      MessageID: "message-hard-bounce",
      MessageStream: "noxspot-resolutions",
      Recipient: "gone@example.com",
      BouncedAt: "2026-09-20T03:00:00Z",
      Type: "HardBounce",
      TypeCode: 1,
    } });

    const response = await onRequestPost(input.context);

    expect(response.status).toBe(200);
    expect(input.prepare).toHaveBeenCalledWith(expect.stringContaining("transactional_email_suppressions"));
    expect(input.bind).toHaveBeenCalledWith(
      expect.stringMatching(/^[a-f0-9]{64}$/),
      "hard_bounce",
      "noxspot-resolutions",
      "2026-09-20T03:00:00Z",
    );
  });

  it("does not permanently suppress a temporary bounce", async () => {
    const input = context({ body: {
      RecordType: "Bounce",
      MessageID: "message-soft-bounce",
      MessageStream: "noxspot-resolutions",
      Recipient: "busy@example.com",
      BouncedAt: "2026-09-20T03:00:00Z",
      Type: "Transient",
      TypeCode: 2,
    } });

    const response = await onRequestPost(input.context);

    expect(response.status).toBe(200);
    expect(input.prepare).not.toHaveBeenCalledWith(expect.stringContaining("transactional_email_suppressions"));
  });

  it("rejects requests outside Postmark's webhook network", async () => {
    const input = context({ ip: "203.0.113.10" });
    const response = await onRequestPost(input.context);
    expect(response.status).toBe(403);
    expect(input.prepare).not.toHaveBeenCalled();
  });

  it("rejects invalid credentials without touching storage", async () => {
    const input = context({ auth: `Basic ${btoa("postmark:wrong")}` });
    const response = await onRequestPost(input.context);
    expect(response.status).toBe(403);
    expect(input.prepare).not.toHaveBeenCalled();
  });

  it("rejects malformed provider events", async () => {
    const input = context({ body: { RecordType: "Unknown", MessageID: "one" } });
    const response = await onRequestPost(input.context);
    expect(response.status).toBe(400);
    expect(input.prepare).not.toHaveBeenCalled();
  });

  it("rejects non-POST requests", () => {
    expect(onRequest().status).toBe(405);
  });
});
