import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NoxSpotSite } from "@/lib/types";

const mutate = vi.fn();
vi.mock("@/hooks/useNoxSpot", () => ({
  useUpdateNoxSpotSite: () => ({ mutate, isPending: false, isSuccess: false, isError: false }),
  useCreateNoxSpotSite: vi.fn(),
  useDeleteNoxSpotSite: vi.fn(),
  useNoxSpotSites: vi.fn(),
  useRetryNoxSpotDeliveries: vi.fn(),
  useTestNoxSpotSlack: vi.fn(),
}));

import { NoxSpotDailySummarySettings } from "../NoxSpotSiteManagement";

const site = {
  id: "site-1",
  name: "Playnist",
  dailySummaryEnabled: true,
} as NoxSpotSite;

describe("NoxSpot daily summary settings", () => {
  beforeEach(() => mutate.mockReset());

  it("shows the fixed UTC schedule and saves the enabled state", async () => {
    const user = userEvent.setup();
    render(<NoxSpotDailySummarySettings site={site} />);

    expect(screen.getByText(/previous 24 hours/i)).toBeInTheDocument();
    expect(screen.getByText(/00:00 UTC/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save summary" }));

    expect(mutate).toHaveBeenCalledWith({
      id: "site-1",
      dailySummaryEnabled: true,
    });
  });

  it("can turn the daily post off", async () => {
    const user = userEvent.setup();
    render(<NoxSpotDailySummarySettings site={site} />);
    await user.click(screen.getByRole("checkbox", { name: "Enabled" }));
    await user.click(screen.getByRole("button", { name: "Save summary" }));
    expect(mutate).toHaveBeenCalledWith(expect.objectContaining({ dailySummaryEnabled: false }));
  });
});
