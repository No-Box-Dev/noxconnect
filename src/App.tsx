import { lazy, Suspense, useEffect } from "react";
import { Routes, Route, useLocation, useSearchParams } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { useOrgs } from "@/hooks/useGitHub";
import { LoginPage } from "@/pages/LoginPage";
import { OrgPickerPage } from "@/pages/OrgPickerPage";
import { DashboardPage } from "@/pages/DashboardPage";
import { Spinner } from "@/components/Spinner";
import { Toaster } from "@/components/Toaster";
import { ProjectProvider } from "@/lib/project";

const IssueDetailPage = lazy(() =>
  import("@/pages/details/IssueDetailPage").then((m) => ({ default: m.IssueDetailPage })),
);
const PrDetailPage = lazy(() =>
  import("@/pages/details/PrDetailPage").then((m) => ({ default: m.PrDetailPage })),
);
const RepoIssuesPage = lazy(() =>
  import("@/pages/lists/IssueListPages").then((m) => ({ default: m.RepoIssuesPage })),
);
const StaleIssuesPage = lazy(() =>
  import("@/pages/lists/IssueListPages").then((m) => ({ default: m.StaleIssuesPage })),
);
const LabelIssuesPage = lazy(() =>
  import("@/pages/lists/IssueListPages").then((m) => ({ default: m.LabelIssuesPage })),
);
const AssigneeIssuesPage = lazy(() =>
  import("@/pages/lists/IssueListPages").then((m) => ({ default: m.AssigneeIssuesPage })),
);
const UnassignedIssuesPage = lazy(() =>
  import("@/pages/lists/IssueListPages").then((m) => ({ default: m.UnassignedIssuesPage })),
);
const RepoPrsPage = lazy(() =>
  import("@/pages/lists/PrListPages").then((m) => ({ default: m.RepoPrsPage })),
);
const AuthorPrsPage = lazy(() =>
  import("@/pages/lists/PrListPages").then((m) => ({ default: m.AuthorPrsPage })),
);
const DraftPrsPage = lazy(() =>
  import("@/pages/lists/PrListPages").then((m) => ({ default: m.DraftPrsPage })),
);
const StalePrsPage = lazy(() =>
  import("@/pages/lists/PrListPages").then((m) => ({ default: m.StalePrsPage })),
);
const OperatorPage = lazy(() => import("@/pages/OperatorPage"));

function PageFallback() {
  return (
    <div className="min-h-screen bg-stone-50 flex items-center justify-center">
      <Spinner className="w-6 h-6 text-accent" />
    </div>
  );
}

function AuthenticatedRoutes() {
  return (
    <Suspense fallback={<PageFallback />}>
      <Routes>
        <Route path="/issues/:repo/:number" element={<IssueDetailPage />} />
        <Route path="/prs/:repo/:number" element={<PrDetailPage />} />
        <Route path="/issues/stale" element={<StaleIssuesPage />} />
        <Route path="/issues/unassigned" element={<UnassignedIssuesPage />} />
        <Route path="/issues/repo/:repo" element={<RepoIssuesPage />} />
        <Route path="/issues/label/:label" element={<LabelIssuesPage />} />
        <Route path="/issues/assignee/:login" element={<AssigneeIssuesPage />} />
        <Route path="/prs/stale" element={<StalePrsPage />} />
        <Route path="/prs/draft" element={<DraftPrsPage />} />
        <Route path="/prs/repo/:repo" element={<RepoPrsPage />} />
        <Route path="/prs/author/:login" element={<AuthorPrsPage />} />
        <Route path="*" element={<DashboardPage />} />
      </Routes>
    </Suspense>
  );
}

function PrivateApp() {
  const { user, isLoading, authError, selectedOrg, setSelectedOrg } = useAuth();
  const { data: orgs, isLoading: orgsLoading } = useOrgs();
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const isOperatorRoute = location.pathname === "/operator";

  // Shared links carry `?org=` (see lib/share-links.ts) so a colleague lands
  // on the right workspace even if their last-selected org differs. Apply it
  // once the org list is known, then strip it from the URL. An org the user
  // isn't a member of is stripped without switching — the rest of the link
  // resolves (or not) against their own workspace.
  useEffect(() => {
    if (!user || !orgs) return;
    const orgParam = searchParams.get("org");
    if (!orgParam) return;

    if (orgParam !== selectedOrg && orgs.some((o) => o.login === orgParam)) {
      setSelectedOrg(orgParam);
    }
    const params = new URLSearchParams(searchParams);
    params.delete("org");
    setSearchParams(params, { replace: true });
  }, [user, orgs, searchParams, selectedOrg, setSelectedOrg, setSearchParams]);

  // Validate stored org is an actual org (not personal account)
  // and auto-select if there's only one org
  useEffect(() => {
    if (!user || !orgs) return;

    const orgLogins = orgs.map((o) => o.login);

    // If selected org is the user's personal account, clear it
    if (selectedOrg && selectedOrg === user.login) {
      setSelectedOrg(null);
      return;
    }

    // Auto-select if there's only one org and none selected
    if (!selectedOrg && orgLogins.length === 1) {
      setSelectedOrg(orgLogins[0]);
    }
  }, [user, orgs, selectedOrg, setSelectedOrg]);

  if (authError) {
    return (
      <>
        <Toaster />
        <div className="min-h-screen bg-stone-50 flex items-center justify-center">
          <div className="text-center space-y-3 max-w-sm mx-auto px-4">
            <div className="text-amber-600 text-sm font-medium">{authError}</div>
            <button
              onClick={() => window.location.reload()}
              className="px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:bg-accent/90 cursor-pointer"
            >
              Retry
            </button>
          </div>
        </div>
      </>
    );
  }

  if (isLoading || (user && orgsLoading)) {
    return (
      <>
        <Toaster />
        <div className="min-h-screen bg-stone-50 flex items-center justify-center">
          <Spinner size="lg" />
        </div>
      </>
    );
  }

  if (!user) return <><Toaster /><LoginPage /></>;
  if (isOperatorRoute) return <><Toaster /><Suspense fallback={<PageFallback />}><OperatorPage /></Suspense></>;
  if (!selectedOrg) return <><Toaster /><OrgPickerPage /></>;
  return <><Toaster /><ProjectProvider><AuthenticatedRoutes /></ProjectProvider></>;
}

export function App() {
  return <Routes><Route path="*" element={<PrivateApp />} /></Routes>;
}
