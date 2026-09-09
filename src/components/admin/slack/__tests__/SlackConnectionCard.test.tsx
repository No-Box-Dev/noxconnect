import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({
    invalidateQueries: vi.fn(),
    refetchQueries: vi.fn(),
  }),
}));

vi.mock("@/hooks/useNoxlink", () => ({
  useFeedProjects: () => ({ data: [] }),
}));

vi.mock("@/components/admin/slack/useSlackChannels", () => ({
  useSlackChannels: vi.fn(),
}));

vi.mock("@/components/admin/slack/SlackRouteField", () => ({
  SlackRouteField: () => <div>Organization fallback route</div>,
}));

vi.mock("@/components/admin/slack/SlackChannelStatusBadge", () => ({
  SlackChannelStatusBadge: () => null,
}));

vi.mock("@/lib/slack-api", () => ({
  startSlackOAuth: vi.fn(),
  disconnectSlack: vi.fn(),
  updateSlackConnectionProject: vi.fn(),
}));

import { SlackConnectionCard } from "../SlackConnectionCard";
import { useSlackChannels } from "@/components/admin/slack/useSlackChannels";
import { startSlackOAuth } from "@/lib/slack-api";

const mockUseSlackChannels = vi.mocked(useSlackChannels);
const mockStartSlackOAuth = vi.mocked(startSlackOAuth);

beforeEach(() => {
  vi.clearAllMocks();
  mockStartSlackOAuth.mockReturnValue(new Promise(() => undefined));
  mockUseSlackChannels.mockImplementation((connectionId?: string) => {
    if (connectionId) {
      return {
        channels: { data: [], isLoading: false, isError: false },
        status: { data: undefined, refetch: vi.fn() },
      } as never;
    }
    return {
      status: {
        isLoading: false,
        data: {
          connected: true,
          teamName: "Noboxdev",
          canConfigure: true,
          appConfigured: true,
          needsReconnect: true,
          health: "degraded",
          pendingDeliveries: 0,
          blockedDeliveries: 0,
          lastDeliveredAt: null,
          lastError: null,
          projectAssignmentRequired: true,
          connections: [
            {
              id: "connection-1",
              teamId: "T09A106JFB3",
              teamName: "Noboxdev",
              botUserId: null,
              isDefault: true,
              health: "degraded",
              lastCheckedAt: null,
              lastError: "Reconnect Slack with the currently configured app",
              needsReconnect: true,
              projectId: "proj-noboxdev",
              projectName: "noboxdev",
            },
          ],
        },
      },
    } as never;
  });
});

describe("SlackConnectionCard", () => {
  it("reconnects an affected workspace using its exact team and project", async () => {
    render(<SlackConnectionCard />);

    fireEvent.click(screen.getByRole("button", { name: "Reconnect Noboxdev" }));

    await waitFor(() => {
      expect(mockStartSlackOAuth).toHaveBeenCalledWith({
        team: "T09A106JFB3",
        projectId: "proj-noboxdev",
      });
    });
    expect(screen.getByText(/Use Reconnect on each affected workspace/)).toBeInTheDocument();
  });
});
