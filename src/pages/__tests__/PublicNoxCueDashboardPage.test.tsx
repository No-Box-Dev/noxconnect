import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { PublicNoxCueDashboardPage } from "../PublicNoxCueDashboardPage";

describe("public NoxCue dashboard sections", () => {
  afterEach(() => vi.restoreAllMocks());

  it("separates stats from alerts and expands retained error occurrences", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      project: { name: "Playnist" }, generatedAt: "2026-09-04T10:00:00Z",
      sources: [{
        id: "source-1", name: "playnist-web", environment: "production", period: "2026-09-03",
        settings: { collecting: true, digestEnabled: true, alertsEnabled: true, timezone: "UTC", digestTimeLocal: "00:00" },
        endpoint: { enabled: false, url: null, status: "waiting", lastCheckedAt: null, statusCode: null, latencyMs: null, error: null },
        metrics: {}, comparisons: {}, metricLabels: {}, features: [{
          key: "auth.signup", label: "Sign up", description: "Can a new user create an account?",
          failureMessage: "A user was prevented from signing up.", status: "issue",
          lastResultAt: "2026-09-04T09:00:01Z", lastFailureAt: "2026-09-03T08:00:00Z",
          lastSuccessAt: "2026-09-04T09:00:00Z", incidentStartedAt: "2026-09-03T08:00:00Z",
          consecutiveFailures: 1, successfulAttemptsSinceLastFailure: 2,
          lastReason: "dependency_unavailable", successes24h: 2, rejections24h: 0, failures24h: 0,
          results: [{
            id: "feature-event-1", outcome: "failure", reason: "dependency_unavailable",
            message: "Auth provider request failed", error: { name: "AuthError", message: "Provider unavailable", code: "AUTH_503", status: 503, stack: "AuthError: Provider unavailable\n at signup.ts:42" },
            context: { environment: "production", release: "playnist@abc123", runtime: "browser", url: "https://app.playnist.com/signup" },
            diagnosis: {
              summary: "Sign up failed: dependency unavailable.",
              possibleCauses: ["The authentication provider returned a server error."],
              possibleFixes: ["Check provider status and request logs.", "Verify production credentials."],
            },
            durationMs: 842, occurredAt: "2026-09-03T08:00:00Z", receivedAt: "2026-09-03T08:00:02Z",
          }],
        }],
        errors: [{
          fingerprint: "resize-loop", title: "ResizeObserver loop completed", errorCode: "RESIZE_LOOP", component: "playnist-web",
          firstSeenAt: "2026-09-03T09:00:00Z", lastSeenAt: "2026-09-03T10:00:00Z", occurrenceCount: 2,
          status: "open", acknowledgedAt: null, acknowledgedBy: null, resolvedAt: null, resolvedBy: null,
          occurrences: [{
            id: "event-2", message: "ResizeObserver loop completed with undelivered notifications.",
            occurredAt: "2026-09-03T10:00:00Z", receivedAt: "2026-09-03T10:00:01Z",
            url: "https://app.playnist.com/signup", errorCode: "RESIZE_LOOP", component: "playnist-web",
            environment: "production", release: "playnist@abc123", runtime: "browser",
            errorName: "Error", errorStack: "Error: ResizeObserver loop", errorStatus: 500, fatal: false, unhandled: true,
          }],
        }],
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    render(<MemoryRouter initialEntries={["/cue/dashboard-token"]}>
      <Routes><Route path="/cue/:slug" element={<PublicNoxCueDashboardPage />} /></Routes>
    </MemoryRouter>);

    const statsTab = await screen.findByRole("tab", { name: "Stats" });
    const alertsTab = screen.getByRole("tab", { name: "Alerts" });
    expect(statsTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveAccessibleName("Stats");
    expect(screen.queryByText("ResizeObserver loop completed")).not.toBeInTheDocument();

    fireEvent.click(alertsTab);
    expect(alertsTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveAccessibleName("Alerts");

    expect(screen.getByText("Open incidents")).toBeInTheDocument();
    expect(screen.getByText("No new failures in 24h", { exact: false })).toBeInTheDocument();
    const incident = screen.getByRole("button", { name: /Action required Sign up/ });
    expect(incident).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(incident);
    expect(incident).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByText("playnist-web ·", { exact: false }).length).toBeGreaterThan(0);
    expect(screen.getByText("Auth provider request failed")).toBeInTheDocument();
    expect(screen.getByText("AuthError: Provider unavailable", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("Possible causes")).toBeInTheDocument();
    expect(screen.getByText("Check provider status and request logs.")).toBeInTheDocument();
    expect(screen.getAllByText("release playnist@abc123").length).toBeGreaterThan(0);
    expect(screen.getByText(/received 2s later/)).toBeInTheDocument();

    const group = screen.getByRole("button", { name: /ResizeObserver loop completed/ });
    expect(group).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(group);

    expect(group).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("ResizeObserver loop completed with undelivered notifications.")).toBeInTheDocument();
    expect(screen.getByText("Unhandled")).toBeInTheDocument();
    expect(screen.getByText("Error: ResizeObserver loop")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "https://app.playnist.com/signup" })[0]).toHaveAttribute("href", "https://app.playnist.com/signup");
    expect(screen.getByText("Showing the latest 1 retained occurrence of 2 total.")).toBeInTheDocument();
  });
});
