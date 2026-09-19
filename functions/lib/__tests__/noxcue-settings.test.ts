import { describe, expect, it } from "vitest";
import { createCueKey, createCueKeySchema, cueSourceInputSchema, hashCueKey } from "../noxcue-settings";

describe("NoxCue settings contracts", () => {
  it("creates secret keys with stable hashes", async () => {
    const secret = createCueKey();
    expect(secret).toMatch(/^nox_secret_[A-Za-z0-9_-]{40,}$/);
    expect(await hashCueKey(secret)).toBe(await hashCueKey(secret));
  });

  it("accepts daily source and Slack destination settings", () => {
    expect(cueSourceInputSchema.parse({
      name: "Checkout",
      enabled: true,
      projectId: "project-1",
      slackChannelId: "C123",
      slackConnectionId: "connection-1",
    })).toMatchObject({
      name: "Checkout", projectId: "project-1", timezone: "UTC",
      digestEnabled: true, digestTimeLocal: "00:30",
      slackChannelId: "C123", slackConnectionId: "connection-1",
    });
    expect(cueSourceInputSchema.safeParse({
      name: "Checkout", enabled: true, projectId: "project-1",
      timezone: "Not/A_Zone", digestTimeLocal: "25:00",
    }).success).toBe(false);
  });

  it("accepts publishable and secret keys but no arbitrary key kinds", () => {
    expect(createCueKeySchema.safeParse({ name: "Secret", kind: "secret" }).success).toBe(true);
    expect(createCueKeySchema.safeParse({ name: "Publishable", kind: "publishable" }).success).toBe(true);
    expect(createCueKeySchema.safeParse({ name: "Unknown", kind: "admin" }).success).toBe(false);
  });
});
