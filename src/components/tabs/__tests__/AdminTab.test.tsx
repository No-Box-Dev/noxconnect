import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("@/lib/auth", () => ({ useAuth: vi.fn() }));
vi.mock("@/hooks/useGitHub", () => ({
  useOrgMembers: vi.fn(() => ({ data: [] })),
  useIsAdmin: vi.fn(() => false),
  useRepos: vi.fn(() => ({ data: [], isLoading: false })),
  useTriggerFeatureSync: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useUnacknowledgedRepos: vi.fn(() => []),
  useAcknowledgeRepos: vi.fn(() => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false })),
}));
vi.mock("@/hooks/useNoxConnect", () => ({ useNoxConnect: vi.fn() }));
vi.mock("@/components/admin/tools/NoxCueSourcesSection", () => ({
  NoxCueSourcesSection: () => <div>Project metric controls</div>,
}));
vi.mock("@/components/SyncFromGithub", () => ({
  SyncFromGithubModal: ({ open }: { open: boolean }) =>
    open ? <div data-testid="sync-modal" /> : null,
}));
vi.mock("@/components/tabs/ReposTab", () => ({
  ReposTab: ({ repoNames }: { repoNames: string[] }) => (
    <div data-testid="admin-repositories">{repoNames.join(",")}</div>
  ),
}));
vi.mock("@/hooks/useConfigRepo", () => ({
  useSettings: vi.fn(),
  useSaveSettings: vi.fn(),
  usePeople: vi.fn(),
  useSavePeople: vi.fn(),
}));
vi.mock("@/hooks/useNoxlink", () => ({
  useFeedProjects: vi.fn(),
  useSetProjectArchived: vi.fn(() => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false })),
}));
vi.mock("@/hooks/useNoxSpot", () => ({
  useNoxSpotSites: vi.fn(() => ({ data: [], isLoading: false })),
  useCreateNoxSpotSite: vi.fn(() => ({ mutate: vi.fn(), isPending: false, isError: false })),
  useUpdateNoxSpotSite: vi.fn(() => ({ mutate: vi.fn(), isPending: false, isError: false })),
  useTestNoxSpotSlack: vi.fn(() => ({ mutate: vi.fn(), isPending: false, isSuccess: false, isError: false })),
  useRetryNoxSpotDeliveries: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
}));
vi.mock("@/lib/noxlink-api", () => ({
  backfillProjectPrs: vi.fn(),
}));
vi.mock("@/lib/github", () => ({
  triggerSyncWithProgress: vi.fn(),
  triggerEventsBackfillWithProgress: vi.fn(),
}));
vi.mock("@/lib/slack-api", () => ({
  fetchSlackStatus: vi.fn(),
  fetchSlackChannels: vi.fn(),
  startSlackOAuth: vi.fn(),
  disconnectSlack: vi.fn(),
}));
vi.mock("@tanstack/react-query", () => {
  const qc = { invalidateQueries: vi.fn(), refetchQueries: vi.fn() };
  return {
    useQueryClient: () => qc,
    useQuery: ({ queryKey }: { queryKey?: string[] }) => ({
      data: queryKey?.[0] === "slack-status"
        ? { connected: true, canConfigure: true, appConfigured: true, health: "ok" }
        : queryKey?.[0] === "slack-channels"
          ? [{ id: "C1", name: "feed", is_private: false }]
          : queryKey?.[0] === "project-routing"
            ? { projects: [], repositories: [] }
          : queryKey?.[0] === "llm-settings"
            ? {
                mode: "managed",
                managed: {
                  provider: "anthropic",
                  model: "claude-haiku-4-5-20251001",
                  available: true,
                  services: {
                    noxfeed: { provider: "anthropic", model: "claude-haiku-4-5-20251001", available: true },
                    noxconnect: { provider: "anthropic", model: "claude-haiku-4-5-20251001", available: true },
                  },
                },
              }
          : { failures: [] },
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch: vi.fn(),
    }),
  };
});

import { AdminTab } from "../AdminTab";
import { useAuth } from "@/lib/auth";
import { useIsAdmin } from "@/hooks/useGitHub";
import { useSettings, useSaveSettings, usePeople, useSavePeople } from "@/hooks/useConfigRepo";
import { useFeedProjects } from "@/hooks/useNoxlink";
import { useNoxConnect } from "@/hooks/useNoxConnect";

const mAuth = useAuth as unknown as ReturnType<typeof vi.fn>;
const mSettings = useSettings as unknown as ReturnType<typeof vi.fn>;
const mSaveSettings = useSaveSettings as unknown as ReturnType<typeof vi.fn>;
const mPeople = usePeople as unknown as ReturnType<typeof vi.fn>;
const mSavePeople = useSavePeople as unknown as ReturnType<typeof vi.fn>;
const mProjects = useFeedProjects as unknown as ReturnType<typeof vi.fn>;
const mIsAdmin = useIsAdmin as unknown as ReturnType<typeof vi.fn>;
const mNoxConnect = useNoxConnect as unknown as ReturnType<typeof vi.fn>;

function serviceButton(name: string) {
  return within(screen.getByRole("navigation", { name: "Admin services" })).getByRole("button", { name });
}

const noxConnectData = {
  canConfigure: true,
  setup: { ready: true, needsOnboarding: false, requiredConnection: "github" },
  github: {
    connected: true,
    configured: true,
    installationId: 1,
    accountLogin: "acme",
    accountType: "Organization",
    bootstrapping: false,
    health: "ok",
    lastEventAt: null,
    manageUrl: "https://github.com/settings",
    installUrl: "https://github.com/install",
  },
  slack: {
    connected: true,
    configured: true,
    needsReconnect: false,
    teamId: "T1",
    teamName: "Acme",
    defaultChannelId: null,
    channels: {},
    health: "ok" as const,
    lastCheckedAt: null,
    lastError: null,
    pendingDeliveries: 0,
    blockedDeliveries: 0,
    lastDeliveredAt: null,
  },
  features: {
    feed: { state: "ready" as const, requirements: ["github"] },
    noxSpot: { state: "ready" as const, requirements: ["github"] },
    noxCue: { state: "ready" as const, requirements: ["slack"], prerequisitesReady: true },
  },
};

beforeEach(() => {
  mAuth.mockReturnValue({
    user: { login: "alice", avatar_url: "https://x/a.png", name: "Alice" },
    selectedOrg: "acme",
    logout: vi.fn(),
  });
  mSettings.mockReturnValue({ data: { excludedMembers: [] } });
  mSaveSettings.mockReturnValue({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
  });
  mPeople.mockReturnValue({ data: [] });
  mSavePeople.mockReturnValue({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
  });
  mProjects.mockReturnValue({ data: [] });
  mIsAdmin.mockReturnValue(false);
  mNoxConnect.mockReturnValue({ data: noxConnectData, isLoading: false, isError: false });
});

describe("AdminTab", () => {
  it("shows active tools and tracked repositories in the overview", () => {
    render(
      <MemoryRouter>
        <AdminTab repoNames={["api", "web"]} />
      </MemoryRouter>,
    );
    expect(screen.getByRole("tab", { name: /Overview/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Everything is connected")).toBeInTheDocument();
    expect(screen.getByText("Tools")).toBeInTheDocument();
    expect(screen.getByText("4 active")).toBeInTheDocument();
    expect(screen.getByText("Tracked repositories")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("api")).toBeInTheDocument();
    expect(screen.getByText("web")).toBeInTheDocument();
    expect(screen.queryByText("Sign out")).not.toBeInTheDocument();
  });

  it("uses the same service warning from Overview and the service page", async () => {
    mIsAdmin.mockReturnValue(true);
    const mutate = vi.fn();
    mSaveSettings.mockReturnValue({ mutate, mutateAsync: vi.fn(), isPending: false });
    render(<MemoryRouter><AdminTab /></MemoryRouter>);

    expect(screen.getByRole("switch", { name: "Turn NoxFeed off" })).toBeEnabled();
    fireEvent.click(screen.getByRole("switch", { name: "Turn NoxFeed off" }));

    const warning = "Feed views, new posts, notes, history backfills, and Slack posts are paused. Saved data and setup are retained for reactivation.";
    expect(screen.getByRole("dialog", { name: "Turn off NoxFeed?" })).toBeInTheDocument();
    expect(screen.getByText(warning)).toBeInTheDocument();
    expect(mutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    fireEvent.click(serviceButton("NoxFeed"));
    fireEvent.click(await screen.findByRole("switch", { name: "Turn NoxFeed off" }));
    expect(screen.getByText(warning)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Turn off NoxFeed" }));

    expect(mutate).toHaveBeenCalledWith({
      excludedMembers: [],
      apps: { noxfeed: false },
    });
  });

  it("names the main and ticket Admin pages Nox and NoxTicket", () => {
    render(
      <MemoryRouter>
        <AdminTab />
      </MemoryRouter>,
    );
    expect(serviceButton("Nox")).toHaveAttribute("aria-current", "page");
    expect(serviceButton("NoxTicket")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "General" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Unticket" })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Maintenance/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Repositories/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: /Connections/ }));
    expect(screen.getByText("GitHub")).toBeInTheDocument();
    expect(screen.getByText("Manage GitHub installation")).toBeInTheDocument();
    expect(screen.getByText("NoxConnect · Slack")).toBeInTheDocument();
  });

  it("gates admin sections for non-admins instead of hiding the layout", () => {
    mIsAdmin.mockReturnValue(false);
    render(
      <MemoryRouter>
        <AdminTab />
      </MemoryRouter>,
    );
    expect(screen.queryByText("Sign out")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: /Maintenance/ }));
    expect(screen.getByText("Maintenance operations")).toBeInTheDocument();
    expect(screen.getByText("Only organization admins can change this setting. Ask an admin to configure it for you.")).toBeInTheDocument();
    // The live maintenance controls are not mounted behind the gate.
    expect(screen.queryByText("Full Re-sync")).not.toBeInTheDocument();
    expect(screen.queryByText("Live Activity Backfill")).not.toBeInTheDocument();
    expect(screen.queryByText("Posts Backfill")).not.toBeInTheDocument();
    expect(screen.queryByText("Background failures")).not.toBeInTheDocument();
    expect(screen.queryByText("Manual sync")).not.toBeInTheDocument();
    expect(screen.queryByText("Sign out")).not.toBeInTheDocument();
  });

  it("mounts only the selected service page for admins", async () => {
    mIsAdmin.mockReturnValue(true);
    render(
      <MemoryRouter>
        <AdminTab />
      </MemoryRouter>,
    );
    expect(screen.queryByText("Posts Backfill")).not.toBeInTheDocument();
    expect(screen.queryByText("Full Re-sync")).not.toBeInTheDocument();

    fireEvent.click(serviceButton("NoxFeed"));
    expect(await screen.findByRole("tab", { name: "Delivery" }, { timeout: 5_000 })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByText("Posts Backfill")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "History" }));
    expect(screen.getByText("Posts Backfill")).toBeInTheDocument();
    expect(screen.queryByText("Full Re-sync")).not.toBeInTheDocument();

    fireEvent.click(serviceButton("Nox"));
    fireEvent.click(screen.getByRole("tab", { name: /Maintenance/ }));
    expect((await screen.findAllByText("Full Re-sync", {}, { timeout: 5_000 })).length).toBeGreaterThan(0);
    expect(screen.getByText("Live Activity Backfill")).toBeInTheDocument();
    expect(screen.getByText("Background failures")).toBeInTheDocument();
    expect(screen.getByText("Manual sync")).toBeInTheDocument();
    expect(screen.getByText("Sync features")).toBeInTheDocument();
    expect(screen.getByText("Sync from GitHub")).toBeInTheDocument();
    fireEvent.click(serviceButton("NoxSpot"));
    expect(await screen.findByText("Site setup", {}, { timeout: 5_000 })).toBeInTheDocument();
    expect(screen.getByText("Add site")).toBeInTheDocument();
    fireEvent.click(serviceButton("NoxCue"));
    expect(await screen.findByText("Project metric controls", {}, { timeout: 5_000 })).toBeInTheDocument();
  });

  it("renders repositories inside Nox", async () => {
    render(<MemoryRouter><AdminTab repoNames={["api", "web"]} /></MemoryRouter>);

    fireEvent.click(screen.getByRole("tab", { name: /Repositories/ }));
    expect(await screen.findByTestId("admin-repositories")).toHaveTextContent("api,web");
    expect(serviceButton("Nox")).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("tab", { name: /Repositories/ })).toHaveAttribute("aria-selected", "true");
  });

  it("renders shared project routing inside NoxConnect for admins", async () => {
    mIsAdmin.mockReturnValue(true);
    render(<MemoryRouter><AdminTab repoNames={["api", "web"]} /></MemoryRouter>);

    fireEvent.click(screen.getByRole("tab", { name: /Repositories/ }));
    expect(await screen.findByText("Projects and routing")).toBeInTheDocument();
    expect(screen.getByText(/Enable only the NoxConnect projects you actually use/i)).toBeInTheDocument();
  });

  it("opens legacy repos links on Nox", async () => {
    render(
      <MemoryRouter initialEntries={["/?tab=repos"]}>
        <AdminTab repoNames={["api"]} />
      </MemoryRouter>,
    );

    expect(serviceButton("Nox")).toHaveAttribute("aria-current", "page");
    expect(await screen.findByTestId("admin-repositories")).toHaveTextContent("api");
  });

  it("shows project channels and organization defaults in the NoxFeed page", async () => {
    mIsAdmin.mockReturnValue(true);
    mSettings.mockReturnValue({ data: { slack: { noxFeedChannelId: "C1" } } });
    render(
      <MemoryRouter>
        <AdminTab />
      </MemoryRouter>,
    );
    fireEvent.click(serviceButton("NoxFeed"));
    await screen.findByRole("heading", { name: "NoxFeed", level: 1 });
    expect(screen.getAllByText("NoxFeed").length).toBeGreaterThan(0);
    expect(screen.getByText(/Choose an enabled NoxConnect project and one channel/i)).toBeInTheDocument();
    expect(screen.getByText(/Enable a project under NoxConnect/i)).toBeInTheDocument();
    expect(screen.getByText("Default channel")).toBeInTheDocument();
    expect(screen.queryByText("Default posts")).not.toBeInTheDocument();
    expect(screen.queryByText("Default release notes")).not.toBeInTheDocument();
    expect(screen.queryByText("AI service")).not.toBeInTheDocument();
  });

  it("persists app toggles while preserving other organization settings", async () => {
    mIsAdmin.mockReturnValue(true);
    const mutate = vi.fn();
    mSettings.mockReturnValue({ data: { excludedMembers: ["bot"], apps: { noxfeed: false } } });
    mSaveSettings.mockReturnValue({ mutate, mutateAsync: vi.fn(), isPending: false });
    render(<MemoryRouter><AdminTab /></MemoryRouter>);

    fireEvent.click(serviceButton("NoxFeed"));
    fireEvent.click(await screen.findByRole("switch", { name: "Turn NoxFeed on" }));
    expect(mutate).toHaveBeenCalledWith({
      excludedMembers: ["bot"],
      apps: { noxfeed: true },
    });
  });

  it("does not mount setup for a disabled app", async () => {
    mIsAdmin.mockReturnValue(true);
    mSettings.mockReturnValue({ data: { apps: { noxfeed: false } } });
    render(<MemoryRouter><AdminTab /></MemoryRouter>);
    fireEvent.click(serviceButton("NoxFeed"));
    expect(await screen.findByRole("switch", { name: "Turn NoxFeed on" })).not.toBeChecked();
    expect(screen.getByText(/Feed views.*saved data and setup are retained/i)).toBeInTheDocument();
    expect(screen.queryByText("Posts Backfill")).not.toBeInTheDocument();
  });

  it("restores the selected Admin page from the canonical URL", async () => {
    mIsAdmin.mockReturnValue(true);
    render(
      <MemoryRouter initialEntries={["/?tab=admin&service=noxfeed"]}>
        <AdminTab />
      </MemoryRouter>,
    );
    expect(serviceButton("NoxFeed")).toHaveAttribute("aria-current", "page");
    expect(await screen.findByRole("tab", { name: "Delivery" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByText("Posts Backfill")).not.toBeInTheDocument();
    expect(screen.queryByText("AI service")).not.toBeInTheDocument();
  });

  it("keeps legacy Admin service URLs compatible", async () => {
    mIsAdmin.mockReturnValue(true);
    render(
      <MemoryRouter initialEntries={["/?tab=admin&section=admin-noxcue"]}>
        <AdminTab />
      </MemoryRouter>,
    );
    expect(serviceButton("NoxCue")).toHaveAttribute("aria-current", "page");
    expect(await screen.findByRole("heading", { name: "NoxCue", level: 1 })).toBeInTheDocument();
  });

  it("routes AI provider deep links to NoxFeed", async () => {
    mIsAdmin.mockReturnValue(true);
    render(
      <MemoryRouter initialEntries={["/?tab=admin&focus=aiProvider"]}>
        <AdminTab />
      </MemoryRouter>,
    );
    expect(serviceButton("NoxFeed")).toHaveAttribute("aria-current", "page");
    expect(await screen.findByText("AI service")).toBeInTheDocument();
  });
});
