import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import { AuthProvider, useAuth } from "../auth";

// Mock dependencies
vi.mock("@/lib/github", () => ({
  fetchUser: vi.fn(),
}));

vi.mock("@/lib/oauth-proxy", () => ({
  getOAuthLoginUrl: vi.fn().mockReturnValue("https://github.com/login/oauth"),
}));

import { fetchUser } from "@/lib/github";

const mockFetchUser = vi.mocked(fetchUser);

let storage: Record<string, string> = {};

function TestConsumer() {
  const auth = useAuth();
  return (
    <div>
      <span data-testid="loading">{String(auth.isLoading)}</span>
      <span data-testid="user">{auth.user?.login ?? "none"}</span>
      <span data-testid="org">{auth.selectedOrg ?? "none"}</span>
      <button onClick={auth.logout}>logout</button>
      <button onClick={() => auth.setSelectedOrg("test-org")}>setOrg</button>
    </div>
  );
}

// Save originals
const originalLocation = window.location;
const originalReplaceState = window.history.replaceState;

beforeEach(() => {
  vi.clearAllMocks();
  mockFetchUser.mockRejectedValue(Object.assign(new Error("Authentication required"), { status: 401 }));
  storage = {};

  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ recorded: "already_active" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  ));

  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage[key] ?? null,
    setItem: (key: string, val: string) => { storage[key] = val; },
    removeItem: (key: string) => { delete storage[key]; },
  });

  // Default location — no query/hash params
  Object.defineProperty(window, "location", {
    value: {
      origin: "http://localhost",
      pathname: "/",
      search: "",
      hash: "",
      href: "http://localhost/",
    },
    writable: true,
    configurable: true,
  });
  window.history.replaceState = vi.fn();

  // By default, import.meta.env has no dev token
  vi.stubEnv("VITE_DEV_TOKEN", "");
  vi.stubEnv("VITE_DEV_ORG", "");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  Object.defineProperty(window, "location", {
    value: originalLocation,
    writable: true,
    configurable: true,
  });
  window.history.replaceState = originalReplaceState;
});

describe("useAuth", () => {
  it("throws outside AuthProvider", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => render(<TestConsumer />)).toThrow(
        "useAuth must be used within AuthProvider",
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("isLoading starts true, becomes false", async () => {
    storage.ut_token = "tok";
    mockFetchUser.mockResolvedValue({ login: "alice", avatar_url: "", name: null } as any);

    render(
      <AuthProvider><TestConsumer /></AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("loading").textContent).toBe("false");
    });
  });

  it("loads the user from the server-side browser session", async () => {
    mockFetchUser.mockResolvedValue({ login: "alice", avatar_url: "", name: "Alice" } as any);

    render(
      <AuthProvider><TestConsumer /></AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("user").textContent).toBe("alice");
    });
  });

  it("records app activity after both user and organization are known", async () => {
    storage.ut_token = "tok";
    storage.ut_org = "org1";
    mockFetchUser.mockResolvedValue({ login: "alice", avatar_url: "", name: "Alice" } as any);

    render(<AuthProvider><TestConsumer /></AuthProvider>);

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith("/api/app-activity", expect.objectContaining({ method: "POST" }));
    });
  });

  it("logs out when another tab emits the logout signal", async () => {
    mockFetchUser.mockResolvedValue({ login: "alice", avatar_url: "", name: "Alice" } as any);
    render(<AuthProvider><TestConsumer /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId("user").textContent).toBe("alice"));

    act(() => {
      window.dispatchEvent(new StorageEvent("storage", {
        key: "ut_logout_at",
        oldValue: null,
        newValue: "123",
      }));
    });

    expect(screen.getByTestId("user").textContent).toBe("none");
  });

  it("no user when no token", async () => {
    render(
      <AuthProvider><TestConsumer /></AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("loading").textContent).toBe("false");
    });
    expect(screen.getByTestId("user").textContent).toBe("none");
  });

  it("removes legacy token storage even when startup authentication is temporarily unavailable", async () => {
    storage.ut_token = "still-refreshable";
    const temporary = Object.assign(new Error("Session refresh temporarily unavailable"), { status: 503 });
    mockFetchUser.mockRejectedValue(temporary);

    render(<AuthProvider><TestConsumer /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId("loading").textContent).toBe("false"));

    expect(storage.ut_token).toBeUndefined();
  });

  it("clears the stored session after a confirmed startup 401", async () => {
    storage.ut_token = "revoked";
    const unauthorized = Object.assign(new Error("Token expired or revoked"), { status: 401 });
    mockFetchUser.mockRejectedValue(unauthorized);

    render(<AuthProvider><TestConsumer /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId("loading").textContent).toBe("false"));

    expect(storage.ut_token).toBeUndefined();
  });

  it("OAuth callback: consumes the server-created session without exposing a token", async () => {
    Object.defineProperty(window, "location", {
      value: {
        origin: "http://localhost",
        pathname: "/",
        search: "?login=ok",
        hash: "",
        href: "http://localhost/?login=ok",
      },
      writable: true,
      configurable: true,
    });
    mockFetchUser.mockResolvedValue({ login: "oauth-user", avatar_url: "", name: null } as any);

    render(
      <AuthProvider><TestConsumer /></AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("user").textContent).toBe("oauth-user");
    });
    expect(storage.ut_token).toBeUndefined();
    expect(window.history.replaceState).toHaveBeenCalled();
  });

  it("logout: clears localStorage, resets user + org", async () => {
    storage.ut_token = "tok";
    storage.ut_org = "org1";
    mockFetchUser.mockResolvedValue({ login: "alice", avatar_url: "", name: null } as any);

    render(
      <AuthProvider><TestConsumer /></AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("user").textContent).toBe("alice");
    });

    await act(async () => {
      screen.getByText("logout").click();
    });

    expect(screen.getByTestId("user").textContent).toBe("none");
    expect(screen.getByTestId("org").textContent).toBe("none");
    expect(storage.ut_token).toBeUndefined();
    expect(storage.ut_org).toBeUndefined();
  });

  it("setSelectedOrg persists to localStorage", async () => {
    render(
      <AuthProvider><TestConsumer /></AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("loading").textContent).toBe("false");
    });

    await act(async () => {
      screen.getByText("setOrg").click();
    });

    expect(screen.getByTestId("org").textContent).toBe("test-org");
    expect(storage.ut_org).toBe("test-org");
  });

});
