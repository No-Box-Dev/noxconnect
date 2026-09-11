import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { getNoxCueDigestResponse, getNoxCueTestResponse } from "../noxcue-response.js";
import { generateNoxFeedContent, getNoxFeedGenerationInfo, getNoxFeedSlackResponse } from "../noxfeed-response.js";
import { buildNoxTicketActivityResponse, buildNoxTicketTestResponse } from "../../products/noxticket/response.js";

describe("product response boundaries", () => {
  it("keeps product presentation out of shared plumbing", () => {
    const read = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8");
    expect(read("../slack.js")).not.toMatch(/buildPostsBlocks|buildReleaseNotesBlocks/);
    expect(read("../narrator.js")).not.toMatch(/ACTOR_SYSTEM|PR_OPENED_SYSTEM|RELEASE_NOTES_SYSTEM/);
    expect(read("../noxspot.js")).not.toMatch(/api\.github\.com|Authorization:\s*`Bearer/);
    expect(read("../../api/slack/test.js")).not.toMatch(/Nox(Cue|Spot|Feed|Ticket) delivery test/);
    expect(read("../../../src/lib/github.ts")).not.toMatch(/@octokit|api\.github\.com|\.rest\.(issues|pulls)/);
    expect(read("../github-issues.js")).toContain("NoxConnect's GitHub issue transport");
  });

  it("validates NoxCue's versioned service response", async () => {
    const service = {
      buildTestResponse: vi.fn(async () => ({ contract: "noxcue.response", version: 1, message: { text: "Test", blocks: [{ type: "section" }] } })),
    };
    expect((await getNoxCueTestResponse({ NOXCUE_RESPONSE: service }, "Acme")).message.text).toBe("Test");
    await expect(getNoxCueTestResponse({}, "Acme")).rejects.toThrow("service binding is unavailable");
  });

  it("validates NoxCue's daily digest response", async () => {
    const service = {
      buildDigestResponse: vi.fn(async () => ({
        contract: "noxcue.response", version: 1, kind: "daily_digest",
        message: { text: "Daily", blocks: [{ type: "section" }] },
      })),
    };
    expect((await getNoxCueDigestResponse(
      { NOXCUE_RESPONSE: service }, "Acme", "2026-08-29", { "users.new": 4 },
    )).message.text).toBe("Daily");
  });

  it("validates NoxFeed prompts and Slack responses", async () => {
    const service = {
      generate: vi.fn(async () => ({ contract: "noxfeed.response", version: 1, generation: { status: "generated", model: "model-1", output: { summary: "Post", technicalSummary: "What it does: A\nHow it works: B\nWhat it touches: C" } } })),
      generationInfo: vi.fn(async () => ({ contract: "noxfeed.response", version: 1, model: "model-1", provider: "anthropic", available: true })),
      buildSlackResponse: vi.fn(async () => ({ contract: "noxfeed.response", version: 1, message: { text: "Post", blocks: [{ type: "section" }] } })),
      buildTestResponse: vi.fn(),
    };
    expect((await generateNoxFeedContent({ NOXFEED_RESPONSE: service }, "actor", {})).output.summary).toBe("Post");
    expect(await getNoxFeedGenerationInfo({ NOXFEED_RESPONSE: service })).toEqual({ model: "model-1", provider: "anthropic", available: true });
    expect((await getNoxFeedSlackResponse({ NOXFEED_RESPONSE: service }, "posts", {})).message.text).toBe("Post");
  });

  it("rejects generation readiness responses without explicit availability", async () => {
    const service = {
      generationInfo: vi.fn(async () => ({ contract: "noxfeed.response", version: 1, model: "model-1", provider: "anthropic" })),
    };
    await expect(getNoxFeedGenerationInfo({ NOXFEED_RESPONSE: service })).rejects.toThrow(
      "Invalid NoxFeed generation info",
    );
  });

  it("keeps NoxTicket policy outside shared connector modules", () => {
    const activity = buildNoxTicketActivityResponse({ orgId: 7, repo: "app", action: "opened", actor: "Ada", issue: { number: 3, title: "Fix <button>", html_url: "https://github.com/acme/app/issues/3" } });
    expect(activity.message.text).toBe("NoxTicket opened: Fix <button>");
    expect(JSON.stringify(activity.message.blocks)).toContain("Fix &lt;button&gt;");
    expect(buildNoxTicketTestResponse("Acme").message.text).toContain("NoxTicket");
  });
});
