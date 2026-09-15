import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NoxSpotSite } from "@/lib/types";

const mutate = vi.fn();
vi.mock("@/hooks/useNoxSpot", () => ({
  useUpdateNoxSpotSite: () => ({ mutate, isPending: false }),
}));

import { NoxSpotWidgetConfiguration } from "@/components/admin/tools/NoxSpotWidgetConfiguration";

const site: NoxSpotSite = {
  id: "site-1",
  name: "Web",
  projectId: "project-1",
  repo: "web",
  buttonColor: "#FE795D",
  buttonText: "Report issue",
  widgetMode: "development",
  autoErrorLogging: false,
  environments: [{ name: "Production", url: "app.example.com", enabled: true }],
  blocks: [
    { id: "title", type: "title", required: true },
    { id: "impact", type: "custom_text", environments: ["Production"] },
  ],
  slackChannelId: null,
  slackConnectionId: null,
  slackEffectiveChannelId: null,
  slackUsesFallback: false,
  slackHealth: "disabled",
  slackLastDeliveredAt: null,
  slackPendingCount: 0,
  slackBlockedCount: 0,
  slackLastError: null,
  dailySummaryEnabled: true,
  issueCount: 0,
  openIssueCount: 0,
  createdAt: "2026-08-22T00:00:00Z",
  updatedAt: "2026-08-22T00:00:00Z",
};

describe("NoxSpotWidgetConfiguration", () => {
  beforeEach(() => mutate.mockClear());

  it("renames environment references in form blocks and saves atomically", () => {
    render(<NoxSpotWidgetConfiguration site={site} />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Live" } });
    fireEvent.click(screen.getByRole("button", { name: "Save environments and form" }));

    expect(mutate).toHaveBeenCalledWith(expect.objectContaining({
      id: "site-1",
      environments: [expect.objectContaining({ name: "Live" })],
      blocks: [
        expect.objectContaining({ id: "title" }),
        expect.objectContaining({ id: "impact", environments: ["Live"] }),
      ],
    }));
  });

  it("prevents saving a custom form without exactly one title", () => {
    render(<NoxSpotWidgetConfiguration site={{ ...site, blocks: [{ id: "impact", type: "custom_text" }] }} />);
    expect(screen.getByText("A custom form must contain exactly one title block.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save environments and form" })).toBeDisabled();
  });
});
