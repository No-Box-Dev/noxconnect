import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("@/lib/auth", () => ({ useAuth: vi.fn() }));
vi.mock("@/hooks/useGitHub", () => ({ useOrgs: vi.fn() }));
vi.mock("@/lib/project", () => ({ ProjectProvider: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("@/pages/LoginPage", () => ({
  LoginPage: () => <div data-testid="login-page" />,
}));
vi.mock("@/pages/OrgPickerPage", () => ({
  OrgPickerPage: () => <div data-testid="org-picker" />,
}));
vi.mock("@/pages/DashboardPage", () => ({
  DashboardPage: () => <div data-testid="dashboard" />,
}));

import { App } from "../App";
import { useAuth } from "@/lib/auth";
import { useOrgs } from "@/hooks/useGitHub";

const mAuth = useAuth as unknown as ReturnType<typeof vi.fn>;
const mOrgs = useOrgs as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mAuth.mockReset();
  mOrgs.mockReset();
});

function renderApp() {
  return render(
    <MemoryRouter>
      <App />
    </MemoryRouter>,
  );
}

describe("App", () => {
  it("renders authError view with Retry button", () => {
    mAuth.mockReturnValue({
      user: null,
      isLoading: false,
      authError: "Something broke",
      selectedOrg: null,
      setSelectedOrg: vi.fn(),
    });
    mOrgs.mockReturnValue({ data: undefined, isLoading: false });
    renderApp();
    expect(screen.getByText("Something broke")).toBeInTheDocument();
    expect(screen.getByText("Retry")).toBeInTheDocument();
  });

  it("renders spinner while auth is loading", () => {
    mAuth.mockReturnValue({
      user: null,
      isLoading: true,
      authError: null,
      selectedOrg: null,
      setSelectedOrg: vi.fn(),
    });
    mOrgs.mockReturnValue({ data: undefined, isLoading: false });
    const { container } = renderApp();
    expect(container.querySelector(".animate-spin")).not.toBeNull();
  });

  it("shows the LoginPage when there is no user", () => {
    mAuth.mockReturnValue({
      user: null,
      isLoading: false,
      authError: null,
      selectedOrg: null,
      setSelectedOrg: vi.fn(),
    });
    mOrgs.mockReturnValue({ data: undefined, isLoading: false });
    renderApp();
    expect(screen.getByTestId("login-page")).toBeInTheDocument();
  });

  it("shows the OrgPickerPage when user exists but no org selected", () => {
    mAuth.mockReturnValue({
      user: { login: "alice" },
      isLoading: false,
      authError: null,
      selectedOrg: null,
      setSelectedOrg: vi.fn(),
    });
    mOrgs.mockReturnValue({ data: [], isLoading: false });
    renderApp();
    expect(screen.getByTestId("org-picker")).toBeInTheDocument();
  });

  it("auto-selects the single org when user has exactly one", () => {
    const setSelectedOrg = vi.fn();
    mAuth.mockReturnValue({
      user: { login: "alice" },
      isLoading: false,
      authError: null,
      selectedOrg: null,
      setSelectedOrg,
    });
    mOrgs.mockReturnValue({
      data: [{ login: "acme" }],
      isLoading: false,
    });
    renderApp();
    expect(setSelectedOrg).toHaveBeenCalledWith("acme");
  });

  it("clears selectedOrg when it equals the user's personal login", () => {
    const setSelectedOrg = vi.fn();
    mAuth.mockReturnValue({
      user: { login: "alice" },
      isLoading: false,
      authError: null,
      selectedOrg: "alice",
      setSelectedOrg,
    });
    mOrgs.mockReturnValue({
      data: [{ login: "acme" }, { login: "beta" }],
      isLoading: false,
    });
    renderApp();
    expect(setSelectedOrg).toHaveBeenCalledWith(null);
  });

  it("renders the Dashboard when user and org are set", () => {
    mAuth.mockReturnValue({
      user: { login: "alice" },
      isLoading: false,
      authError: null,
      selectedOrg: "acme",
      setSelectedOrg: vi.fn(),
    });
    mOrgs.mockReturnValue({
      data: [{ login: "acme" }],
      isLoading: false,
    });
    renderApp();
    expect(screen.getByTestId("dashboard")).toBeInTheDocument();
  });

  it("Toaster surfaces 'ut:error' window events and dismisses on click", () => {
    mAuth.mockReturnValue({
      user: null,
      isLoading: false,
      authError: null,
      selectedOrg: null,
      setSelectedOrg: vi.fn(),
    });
    mOrgs.mockReturnValue({ data: undefined, isLoading: false });
    renderApp();
    act(() => {
      window.dispatchEvent(
        new CustomEvent("ut:error", {
          detail: { message: "Boom", status: 500 },
        }),
      );
    });
    expect(screen.getByText("Boom")).toBeInTheDocument();
    expect(screen.getByText("500")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(screen.queryByText("Boom")).not.toBeInTheDocument();
  });
});
