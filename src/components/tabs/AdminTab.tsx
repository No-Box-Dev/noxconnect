import { lazy, Suspense, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { CheckCircle2, PlugZap } from "lucide-react";
import { useIsAdmin, useOrgMembers } from "@/hooks/useGitHub";
import { useSettings, useSaveSettings, usePeople, useSavePeople } from "@/hooks/useConfigRepo";
import { useNoxConnect } from "@/hooks/useNoxConnect";
import {
  ADMIN_INTRO,
  getNoxApp,
  isNoxAppEnabled,
  OPTIONAL_NOX_APP_IDS,
  SERVICE_OFF_TEXT,
  type OptionalNoxAppId,
} from "@/lib/apps";
import { Spinner } from "@/components/Spinner";
import { PeopleManagement } from "@/components/settings/PeopleManagement";
import {
  AdminServiceNav,
  type AdminServiceDef,
} from "@/components/admin/AdminSectionNav";
import { AdminGate } from "@/components/admin/AdminGate";
import { GithubConnectionCard } from "@/components/admin/GithubConnectionCard";
import {
  SlackConnectionCard,
  SlackConnectionSummaryCard,
} from "@/components/admin/slack/SlackConnectionCard";
import { ServiceToggle } from "@/components/admin/ServiceActivationCard";
import { NewReposSection } from "@/components/admin/NewReposSection";
import { TrackedReposSection } from "@/components/admin/TrackedReposSection";
import { ProjectRoutingSection } from "@/components/admin/ProjectRoutingSection";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

const ReposTab = lazy(() => import("@/components/tabs/ReposTab").then((module) => ({ default: module.ReposTab })));
const MaintenanceSection = lazy(() => import("@/components/admin/MaintenanceSection").then((module) => ({ default: module.MaintenanceSection })));
const ApiTokensSection = lazy(() => import("@/components/admin/ApiTokensSection").then((module) => ({ default: module.ApiTokensSection })));
const NoxTicketAdminPage = lazy(() => import("@/components/admin/pages/NoxTicketAdminPage").then((module) => ({ default: module.NoxTicketAdminPage })));
const NoxFeedAdminPage = lazy(() => import("@/components/admin/pages/NoxFeedAdminPage").then((module) => ({ default: module.NoxFeedAdminPage })));
const NoxSpotAdminPage = lazy(() => import("@/components/admin/pages/NoxSpotAdminPage").then((module) => ({ default: module.NoxSpotAdminPage })));
const NoxCueAdminPage = lazy(() => import("@/components/admin/pages/NoxCueAdminPage").then((module) => ({ default: module.NoxCueAdminPage })));

const ADMIN_SERVICES: AdminServiceDef[] = [
  { id: "noxconnect", label: "NoxConnect" },
  { id: "noxticket", label: "NoxTicket" },
  { id: "noxfeed", label: "NoxFeed" },
  { id: "noxspot", label: "NoxSpot" },
  { id: "noxcue", label: "NoxCue" },
];

const NOXCONNECT_PANELS = [
  { id: "overview", label: "Overview", description: "Tools and workspace health" },
  { id: "connections", label: "Connections", description: "GitHub and Slack" },
  { id: "people", label: "People", description: "Members and roles" },
  { id: "repositories", label: "Repositories", description: "Tracked workspace data" },
  { id: "security", label: "API access", description: "Automation tokens and scopes" },
  { id: "maintenance", label: "Maintenance", description: "Sync and recovery tools" },
] as const;

type NoxConnectPanelId = typeof NOXCONNECT_PANELS[number]["id"];

function isNoxConnectPanel(value: string | null): value is NoxConnectPanelId {
  return NOXCONNECT_PANELS.some((panel) => panel.id === value);
}

// Each service has a real Admin tab. Only the active tab is mounted, keeping
// setup independent and avoiding background queries for unrelated services.
export function AdminTab({ repoNames = [] }: { repoNames?: string[] }) {
  const isAdmin = useIsAdmin();
  const [searchParams, setSearchParams] = useSearchParams();
  const noxConnect = useNoxConnect();
  const settingsQuery = useSettings();
  const settings = settingsQuery.data;
  const saveSettings = useSaveSettings();
  const [pendingDisable, setPendingDisable] = useState<OptionalNoxAppId | null>(null);
  const focus = searchParams.get("focus");
  const requestedService = searchParams.get("service");
  const rawRequestedSection = searchParams.get("section");
  const requestedNoxConnectPanel = searchParams.get("panel");
  const isLegacyReposLink = rawRequestedSection === "admin-repos" || searchParams.get("tab") === "repos";
  const isLegacyAiLink = rawRequestedSection === "admin-noxconnect" && requestedNoxConnectPanel === "ai";
  const legacyService = rawRequestedSection?.startsWith("admin-") ? rawRequestedSection.slice(6) : null;
  const routedService = isLegacyReposLink ? "noxconnect" : isLegacyAiLink ? "noxfeed" : requestedService ?? legacyService;
  const focusedService = focus === "aiProvider"
    ? "noxfeed"
    : focus === "newRepos" && isNoxAppEnabled(settings, "noxticket")
      ? "noxticket"
      : "noxconnect";
  const activeService = ADMIN_SERVICES.some((section) => section.id === routedService)
    ? routedService!
    : focus ? focusedService : "noxconnect";
  const activeNoxConnectPanel: NoxConnectPanelId = isLegacyReposLink
    ? "repositories"
    : isNoxConnectPanel(requestedNoxConnectPanel)
      ? requestedNoxConnectPanel
      : "overview";

  function toggleApp(appId: OptionalNoxAppId, enabled: boolean) {
    if (!enabled) {
      setPendingDisable(appId);
      return;
    }
    saveAppState(appId, true);
  }

  function saveAppState(appId: OptionalNoxAppId, enabled: boolean) {
    saveSettings.mutate({
      ...(settings ?? {}),
      apps: { ...(settings?.apps ?? {}), [appId]: enabled },
    });
  }

  function confirmDisable() {
    if (!pendingDisable) return;
    saveAppState(pendingDisable, false);
    setPendingDisable(null);
  }

  function selectService(service: string) {
    const params = new URLSearchParams(searchParams);
    params.set("tab", "admin");
    params.set("service", service);
    params.delete("section");
    params.delete("focus");
    params.delete("panel");
    setSearchParams(params, { replace: true });
  }

  function selectNoxConnectPanel(panel: NoxConnectPanelId) {
    const params = new URLSearchParams(searchParams);
    params.set("tab", "admin");
    params.set("service", "noxconnect");
    params.delete("section");
    if (panel === "overview") params.delete("panel");
    else params.set("panel", panel);
    params.delete("focus");
    setSearchParams(params, { replace: true });
  }

  const status = noxConnect.data;
  const settingsReady = settings !== undefined && !settingsQuery.isLoading;
  const noxTicketEnabled = isNoxAppEnabled(settings, "noxticket");
  const noxFeedEnabled = isNoxAppEnabled(settings, "noxfeed");
  const noxSpotEnabled = isNoxAppEnabled(settings, "noxspot");
  const noxCueEnabled = isNoxAppEnabled(settings, "noxcue");
  const connectionsLoading = (
    <div className="bg-white rounded-xl border border-stone-200 p-5 flex justify-center">
      <Spinner className="h-5 w-5 text-accent" />
    </div>
  );
  const connectionsError = (
    <div className="rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-700">
      Could not load connection status.
    </div>
  );

  const setupHeading = !status
    ? ""
    : !status.github.connected
      ? "Connect GitHub to get started"
      : status.github.bootstrapping
        ? "NoxConnect is syncing your organization"
        : !status.github.configured
          ? "NoxConnect needs deployment setup"
          : "The GitHub connection needs attention";

  return (
    <div className="mx-auto max-w-5xl space-y-6" data-tab="admin">
      <AdminServiceNav sections={ADMIN_SERVICES} activeId={activeService} onChange={selectService} />

      <div className="min-w-0">
          {/* NoxConnect — visible to everyone; controls gated per card */}
          {activeService === "noxconnect" ? <section className="space-y-6">
            <div><h1 className="text-xl font-semibold text-stone-900">NoxConnect</h1><p className="mt-1 text-sm text-stone-500">{ADMIN_INTRO}</p></div>
            <div className="grid items-start gap-6 lg:grid-cols-[13rem_minmax(0,1fr)]">
              <NoxConnectNavigation activeId={activeNoxConnectPanel} onChange={selectNoxConnectPanel} />

              <div
                id={`noxconnect-${activeNoxConnectPanel}-panel`}
                role="tabpanel"
                aria-labelledby={`noxconnect-${activeNoxConnectPanel}-tab`}
                className="min-w-0 space-y-6"
              >
                {activeNoxConnectPanel === "overview" ? <>
                  <SectionHeading title="Overview" description="See what is active and what NoxConnect is tracking." />

                  {noxConnect.isError ? connectionsError : status && (
                    <section className={`rounded-xl border p-5 ${status.setup.ready ? "border-green-200 bg-green-50" : "border-amber-200 bg-amber-50"}`}>
                      <div className="flex items-start gap-3">
                        {status.setup.ready
                          ? <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-green-700" />
                          : <PlugZap className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" />}
                        <div>
                          <h2 className={`text-sm font-semibold ${status.setup.ready ? "text-green-900" : "text-amber-900"}`}>
                            {status.setup.ready ? "Everything is connected" : setupHeading}
                          </h2>
                          <p className={`mt-1 text-xs leading-5 ${status.setup.ready ? "text-green-800" : "text-amber-800"}`}>
                            GitHub is required. Slack is optional and can serve every enabled Nox app.
                          </p>
                        </div>
                      </div>
                    </section>
                  )}

                  <section className="rounded-xl border border-stone-200 bg-white p-5">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <h2 className="text-sm font-semibold text-stone-900">Tools</h2>
                        <p className="mt-1 text-xs text-stone-500">Enabled products using this NoxConnect workspace.</p>
                      </div>
                      <span className="rounded-full bg-stone-100 px-2.5 py-1 text-xs font-medium text-stone-600">
                        {OPTIONAL_NOX_APP_IDS.filter((appId) => isNoxAppEnabled(settings, appId)).length} active
                      </span>
                    </div>
                    <div className="mt-4 grid gap-3 sm:grid-cols-2">
                      {OPTIONAL_NOX_APP_IDS.map((appId) => {
                        const app = getNoxApp(appId);
                        const enabled = isNoxAppEnabled(settings, appId);
                        return (
                          <div
                            key={app.id}
                            className={`rounded-lg border p-3 transition-colors ${enabled ? "border-stone-200" : "border-stone-200 bg-stone-50"}`}
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <button
                                  type="button"
                                  onClick={() => selectService(app.id)}
                                  className="text-left text-sm font-medium text-stone-800 hover:text-accent hover:underline"
                                >
                                  {app.name}
                                </button>
                                <p className="mt-1 text-xs leading-5 text-stone-500">
                                  {enabled ? app.includes : `${SERVICE_OFF_TEXT[appId]} Saved data and setup are retained.`}
                                </p>
                              </div>
                              <ServiceToggle
                                app={app}
                                enabled={enabled}
                                disabled={!isAdmin || !settingsReady || saveSettings.isPending}
                                onToggle={toggleApp}
                              />
                            </div>
                            {!isAdmin ? <p className="mt-2 text-[11px] text-stone-400">Only an organization admin can change this switch.</p> : null}
                          </div>
                        );
                      })}
                    </div>
                  </section>

                  <section className="rounded-xl border border-stone-200 bg-white p-5">
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div>
                        <h2 className="text-sm font-semibold text-stone-900">Tracked repositories</h2>
                        <p className="mt-1 text-xs text-stone-500">Repositories supplying shared issues, pull requests, and activity.</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => selectNoxConnectPanel("repositories")}
                        className="text-xs font-medium text-accent hover:underline"
                      >
                        Manage repositories
                      </button>
                    </div>
                    <div className="mt-4 flex items-end gap-3">
                      <span className="text-3xl font-semibold tracking-tight text-stone-900">{repoNames.length}</span>
                      <span className="pb-1 text-xs text-stone-500">tracked</span>
                    </div>
                    {repoNames.length > 0 ? (
                      <div className="mt-4 flex flex-wrap gap-2">
                        {repoNames.slice(0, 8).map((repo) => <span key={repo} className="rounded-md bg-stone-100 px-2 py-1 font-mono text-[11px] text-stone-600">{repo}</span>)}
                        {repoNames.length > 8 ? <span className="px-1 py-1 text-[11px] text-stone-400">+{repoNames.length - 8} more</span> : null}
                      </div>
                    ) : <p className="mt-4 text-xs text-stone-400">No repositories are tracked yet.</p>}
                  </section>
                </> : null}

                {activeNoxConnectPanel === "connections" ? <>
                  <SectionHeading title="Connections" description="Connect the providers shared by every enabled Nox app." />
                  {noxConnect.isLoading
                    ? connectionsLoading
                    : noxConnect.isError
                      ? connectionsError
                      : status && <>
                          <GithubConnectionCard github={status.github} canConfigure={status.canConfigure} setupReady={status.setup.ready} />
                          {status.canConfigure
                            ? <SlackConnectionCard />
                            : <SlackConnectionSummaryCard connected={status.slack.connected} teamName={status.slack.teamName} />}
                        </>}
                </> : null}

                {activeNoxConnectPanel === "people" ? <>
                  <SectionHeading title="People" description="Choose tracked organization members and manage their roles." />
                  <NoxConnectPeoplePanel />
                </> : null}

                {activeNoxConnectPanel === "repositories" ? <>
                  <SectionHeading title="Repositories" description="Choose what NoxConnect tracks, then inspect repository activity." />
                  <NewReposSection />
                  <TrackedReposSection />
                  <AdminGate title="Projects and routing" description="Group repositories into projects and choose project-specific product destinations.">
                    <ProjectRoutingSection />
                  </AdminGate>
                  <SectionHeading title="Repository activity" description="Inspect pull requests, issues, and contribution history for tracked repositories." />
                  <Suspense fallback={connectionsLoading}><ReposTab repoNames={repoNames} /></Suspense>
                </> : null}

                {activeNoxConnectPanel === "maintenance" ? <>
                  <SectionHeading title="Maintenance" description="Use recovery tools only when automatic sync needs help." />
                  <AdminGate title="Maintenance operations" description="Manual syncs, backfills, history recovery, and background failure logs.">
                    <Suspense fallback={connectionsLoading}><MaintenanceSection /></Suspense>
                  </AdminGate>
                </> : null}

                {activeNoxConnectPanel === "security" ? <>
                  <SectionHeading title="API access" description="Create, rotate, and revoke scoped credentials for automation." />
                  <AdminGate title="Automation tokens" description="Tokens grant API access without exposing your GitHub session or provider credentials.">
                    {isAdmin ? <Suspense fallback={connectionsLoading}><ApiTokensSection /></Suspense> : null}
                  </AdminGate>
                </> : null}
              </div>
            </div>
          </section> : null}

          <Suspense fallback={connectionsLoading}>
            {activeService === "noxticket" ? <NoxTicketAdminPage enabled={noxTicketEnabled} isAdmin={isAdmin} settingsReady={settingsReady} isSaving={saveSettings.isPending} hasError={saveSettings.isError} status={status} loading={connectionsLoading} onToggle={(enabled) => toggleApp("noxticket", enabled)} /> : null}
            {activeService === "noxfeed" ? <NoxFeedAdminPage enabled={noxFeedEnabled} isAdmin={isAdmin} settingsReady={settingsReady} isSaving={saveSettings.isPending} hasError={saveSettings.isError} status={status} loading={connectionsLoading} onToggle={(enabled) => toggleApp("noxfeed", enabled)} /> : null}
            {activeService === "noxspot" ? <NoxSpotAdminPage enabled={noxSpotEnabled} isAdmin={isAdmin} settingsReady={settingsReady} isSaving={saveSettings.isPending} hasError={saveSettings.isError} status={status} loading={connectionsLoading} onToggle={(enabled) => toggleApp("noxspot", enabled)} /> : null}
            {activeService === "noxcue" ? <NoxCueAdminPage enabled={noxCueEnabled} isAdmin={isAdmin} settingsReady={settingsReady} isSaving={saveSettings.isPending} hasError={saveSettings.isError} status={status} loading={connectionsLoading} onToggle={(enabled) => toggleApp("noxcue", enabled)} /> : null}
          </Suspense>

      </div>
      <ConfirmDialog
        open={pendingDisable !== null}
        title={pendingDisable ? `Turn off ${getNoxApp(pendingDisable).name}?` : "Turn off service?"}
        message={pendingDisable ? `${SERVICE_OFF_TEXT[pendingDisable]} Saved data and setup are retained for reactivation.` : undefined}
        confirmLabel={pendingDisable ? `Turn off ${getNoxApp(pendingDisable).name}` : "Turn off"}
        variant="danger"
        onConfirm={confirmDisable}
        onCancel={() => setPendingDisable(null)}
      />
    </div>
  );
}

function NoxConnectPeoplePanel() {
  const isAdmin = useIsAdmin();

  return (
    <AdminGate title="People" description="Manage which organization members are tracked and their roles.">
      {isAdmin ? <NoxConnectPeopleSettings /> : null}
    </AdminGate>
  );
}

function NoxConnectPeopleSettings() {
  const settingsQuery = useSettings();
  const saveSettings = useSaveSettings();
  const { data: people } = usePeople();
  const savePeople = useSavePeople();
  const { data: orgMembers } = useOrgMembers();

  return settingsQuery.data ? <PeopleManagement
    people={people ?? []}
    savePeople={savePeople}
    orgMembers={orgMembers ?? []}
    settings={settingsQuery.data}
    saveSettings={saveSettings}
  /> : <div className="rounded-xl border border-stone-200 bg-white p-5"><Spinner className="h-5 w-5 text-accent" /></div>;
}

function NoxConnectNavigation({
  activeId,
  onChange,
}: {
  activeId: NoxConnectPanelId;
  onChange: (panel: NoxConnectPanelId) => void;
}) {
  return (
    <nav
      role="tablist"
      aria-label="NoxConnect settings"
      className="flex gap-1 overflow-x-auto border-b border-stone-200 pb-2 lg:sticky lg:top-20 lg:flex-col lg:overflow-visible lg:border-b-0 lg:pb-0"
    >
      {NOXCONNECT_PANELS.map((panel) => {
        const active = panel.id === activeId;
        return (
          <button
            key={panel.id}
            id={`noxconnect-${panel.id}-tab`}
            type="button"
            role="tab"
            aria-label={panel.label}
            aria-selected={active}
            aria-controls={`noxconnect-${panel.id}-panel`}
            onClick={() => onChange(panel.id)}
            className={`shrink-0 rounded-lg px-3 py-2 text-left transition-colors ${
              active ? "bg-stone-900 text-white" : "text-stone-600 hover:bg-stone-100 hover:text-stone-900"
            }`}
          >
            <span className="block text-sm font-medium">{panel.label}</span>
            <span className={`mt-0.5 hidden text-[11px] lg:block ${active ? "text-stone-300" : "text-stone-400"}`}>
              {panel.description}
            </span>
          </button>
        );
      })}
    </nav>
  );
}

function SectionHeading({ title, description }: { title: string; description: string }) {
  return (
    <div className="border-b border-stone-200 pb-3">
      <h2 className="text-sm font-semibold text-stone-900">{title}</h2>
      <p className="mt-0.5 text-xs text-stone-500">{description}</p>
    </div>
  );
}
