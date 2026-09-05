/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  createContext,
  useContext,
  useState,
  useEffect,
  type ReactNode,
} from "react";
import { fetchUser } from "@/lib/github";
import { getOAuthLoginUrl } from "@/lib/oauth-proxy";
import { apiFetch, broadcastError } from "@/lib/api";

interface User {
  login: string;
  avatar_url: string;
  name: string | null;
}

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  authError: string | null;
  loginWithOAuth: () => void;
  logout: () => void;
  selectedOrg: string | null;
  setSelectedOrg: (org: string | null) => void;
}

const AUTH_TIMEOUT_MS = 10_000;

function isRateLimitError(err: unknown): boolean {
  if (err instanceof Error) {
    const status = (err as any).status as number | undefined;
    if (status === 403 || status === 429) return true;
    if (err.message.toLowerCase().includes("rate limit")) return true;
  }
  return false;
}

function isUnauthorizedError(err: unknown): boolean {
  return err instanceof Error && (err as Error & { status?: number }).status === 401;
}

/** Race fetchUser against a timeout so the app never hangs on a bad token. */
function fetchUserWithTimeout(): Promise<User> {
  return Promise.race([
    fetchUser(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Auth timeout")), AUTH_TIMEOUT_MS),
    ),
  ]) as Promise<User>;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const [selectedOrg, setSelectedOrg] = useState<string | null>(
    localStorage.getItem("ut_org"),
  );

  // Listen for force-logout events (fired by api.ts on 401)
  useEffect(() => {
    // One-way migration cleanup: old releases stored the GitHub access token
    // here. It is never read by the session-based client.
    localStorage.removeItem("ut_token");
    const handler = () => {
      localStorage.removeItem("ut_org");
      setUser(null);
      setSelectedOrg(null);
    };
    window.addEventListener("ut:force-logout", handler);
    return () => window.removeEventListener("ut:force-logout", handler);
  }, []);

  // One app-entry signal. The authenticated server decides whether this is a
  // first registration, today's first activity, or an already-recorded visit.
  // Tracking must never block or log out the user if NoxCue is unavailable.
  useEffect(() => {
    if (!user || !selectedOrg) return;
    void apiFetch("/api/app-activity", { method: "POST" }).then((response) => {
      if (!response.ok) {
        console.warn(`[noxconnect] NoxCue user tracking returned ${response.status}`);
      }
    }).catch((error: unknown) => {
      console.warn("[noxconnect] NoxCue user tracking unavailable", error);
    });
  }, [user, selectedOrg]);

  // Cross-tab logout signal. The session itself is HttpOnly and deliberately
  // cannot be synchronized or inspected from JavaScript.
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key === "ut_logout_at" && user) {
        setUser(null);
        setSelectedOrg(null);
      }
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, [user]);

  useEffect(() => {
    // OAuth callback has already created the HttpOnly session server-side.
    const urlParams = new URLSearchParams(window.location.search);
    const loginComplete = urlParams.get("login") === "ok";
    if (loginComplete) {
      window.history.replaceState({}, "", window.location.pathname);
      fetchUserWithTimeout()
        .then((fetched) => {
          if (fetched) setUser(fetched);
          const returnTo = sessionStorage.getItem("ut_return_to");
          if (returnTo) {
            sessionStorage.removeItem("ut_return_to");
            if (returnTo.startsWith("/") && !returnTo.startsWith("//")) window.location.replace(returnTo);
          }
        })
        .catch((err) => {
          if (isRateLimitError(err)) {
            setAuthError("GitHub API rate limit exceeded. Please wait a few minutes and refresh.");
          } else {
            const msg = err instanceof Error ? err.message : "Authentication failed";
            setAuthError(msg);
            broadcastError(msg);
            if (isUnauthorizedError(err)) {
              localStorage.removeItem("ut_org");
            }
          }
        })
        .finally(() => setIsLoading(false));
      return;
    }

    // Dev mode keeps its optional GitHub token in Vite's in-memory build env;
    // it is never copied into browser storage.
    if (import.meta.env.DEV) {
      const devOrg = import.meta.env.VITE_DEV_ORG;
      if (devOrg) {
        localStorage.setItem("ut_org", devOrg);
        // Intentional: one-shot dev-only injection during initial mount.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setSelectedOrg(devOrg);
      }
    }

    fetchUserWithTimeout()
      .then(setUser)
      .catch((err) => {
        if (isRateLimitError(err)) setAuthError("GitHub API rate limit exceeded. Please wait a few minutes and refresh.");
        else if (!isUnauthorizedError(err)) {
          const msg = err instanceof Error ? err.message : "Authentication failed";
          setAuthError(msg);
          broadcastError(msg);
        }
      })
      .finally(() => setIsLoading(false));
  }, []);

  const loginWithOAuth = () => {
    // Remember where the user was headed (e.g. a shared ?org&tab&f link) —
    // the GitHub round-trip lands back on `/?auth_code=…`, losing the query.
    const returnTo = window.location.pathname + window.location.search;
    if (returnTo !== "/") sessionStorage.setItem("ut_return_to", returnTo);
    window.location.href = getOAuthLoginUrl();
  };

  const logout = () => {
    const csrf = document.cookie.split(";").map((value) => value.trim()).find((value) => value.startsWith("nox_csrf="))?.slice(9);
    void fetch("/api/auth/logout", {
      method: "POST",
      credentials: "same-origin",
      headers: csrf ? { "X-CSRF-Token": decodeURIComponent(csrf) } : {},
    });
    localStorage.removeItem("ut_token");
    localStorage.removeItem("ut_org");
    localStorage.setItem("ut_logout_at", String(Date.now()));
    setUser(null);
    setSelectedOrg(null);
  };

  const handleSetOrg = (org: string | null) => {
    setSelectedOrg(org);
    if (org) localStorage.setItem("ut_org", org);
    else localStorage.removeItem("ut_org");
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        isLoading,
        authError,
        loginWithOAuth,
        logout,
        selectedOrg,
        setSelectedOrg: handleSetOrg,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
