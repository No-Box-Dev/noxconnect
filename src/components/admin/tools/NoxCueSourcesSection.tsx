import { useMemo, useState } from "react";
import { Activity, AlertTriangle, Check, CheckCircle2, CircleDashed, Clipboard, ExternalLink, KeyRound, Plus, RefreshCw, Send, Server, Share2, ShieldCheck, Trash2 } from "lucide-react";
import { Spinner } from "@/components/Spinner";
import { useSlackChannels } from "@/components/admin/slack/useSlackChannels";
import { ConfirmDialog, useConfirm } from "@/components/ui/ConfirmDialog";
import { SearchableSelect } from "@/components/ui/SearchableSelect";
import {
  useCreateNoxCueFeature,
  useCreateNoxCueCustomMetric,
  useCreateNoxCueKey,
  useCreateNoxCueSource,
  useDeleteNoxCueFeature,
  useDeleteNoxCueCustomMetric,
  useDeleteNoxCueDashboardShare,
  useDeleteNoxCueSource,
  useNoxCueMetrics,
  useNoxCueCustomMetrics,
  useNoxCueDashboardShares,
  useNoxCueFeatures,
  useNoxCueProjectMetrics,
  useNoxCueSources,
  useRevokeNoxCueKey,
  useSaveNoxCueFeature,
  useSaveNoxCueCustomMetric,
  useSaveNoxCueSource,
  useSaveNoxCueProjectMetrics,
  useTestNoxCueEndpoint,
  useUpsertNoxCueDashboardShare,
} from "@/hooks/useNoxCue";
import type { IntegrationsStatus } from "@/lib/integrations-api";
import { apiPost } from "@/lib/api";
import type { NoxCueCustomMetricsResponse, NoxCueEnvironment, NoxCueFeaturesResponse, NoxCueSource, NoxCueSourceInput, NoxCueUserMetricKey } from "@/lib/noxcue-api";
import { findSlackChannelStatus } from "@/lib/slack-channel-status";

const EMPTY_SOURCE: NoxCueSourceInput = {
  name: "",
  environment: "production",
  enabled: true,
  alertsEnabled: true,
  projectId: null,
  timezone: "UTC",
  digestEnabled: true,
  digestTimeLocal: "00:30",
  slackChannelId: null,
  slackConnectionId: null,
  allowedOrigins: [],
  healthEnabled: false,
  healthUrl: null,
};

const USER_STAT_KEYS = [
  "users.new",
  "users.total",
  "users.active.daily",
  "users.active.weekly",
  "users.active.monthly",
  "users.stickiness.dau_mau",
] as const;

const ENVIRONMENTS: Array<{ value: NoxCueEnvironment; label: string }> = [
  { value: "production", label: "Production" },
  { value: "staging", label: "Staging" },
  { value: "development", label: "Development" },
  { value: "preview", label: "Preview" },
  { value: "test", label: "Test" },
  { value: "local", label: "Local" },
];

function environmentLabel(environment: NoxCueEnvironment) {
  return ENVIRONMENTS.find((candidate) => candidate.value === environment)?.label ?? environment;
}

function sourceLabel(source: Pick<NoxCueSource, "name" | "environment">) {
  return source.name.toLowerCase().includes(source.environment)
    ? source.name
    : `${source.name} · ${environmentLabel(source.environment)}`;
}

export function NoxCueSourcesSection({ noxConnect }: { noxConnect: IntegrationsStatus }) {
  const sources = useNoxCueSources();
  const createSource = useCreateNoxCueSource();
  const saveSource = useSaveNoxCueSource();
  const deleteSource = useDeleteNoxCueSource();
  const [selectedId, setSelectedId] = useState("");
  const [creating, setCreating] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, NoxCueSourceInput>>({});
  const [checkingEvents, setCheckingEvents] = useState(false);
  const [checkedWithoutEvent, setCheckedWithoutEvent] = useState(false);

  const selected = useMemo(
    () => sources.data?.sources.find((source) => source.id === selectedId) ?? sources.data?.sources[0],
    [selectedId, sources.data],
  );
  const stored: NoxCueSourceInput = selected ? {
    name: selected.name,
    environment: selected.environment,
    enabled: selected.enabled,
    alertsEnabled: selected.alertsEnabled,
    projectId: selected.projectId,
    timezone: selected.timezone,
    digestEnabled: selected.digestEnabled,
    digestTimeLocal: selected.digestTimeLocal,
    slackChannelId: selected.slackChannelId,
    slackConnectionId: selected.slackConnectionId,
    allowedOrigins: selected.allowedOrigins,
    healthEnabled: selected.healthEnabled,
    healthUrl: selected.healthUrl,
  } : EMPTY_SOURCE;
  const sourceDefaults = useMemo<NoxCueSourceInput>(() => ({
    ...EMPTY_SOURCE,
    projectId: sources.data?.projects.length === 1 ? sources.data.projects[0]!.id : null,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  }), [sources.data?.projects]);
  const draftKey = creating ? "new" : selected?.id ?? "new";
  const draft = drafts[draftKey] ?? (creating ? sourceDefaults : stored);
  const environmentLocked = !creating && Boolean(selected?.keys.some((key) => key.lastUsedAt));
  const setDraft = (next: NoxCueSourceInput) => setDrafts((current) => ({ ...current, [draftKey]: next }));

  if (sources.isLoading) return <Panel><Spinner className="h-5 w-5 text-accent" /></Panel>;
  if (sources.isError || !sources.data) return <Panel>Could not load NoxCue sources.</Panel>;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (creating) {
      createSource.mutate(draft, {
        onSuccess: ({ id }) => {
          setSelectedId(id);
          setCreating(false);
          setDrafts({});
          setCheckedWithoutEvent(false);
        },
      });
    } else if (selected) {
      saveSource.mutate({ sourceId: selected.id, input: draft });
    }
  };

  const checkForEvents = async () => {
    if (!selected) return;
    setCheckingEvents(true);
    const result = await sources.refetch();
    const refreshed = result.data?.sources.find((source) => source.id === selected.id);
    setCheckedWithoutEvent(Boolean(refreshed && !lastUserEventAt(refreshed)));
    setCheckingEvents(false);
  };

  return (
    <div className="space-y-6">
      <form onSubmit={submit} className="space-y-5 rounded-xl border border-stone-200 bg-white p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-stone-900">App environments</h3>
            <p className="mt-1 text-xs text-stone-500">Create one source for each app environment that sends events to NoxCue.</p>
          </div>
          <button type="button" onClick={() => { setCreating(true); setDrafts({ new: sourceDefaults }); setCheckedWithoutEvent(false); }} className="flex items-center gap-1 rounded-lg border border-stone-200 px-3 py-2 text-xs font-medium text-stone-700">
            <Plus size={13} /> New source
          </button>
        </div>

        {!creating && sources.data.sources.length ? (
          <label className="block text-sm font-medium text-stone-700">Source
            <select value={selected?.id ?? ""} onChange={(event) => { setSelectedId(event.target.value); setDrafts({}); setCheckedWithoutEvent(false); }} className="mt-1 block w-full rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm">
              {sources.data.sources.map((source) => <option key={source.id} value={source.id}>{sourceLabel(source)}</option>)}
            </select>
          </label>
        ) : null}

        {creating || selected ? <>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="text-sm font-medium text-stone-700">App name
              <input required value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="Playnist" className="mt-1 block w-full rounded-lg border border-stone-200 px-3 py-2 text-sm" />
            </label>
            <label className="text-sm font-medium text-stone-700">Linked project <span className="font-normal text-stone-400">{sources.data.projects.length > 1 ? "required" : "automatically selected"}</span>
              <select required={sources.data.projects.length > 1} disabled={sources.data.projects.length === 1} value={draft.projectId ?? ""} onChange={(event) => setDraft({ ...draft, projectId: event.target.value || null })} className="mt-1 block w-full rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm disabled:bg-stone-50">
                <option value="">{sources.data.projects.length > 1 ? "Choose a project" : "No project available"}</option>
                {sources.data.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
              </select>
            </label>
            <label className="text-sm font-medium text-stone-700">Environment
              <select disabled={environmentLocked} value={draft.environment} onChange={(event) => setDraft({ ...draft, environment: event.target.value as NoxCueEnvironment })} className="mt-1 block w-full rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm disabled:bg-stone-50">
                {ENVIRONMENTS.map((environment) => <option key={environment.value} value={environment.value}>{environment.label}</option>)}
              </select>
              <span className="mt-1 block text-[11px] font-normal text-stone-400">{environmentLocked ? "Locked after the first event. Create another source for a different environment." : "The source key only accepts events for this environment."}</span>
            </label>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="text-sm font-medium text-stone-700">Timezone
              <input required value={draft.timezone} onChange={(event) => setDraft({ ...draft, timezone: event.target.value })} placeholder="Asia/Kuala_Lumpur" className="mt-1 block w-full rounded-lg border border-stone-200 px-3 py-2 text-sm" />
            </label>
            <label className="text-sm font-medium text-stone-700">Post after
              <input type="time" required value={draft.digestTimeLocal} onChange={(event) => setDraft({ ...draft, digestTimeLocal: event.target.value })} className="mt-1 block w-full rounded-lg border border-stone-200 px-3 py-2 text-sm" />
            </label>
          </div>
          <SlackDestination draft={draft} setDraft={setDraft} />
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="text-sm font-medium text-stone-700">Browser origins
              <textarea value={draft.allowedOrigins.join("\n")} onChange={(event) => setDraft({ ...draft, allowedOrigins: event.target.value.split(/\s+/).map((value) => value.trim().replace(/\/$/, "")).filter(Boolean) })} placeholder="https://app.example.com" rows={2} className="mt-1 block w-full rounded-lg border border-stone-200 px-3 py-2 text-sm" />
              <span className="mt-1 block text-[11px] font-normal text-stone-400">Exact origins only, one per line. Required for browser auth health.</span>
            </label>
            <label className="text-sm font-medium text-stone-700">Public health URL
              <input type="url" value={draft.healthUrl ?? ""} onChange={(event) => setDraft({ ...draft, healthUrl: event.target.value || null })} placeholder="https://app.example.com/health" className="mt-1 block w-full rounded-lg border border-stone-200 px-3 py-2 text-sm" />
              <span className="mt-1 flex items-center gap-2 text-[11px] font-normal text-stone-500"><input type="checkbox" checked={draft.healthEnabled} onChange={(event) => setDraft({ ...draft, healthEnabled: event.target.checked })} /> Check every minute</span>
            </label>
          </div>
          <div className="space-y-3 rounded-lg border border-stone-200 bg-stone-50 p-4">
            <div><p className="text-sm font-medium text-stone-800">Environment controls</p><p className="mt-1 text-xs text-stone-500">Collection and Slack delivery are independent. You can keep staging data visible without notifying the team.</p></div>
            <label className="flex items-start gap-2 text-sm text-stone-700"><input className="mt-0.5" type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} /><span><span className="block font-medium">Collect events</span><span className="block text-xs text-stone-500">Accept and store events for {environmentLabel(draft.environment).toLowerCase()}.</span></span></label>
            <label className="flex items-start gap-2 text-sm text-stone-700"><input className="mt-0.5" type="checkbox" checked={draft.digestEnabled} onChange={(event) => setDraft({ ...draft, digestEnabled: event.target.checked })} /><span><span className="block font-medium">Send daily digest</span><span className="block text-xs text-stone-500">Post the completed-day user stats after {draft.digestTimeLocal} {draft.timezone}.</span></span></label>
            <label className="flex items-start gap-2 text-sm text-stone-700"><input className="mt-0.5" type="checkbox" checked={draft.alertsEnabled} onChange={(event) => setDraft({ ...draft, alertsEnabled: event.target.checked })} /><span><span className="block font-medium">Send immediate alerts</span><span className="block text-xs text-stone-500">Post feature failures, unregistered events, errors, and endpoint incidents.</span></span></label>
          </div>
          <div className="flex items-center gap-3 border-t border-stone-100 pt-4">
            <button disabled={createSource.isPending || saveSource.isPending || (sources.data.projects.length > 1 && !draft.projectId)} className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{creating ? "Create source" : "Save settings"}</button>
            {!creating && selected ? <DeleteSourceButton sourceId={selected.id} sourceName={selected.name} mutation={deleteSource} onDeleted={() => setSelectedId("")} /> : null}
            {saveSource.isSuccess || createSource.isSuccess ? <span className="flex items-center gap-1 text-xs text-green-700"><Check size={13} /> Saved</span> : null}
          </div>
          {createSource.isError || saveSource.isError ? <p className="text-xs text-red-600">{(createSource.error ?? saveSource.error) instanceof Error ? (createSource.error ?? saveSource.error)?.message : "Could not save this source."}</p> : null}
        </> : <p className="text-sm text-stone-500">Create your first source to get a server ingest key.</p>}
      </form>

      {!creating && selected ? <SetupProgress
        key={selected.id}
        source={selected}
        slackConnected={noxConnect.slack.connected}
        checking={checkingEvents || sources.isFetching}
        checkedWithoutEvent={checkedWithoutEvent}
        onCheck={() => void checkForEvents()}
      /> : null}
      {!creating && selected ? <EndpointHealthPanel source={selected} /> : null}
      {!creating && selected ? <KeySection source={selected} /> : null}
      {!creating && selected ? <CustomMetricRegistry source={selected} /> : null}
      {!creating && selected ? <CustomFeatureRegistry source={selected} /> : null}
      {!creating && selected ? <AuthHealthPanel source={selected} /> : null}
      {!creating && selected ? <ProjectMetricControls
        key={selected.projectId ?? "project-metrics"}
        projects={sources.data.projects}
        initialProjectId={selected.projectId}
      /> : null}
      {!creating && selected ? <NoxCueDashboardPanel
        projects={sources.data.projects}
        initialProjectId={selected.projectId}
      /> : null}
      {!creating && selected ? <DailyUserStats source={selected} /> : null}
    </div>
  );
}

export function SetupProgress({
  source,
  slackConnected,
  checking,
  checkedWithoutEvent,
  onCheck,
}: {
  source: NoxCueSource;
  slackConnected: boolean;
  checking: boolean;
  checkedWithoutEvent: boolean;
  onCheck: () => void;
}) {
  const destination = useSlackChannels(source.effectiveSlackConnectionId || undefined);
  const channel = destination.channels.data?.find((candidate) => candidate.id === source.effectiveSlackChannelId);
  const channelStatus = findSlackChannelStatus(
    destination.status.data?.channelStatuses,
    source.effectiveSlackConnectionId ?? "",
    source.effectiveSlackChannelId ?? "",
  );
  const [testingDelivery, setTestingDelivery] = useState(false);
  const [testFeedback, setTestFeedback] = useState<{ ok: boolean; message: string } | null>(null);
  const activeKeys = source.keys.filter((key) => key.kind === "secret" && !key.revokedAt);
  const eventAt = lastUserEventAt(source);
  const destinationReady = Boolean(slackConnected && source.digestEnabled && source.effectiveSlackChannelId);
  const deliveryHealthy = channelStatus?.status === "verified";
  const deliveryIssue = channelStatus?.status === "issue";
  const testDelivery = async () => {
    if (!source.effectiveSlackChannelId || !source.effectiveSlackConnectionId) return;
    setTestingDelivery(true);
    setTestFeedback(null);
    try {
      await apiPost("/api/slack/test", {
        kind: "noxcue",
        connectionId: source.effectiveSlackConnectionId,
        channelId: source.effectiveSlackChannelId,
      });
      await destination.status.refetch();
      setTestFeedback({
        ok: true,
        message: `Test message posted${channel ? ` to #${channel.name}` : ""}. Confirm it in Slack.`,
      });
    } catch (error) {
      await destination.status.refetch();
      setTestFeedback({
        ok: false,
        message: error instanceof Error ? error.message : "Slack delivery failed",
      });
    } finally {
      setTestingDelivery(false);
    }
  };
  const steps = [
    {
      label: "App configured",
      detail: source.projectName ? `Linked to ${source.projectName}` : "Source saved in this organization",
      complete: source.enabled,
    },
    {
      label: "Slack destination",
      detail: destinationReady
        ? `${channel ? `#${channel.name}` : "Channel selected"} · ${routeLabel(source.slackRouteLevel)}`
        : source.digestEnabled ? "Choose a channel or configure a fallback route" : "Daily Slack pulse is paused",
      complete: destinationReady,
    },
    {
      label: "Secret key",
      detail: activeKeys.length
        ? `${activeKeys.length} active key${activeKeys.length === 1 ? "" : "s"}`
        : "Create a secret key and save it in the server environment",
      complete: activeKeys.length > 0,
    },
    {
      label: "First user event",
      detail: eventAt
        ? `Received and stored ${new Date(eventAt).toLocaleString()}`
        : "Waiting for user.registered or user.active",
      complete: Boolean(eventAt),
    },
    {
      label: "Slack delivery",
      detail: deliveryHealthy
        ? `Healthy${channelStatus?.lastDeliveredAt ? ` · posted ${new Date(channelStatus.lastDeliveredAt).toLocaleString()}` : ""}`
        : deliveryIssue ? `Issue · ${channelStatus?.lastError ?? "A message could not be posted"}` : "Send a real test message and verify it in Slack",
      complete: deliveryHealthy,
      issue: deliveryIssue,
    },
  ];
  const completed = steps.filter((step) => step.complete).length;

  return <Panel>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h3 className="text-sm font-semibold text-stone-900">Setup progress</h3>
        <p className="mt-1 text-xs text-stone-500">Each check reflects the saved {environmentLabel(source.environment).toLowerCase()} configuration.</p>
      </div>
      <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${completed === steps.length ? "bg-green-100 text-green-700" : "bg-stone-100 text-stone-600"}`}>
        {completed} of {steps.length} complete
      </span>
    </div>
    <ol className="grid gap-3 sm:grid-cols-2">
      {steps.map((step, index) => <li key={step.label} className={`flex items-start gap-3 rounded-lg border p-3 ${step.complete ? "border-green-200 bg-green-50/60" : step.issue ? "border-amber-200 bg-amber-50" : "border-stone-200 bg-stone-50"}`}>
        <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${step.complete ? "bg-green-600 text-white" : step.issue ? "bg-amber-500 text-white" : "border border-stone-300 bg-white text-stone-500"}`}>
          {step.complete ? <Check size={12} /> : step.issue ? <AlertTriangle size={12} /> : index + 1}
        </span>
        <span className="min-w-0">
          <span className="block text-xs font-medium text-stone-800">{step.label}</span>
          <span className="mt-0.5 block text-[11px] leading-4 text-stone-500">{step.detail}</span>
        </span>
      </li>)}
    </ol>
    {destinationReady ? <div className={`rounded-lg border p-4 ${deliveryHealthy ? "border-green-200 bg-green-50" : deliveryIssue ? "border-amber-200 bg-amber-50" : "border-blue-200 bg-blue-50"}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          {deliveryHealthy
            ? <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-green-700" />
            : deliveryIssue
              ? <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-700" />
              : <Send size={16} className="mt-0.5 shrink-0 text-blue-700" />}
          <div>
            <p className={`text-sm font-semibold ${deliveryHealthy ? "text-green-900" : deliveryIssue ? "text-amber-900" : "text-blue-900"}`}>
              {deliveryHealthy ? "Slack delivery healthy" : deliveryIssue ? "Slack delivery issue" : "Verify Slack delivery"}
            </p>
            <p className={`mt-1 text-xs leading-5 ${deliveryHealthy ? "text-green-800" : deliveryIssue ? "text-amber-800" : "text-blue-700"}`}>
              {deliveryHealthy
                ? `Slack accepted the last message${channel ? ` in #${channel.name}` : ""}. Future successful posts keep this healthy.`
                : deliveryIssue
                  ? `${channelStatus?.lastError ?? "Slack did not accept the message."} The next successful post automatically restores healthy status.`
                  : `Post a real NoxCue test message${channel ? ` to #${channel.name}` : ""}. Slack must return a delivery receipt before setup is complete.`}
            </p>
          </div>
        </div>
        <button type="button" onClick={() => void testDelivery()} disabled={testingDelivery} className={`inline-flex items-center gap-1.5 rounded-lg border bg-white px-3 py-2 text-xs font-medium disabled:opacity-50 ${deliveryIssue ? "border-amber-200 text-amber-800" : deliveryHealthy ? "border-green-200 text-green-800" : "border-blue-200 text-blue-800"}`}>
          {testingDelivery ? <Spinner size="sm" /> : <Send size={13} />} {deliveryHealthy ? "Send another test" : deliveryIssue ? "Retry test" : "Send test message"}
        </button>
      </div>
      {testFeedback ? <p role="status" className={`mt-2 text-xs ${testFeedback.ok ? "text-green-700" : "text-amber-800"}`}>{testFeedback.message}</p> : null}
    </div> : null}
    {completed === steps.length ? <div role="status" className="rounded-lg border border-green-200 bg-green-50 p-4">
      <div className="flex items-start gap-2">
        <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-green-700" />
        <div>
          <p className="text-sm font-semibold text-green-900">NoxCue is live</p>
          <p className="mt-1 text-xs leading-5 text-green-800">
            A user event was received and stored. The next completed-day pulse will post {channel ? `to #${channel.name} ` : "to the configured Slack destination "}after {source.digestTimeLocal} {source.timezone}.
          </p>
        </div>
      </div>
    </div> : activeKeys.length ? <div className="rounded-lg border border-blue-200 bg-blue-50 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-medium text-blue-900">Waiting for the first real user event</p>
          <p className="mt-1 text-xs leading-5 text-blue-700">Run the registration call after a signup completes, then check the connection. NoxCue will confirm the stored event here.</p>
        </div>
        <button type="button" onClick={onCheck} disabled={checking} className="inline-flex items-center gap-1.5 rounded-lg border border-blue-200 bg-white px-3 py-2 text-xs font-medium text-blue-800 disabled:opacity-50">
          {checking ? <Spinner size="sm" /> : <RefreshCw size={13} />} Check for event
        </button>
      </div>
      {checkedWithoutEvent ? <p role="status" className="mt-2 text-xs text-blue-700">No user event yet. Confirm the call runs server-side after signup and uses this source’s active key.</p> : null}
    </div> : null}
  </Panel>;
}

function lastUserEventAt(source: Pick<NoxCueSource, "lastRegistrationAt" | "lastActivityAt">) {
  return [source.lastRegistrationAt, source.lastActivityAt]
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1) ?? null;
}

function routeLabel(level: NoxCueSource["slackRouteLevel"]) {
  if (level === "source") return "source route";
  if (level === "project") return "project route";
  if (level === "organization") return "organization route";
  if (level === "fallback") return "organization fallback";
  return "configured route";
}

export function ProjectMetricControls({
  projects,
  initialProjectId,
}: {
  projects: Array<{ id: string; name: string }>;
  initialProjectId: string | null;
}) {
  const [projectId, setProjectId] = useState(() => initialProjectId ?? projects[0]?.id ?? "");
  const state = useNoxCueProjectMetrics(projectId || null);
  const save = useSaveNoxCueProjectMetrics(projectId || null);

  if (!projectId) {
    return <Panel>
      <h3 className="text-sm font-semibold text-stone-900">Metrics in the daily report</h3>
      <p className="text-xs leading-5 text-stone-500">Create a NoxConnect project before choosing report metrics.</p>
    </Panel>;
  }
  if (state.isLoading) return <Panel><Spinner className="h-5 w-5 text-accent" /></Panel>;
  if (state.isError || !state.data) return <Panel>Could not load project metric settings.</Panel>;

  const enabledKeys = state.data.metrics.filter((metric) => metric.enabled).map((metric) => metric.key);
  const toggle = (key: NoxCueUserMetricKey, enabled: boolean) => {
    const next = enabled
      ? [...new Set([...enabledKeys, key])]
      : enabledKeys.filter((candidate) => candidate !== key);
    save.mutate(next);
  };

  return <Panel>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h3 className="text-sm font-semibold text-stone-900">Metrics in the daily report</h3>
        <p className="mt-1 text-xs text-stone-500">Choose what appears in this project's report. Collection stays on for every metric.</p>
      </div>
      <div className="flex items-center gap-2">
        <label className="text-xs font-medium text-stone-600">Project
          <select value={projectId} onChange={(event) => setProjectId(event.target.value)} className="ml-2 rounded-lg border border-stone-200 bg-white px-2.5 py-1.5 text-xs text-stone-700">
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </label>
        <span className="rounded-full bg-stone-100 px-2.5 py-1 text-xs font-medium text-stone-600">
          {enabledKeys.length} of {state.data.metrics.length} selected
        </span>
      </div>
    </div>
    <div className="grid gap-3 sm:grid-cols-2">
      {state.data.metrics.map((metric) => <label key={metric.key} className={`flex cursor-pointer items-start gap-3 rounded-lg border p-4 transition-colors ${metric.enabled ? "border-accent/30 bg-accent/5" : "border-stone-200 bg-stone-50"}`}>
        <input
          type="checkbox"
          checked={metric.enabled}
          disabled={save.isPending || (metric.enabled && enabledKeys.length === 1)}
          onChange={(event) => toggle(metric.key, event.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border-stone-300 text-accent"
        />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-stone-800">{metric.label}</span>
            <MetricActivity active={metric.active} />
          </span>
          <span className="mt-1 block text-xs leading-5 text-stone-500">{metric.description}</span>
          <span className="mt-1 block text-[11px] text-stone-400">
            {metric.lastEventAt ? `Last supporting event ${new Date(metric.lastEventAt).toLocaleString()}` : "Waiting for its first supporting event"}
          </span>
        </span>
      </label>)}
    </div>
    <p className="text-[11px] text-stone-400">At least one metric must remain selected. Turn off the daily Slack report above to pause the report entirely.</p>
    {save.isError ? <p className="text-xs text-red-600">Could not save the project metric selection.</p> : null}
  </Panel>;
}

function NoxCueDashboardPanel({
  projects,
  initialProjectId,
}: {
  projects: Array<{ id: string; name: string }>;
  initialProjectId: string | null;
}) {
  const [projectId, setProjectId] = useState(() => initialProjectId ?? projects[0]?.id ?? "");
  const [password, setPassword] = useState("");
  const [copied, setCopied] = useState(false);
  const [validationError, setValidationError] = useState("");
  const shares = useNoxCueDashboardShares();
  const upsert = useUpsertNoxCueDashboardShare();
  const remove = useDeleteNoxCueDashboardShare();
  const { confirm, dialogProps } = useConfirm();
  const activeShare = shares.data?.shares.find((share) => share.projectId === projectId)
    ?? (upsert.data?.share.projectId === projectId ? upsert.data.share : null);
  const shareUrl = activeShare ? `${window.location.origin}/cue/${activeShare.slug}` : "";
  const selectedProject = projects.find((project) => project.id === projectId);

  return <><Panel>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <div className="flex items-center gap-2"><Share2 size={16} /><h3 className="text-sm font-semibold text-stone-900">Protected dashboard</h3></div>
        <p className="mt-1 text-xs leading-5 text-stone-500">Share a read-only view of user statistics, feature health, endpoint status, and recent errors. No NoxConnect account is required.</p>
      </div>
      {activeShare ? <span className="rounded-full bg-green-100 px-2.5 py-1 text-xs font-medium text-green-700">Password protected</span> : null}
    </div>
    <label className="block text-xs font-medium text-stone-600">Project
      <select value={projectId} onChange={(event) => { setProjectId(event.target.value); setPassword(""); setValidationError(""); upsert.reset(); }} className="mt-1 block w-full rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm">
        {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
      </select>
    </label>
    {activeShare ? <div>
      <p className="mb-1 text-xs font-medium text-stone-500">Dashboard link</p>
      <div className="flex items-center gap-2 rounded-lg bg-stone-950 px-3 py-2.5">
        <a href={shareUrl} target="_blank" rel="noreferrer" className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-xs text-stone-200 hover:text-white">{shareUrl}</a>
        <button type="button" onClick={() => void navigator.clipboard.writeText(shareUrl).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); })} className="shrink-0 text-stone-400 hover:text-white" title="Copy dashboard link"><span className="inline-flex items-center gap-1.5">{copied ? <Check size={15} /> : <Clipboard size={15} />} {copied ? "Copied" : "Copy link"}</span></button>
        <a href={shareUrl} target="_blank" rel="noreferrer" className="shrink-0 text-stone-400 hover:text-white" title="Open dashboard"><ExternalLink size={15} /></a>
      </div>
    </div> : <p className="rounded-lg bg-stone-50 px-3 py-2 text-xs text-stone-500">Create the dashboard to generate its private link.</p>}
    <form noValidate className="flex flex-col gap-2 sm:flex-row" onSubmit={(event) => {
      event.preventDefault();
      if (!projectId) return;
      if (password.length < 12) { setValidationError("Use at least 12 characters for the dashboard password."); return; }
      setValidationError("");
      upsert.mutate({ projectId, password }, { onSuccess: () => setPassword("") });
    }}>
      <div className="min-w-0 flex-1">
        <label htmlFor="noxcue-dashboard-password" className="text-xs font-medium text-stone-500">{activeShare ? "New password" : "Dashboard password"}</label>
        <input id="noxcue-dashboard-password" type="password" autoComplete="new-password" minLength={12} maxLength={200} required value={password} onChange={(event) => { setPassword(event.target.value); if (validationError) setValidationError(""); }} placeholder="At least 12 characters" className="mt-1 w-full rounded-lg border border-stone-200 px-3 py-2 text-xs" />
        <span className="mt-1 block text-[11px] text-stone-400">12 character minimum · changing it signs out existing viewers</span>
      </div>
      <button type="submit" disabled={upsert.isPending || !projectId} className="mt-auto inline-flex items-center justify-center gap-1.5 rounded-lg bg-stone-900 px-3 py-2 text-xs font-medium text-white disabled:opacity-50">{upsert.isPending ? <Spinner size="sm" /> : <KeyRound size={13} />} {upsert.isPending ? "Saving…" : activeShare ? "Change password" : "Create dashboard"}</button>
    </form>
    {validationError ? <p role="alert" className="text-xs text-red-600">{validationError}</p> : null}
    {upsert.isError || shares.isError ? <p role="alert" className="text-xs text-red-600">{upsert.error instanceof Error ? upsert.error.message : "The dashboard settings could not be loaded or saved."}</p> : null}
    {activeShare ? <button type="button" disabled={remove.isPending} onClick={async () => {
      if (await confirm({ title: `Disable ${selectedProject?.name ?? "this"} dashboard?`, message: "The link and all viewer sessions will stop working immediately. NoxCue data is not deleted.", confirmLabel: "Disable dashboard", variant: "danger" })) {
        remove.mutate(activeShare.id, { onSuccess: () => upsert.reset() });
      }
    }} className="text-xs font-medium text-red-600 disabled:opacity-50">Disable dashboard</button> : null}
  </Panel><ConfirmDialog {...dialogProps} /></>;
}

function MetricActivity({ active }: { active: boolean }) {
  return active
    ? <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-[11px] font-medium text-green-700"><CheckCircle2 size={11} /> Active</span>
    : <span className="inline-flex items-center gap-1 rounded-full bg-stone-200 px-2 py-0.5 text-[11px] font-medium text-stone-600"><CircleDashed size={11} /> Waiting</span>;
}

function SlackDestination({ draft, setDraft }: { draft: NoxCueSourceInput; setDraft: (next: NoxCueSourceInput) => void }) {
  const allWorkspaces = useSlackChannels();
  const defaultConnectionId = allWorkspaces.status.data?.defaultConnectionId ?? "";
  const connectionId = draft.slackConnectionId ?? defaultConnectionId;
  const selectedWorkspace = useSlackChannels(connectionId || undefined);
  const workspaceOptions = (allWorkspaces.status.data?.connections ?? []).map((connection) => ({
    value: connection.id,
    label: `${connection.teamName}${connection.isDefault ? " · default" : ""}`,
  }));
  return <div className="space-y-2">
    <label className="text-sm font-medium text-stone-700">Slack destination</label>
    <div className="grid gap-3 sm:grid-cols-2">
      <SearchableSelect value={connectionId} onChange={(next) => setDraft({ ...draft, slackConnectionId: next || null, slackChannelId: null })} options={workspaceOptions} placeholder="Select workspace" className="w-full" />
      <SearchableSelect value={draft.slackChannelId ?? ""} onChange={(next) => setDraft({ ...draft, slackChannelId: next || null, slackConnectionId: next ? connectionId : null })} options={selectedWorkspace.channelOptions} placeholder={selectedWorkspace.channels.isLoading ? "Loading channels…" : "Use organization fallback"} className="w-full" />
    </div>
    <p className="text-xs text-stone-400">A source selection wins first. Otherwise NoxCue uses the linked project route, then the organization default.</p>
  </div>;
}

function KeySection({ source }: { source: NoxCueSource }) {
  const createKey = useCreateNoxCueKey();
  const revokeKey = useRevokeNoxCueKey();
  const { confirm, dialogProps } = useConfirm();
  const [newKey, setNewKey] = useState<{ value: string; kind: "publishable" | "secret" } | null>(null);
  const [copied, setCopied] = useState(false);
  const activeKeys = source.keys.filter((key) => !key.revokedAt);
  const create = (kind: "publishable" | "secret") => createKey.mutate(
    { sourceId: source.id, name: kind === "publishable" ? "Publishable" : "Secret", kind },
    { onSuccess: (result) => { setNewKey({ value: result.key.value, kind }); setCopied(false); } },
  );
  const revoke = async (keyId: string) => {
    if (await confirm({ title: "Revoke this ingest key?", message: "The app using it will immediately stop sending NoxCue events.", confirmLabel: "Revoke key", variant: "danger" })) revokeKey.mutate({ sourceId: source.id, keyId });
  };
  return <><Panel>
    <div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex items-center gap-2"><Server size={16} /><h3 className="text-sm font-semibold text-stone-900">Connect the app</h3></div><p className="mt-1 text-xs text-stone-500">Use a publishable key in browser or mobile code for auth health. Keep a secret key on the server for user statistics.</p></div><div className="flex gap-2"><button type="button" onClick={() => create("publishable")} disabled={createKey.isPending || !source.allowedOrigins.length} className="inline-flex items-center gap-1.5 rounded-lg border border-stone-200 px-3 py-2 text-xs font-medium disabled:opacity-50"><ShieldCheck size={13} /> Create publishable key</button><button type="button" onClick={() => create("secret")} disabled={createKey.isPending} className="inline-flex items-center gap-1.5 rounded-lg border border-stone-200 px-3 py-2 text-xs font-medium disabled:opacity-50">{createKey.isPending ? <Spinner size="sm" /> : <KeyRound size={13} />} Create secret key</button></div></div>
    {newKey ? <div className="rounded-lg border border-amber-200 bg-amber-50 p-3"><p className="text-xs font-semibold text-amber-900">{newKey.kind === "publishable" ? "Publishable key" : "Secret key"} created—copy it now</p><p className="mt-1 text-xs text-amber-800">{newKey.kind === "publishable" ? "Use this key in browser or mobile code. Requests are restricted to the exact origins above." : "Store this value as NOXCUE_INGEST_KEY in your server environment."}</p><div className="mt-2 flex gap-2"><code className="min-w-0 flex-1 overflow-x-auto rounded bg-white px-2 py-2 text-xs">{newKey.value}</code><button type="button" aria-label="Copy NoxCue ingest key" title="Copy key" onClick={() => { void navigator.clipboard.writeText(newKey.value).then(() => setCopied(true), () => setCopied(false)); }} className="rounded-lg border border-amber-200 bg-white px-3 text-amber-800">{copied ? <Check size={14} /> : <Clipboard size={14} />}</button></div>{newKey.kind === "publishable" ? <BrowserExample ingestKey={newKey.value} environment={source.environment} /> : <RequestExample environment={source.environment} />}</div> : null}
    <div className="divide-y divide-stone-100">{activeKeys.map((key) => <div key={key.id} className="flex items-center gap-3 py-3 text-sm"><div className="min-w-0 flex-1"><div className="font-medium text-stone-700">{key.name} <span className="ml-1 rounded bg-stone-100 px-1.5 py-0.5 text-[10px] uppercase text-stone-500">{key.kind}</span></div><div className="font-mono text-xs text-stone-400">{key.prefix}… · {key.lastUsedAt ? `last request ${new Date(key.lastUsedAt).toLocaleString()}` : "waiting for first request"}</div></div><button type="button" onClick={() => void revoke(key.id)} className="text-xs text-red-600">Revoke</button></div>)}{!activeKeys.length ? <p className="py-3 text-xs text-stone-400">No active keys yet.</p> : null}</div>
    {!source.allowedOrigins.length ? <p className="text-xs text-amber-700">Save at least one browser origin before creating a publishable key.</p> : null}
    {createKey.isError ? <p className="text-xs text-red-600">{createKey.error instanceof Error ? createKey.error.message : "Could not create the key."}</p> : null}
  </Panel><ConfirmDialog {...dialogProps} /></>;
}

function BrowserExample({ ingestKey, environment }: { ingestKey: string; environment: NoxCueEnvironment }) {
  const [copied, setCopied] = useState(false);
  const command = `const noxcue = createNoxCue({
  ingestKey: "${ingestKey}",
  environment: "${environment}",
  release: __APP_VERSION__,
});

// One wrapper around the auth call. The original result is unchanged.
const result = await noxcue.auth.signup(() => auth.signUp(input));

// Registered custom features use the same one-line wrapper.
await noxcue.observe("custom.journal.publish", () => publishJournal(input));

// Run once during setup, then click “Check now” in NoxConnect.
await noxcue.test();`;
  return <div className="mt-3 space-y-2">
    <div className="flex items-center justify-between gap-2"><div><p className="text-xs font-semibold text-amber-900">Wrap each auth action</p><p className="mt-0.5 text-[11px] text-amber-800">Available: signup, login, passwordReset, emailVerification, oauth, mfa, sessionRefresh, logout.</p></div><button type="button" onClick={() => { void navigator.clipboard.writeText(command).then(() => setCopied(true)); }} className="inline-flex items-center gap-1 rounded-lg border border-amber-200 bg-white px-2 py-1.5 text-xs text-amber-800">{copied ? <Check size={12} /> : <Clipboard size={12} />} {copied ? "Copied" : "Copy code"}</button></div>
    <pre className="overflow-x-auto rounded bg-stone-950 p-3 text-xs text-stone-100">{command}</pre>
    <p className="text-[11px] leading-5 text-amber-800">NoxCue automatically adds time, source, environment, release, runtime, safe URL and redacted error evidence. It detects and suggests possible fixes; it never changes the app or retries the operation.</p>
  </div>;
}

function CustomMetricRegistry({ source }: { source: NoxCueSource }) {
  const state = useNoxCueCustomMetrics(source.id);
  const create = useCreateNoxCueCustomMetric(source.id);
  const [adding, setAdding] = useState(false);
  const [key, setKey] = useState("");
  const [label, setLabel] = useState("");
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    create.mutate({ key, label }, { onSuccess: () => { setAdding(false); setKey(""); setLabel(""); } });
  };
  return <Panel>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><div className="flex items-center gap-2"><Activity size={16} /><h3 className="text-sm font-semibold text-stone-900">Custom activity metrics</h3></div><p className="mt-1 text-xs leading-5 text-stone-500">Register each name before the app sends it. NoxCue turns individual events into a daily count and a daily per-registered-user statistic.</p></div>
      <button type="button" onClick={() => setAdding(true)} className="inline-flex items-center gap-1 rounded-lg border border-stone-200 px-3 py-2 text-xs font-medium"><Plus size={13} /> Register metric</button>
    </div>
    {adding ? <form onSubmit={submit} className="grid gap-3 rounded-lg border border-blue-100 bg-blue-50 p-4 sm:grid-cols-2">
      <label className="text-xs font-medium text-stone-700">Metric key<input required pattern="custom\.[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){0,4}" value={key} onChange={(event) => setKey(event.target.value)} placeholder="custom.journals.added" className="mt-1 block w-full rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm" /></label>
      <label className="text-xs font-medium text-stone-700">Display label<input required maxLength={80} value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Journals added" className="mt-1 block w-full rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm" /></label>
      <div className="flex items-center gap-3 sm:col-span-2"><button disabled={create.isPending} className="rounded-lg bg-accent px-3 py-2 text-xs font-medium text-white disabled:opacity-50">{create.isPending ? "Registering…" : "Register metric"}</button><button type="button" onClick={() => setAdding(false)} className="px-2 py-2 text-xs text-stone-500">Cancel</button></div>
      {create.isError ? <p className="text-xs text-red-600 sm:col-span-2">{create.error instanceof Error ? create.error.message : "Could not register this metric."}</p> : null}
    </form> : null}
    {state.isError ? <p className="text-xs text-red-600">Could not load custom metrics.</p> : state.isLoading ? <Spinner className="h-4 w-4 text-accent" /> : state.data?.metrics.length ? <div className="space-y-3">{state.data.metrics.map((metric) => <CustomMetricRow key={metric.key} sourceId={source.id} metric={metric} />)}</div> : <p className="rounded-lg border border-dashed border-stone-200 px-4 py-5 text-center text-xs text-stone-400">No custom activity metrics yet.</p>}
  </Panel>;
}

function CustomMetricRow({ sourceId, metric }: { sourceId: string; metric: NoxCueCustomMetricsResponse["metrics"][number] }) {
  const save = useSaveNoxCueCustomMetric(sourceId);
  const remove = useDeleteNoxCueCustomMetric(sourceId);
  const { confirm, dialogProps } = useConfirm();
  const deleteMetric = async () => {
    if (await confirm({ title: `Delete ${metric.label}?`, message: "Future events using this key will be reported as unregistered. Historical activity remains stored.", confirmLabel: "Delete metric", variant: "danger" })) remove.mutate(metric.key);
  };
  return <><div className={`rounded-lg border p-4 ${metric.enabled ? "border-stone-200 bg-white" : "border-stone-200 bg-stone-50"}`}>
    <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="text-sm font-medium text-stone-800">{metric.label}</span><MetricActivity active={metric.active} /></div><code className="mt-1 block text-[11px] text-stone-400">{metric.key}</code><p className="mt-2 text-xs text-stone-500">Outputs: {metric.outputs.map((output) => output.label).join(" · ")}</p>{metric.lastEventAt ? <p className="mt-1 text-[11px] text-stone-400">Last event {new Date(metric.lastEventAt).toLocaleString()}</p> : null}</div>
      <div className="flex items-center gap-2"><label className="inline-flex items-center gap-1.5 text-xs text-stone-600"><input type="checkbox" checked={metric.enabled} disabled={save.isPending} onChange={(event) => save.mutate({ key: metric.key, input: { label: metric.label, enabled: event.target.checked } })} /> Include in reports</label><button type="button" onClick={() => void deleteMetric()} className="p-1.5 text-red-600" aria-label={`Delete ${metric.label}`}><Trash2 size={13} /></button></div></div>
    {save.isError || remove.isError ? <p className="mt-2 text-xs text-red-600">Could not update this custom metric.</p> : null}
  </div><ConfirmDialog {...dialogProps} /></>;
}

function CustomFeatureRegistry({ source }: { source: NoxCueSource }) {
  const health = useNoxCueFeatures(source.id);
  const create = useCreateNoxCueFeature(source.id);
  const [adding, setAdding] = useState(false);
  const [suffix, setSuffix] = useState("");
  const [label, setLabel] = useState("");
  const [failureMessage, setFailureMessage] = useState("");
  const custom = health.data?.features.filter((feature) => feature.kind === "custom") ?? [];
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const normalized = suffix.trim().toLowerCase().replace(/^custom\./, "").replace(/[^a-z0-9_.]+/g, "_");
    create.mutate({ key: `custom.${normalized}`, label, failureMessage }, { onSuccess: () => {
      setAdding(false);
      setSuffix("");
      setLabel("");
      setFailureMessage("");
    } });
  };
  const scope = health.data?.scope;
  return <Panel>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <div className="flex items-center gap-2"><Activity size={16} /><h3 className="text-sm font-semibold text-stone-900">Custom features</h3></div>
        <p className="mt-1 text-xs leading-5 text-stone-500">Register a name before the app sends it. Unknown names become one unregistered-feature error and never create metrics.</p>
        {scope ? <p className="mt-1 text-[11px] text-stone-400">{scope.type === "project" ? <>Shared by every source linked to project <span className="font-medium text-stone-500">{scope.name}</span>.</> : <>Available only to source <span className="font-medium text-stone-500">{scope.name}</span>.</>}</p> : null}
      </div>
      <button type="button" onClick={() => setAdding((value) => !value)} className="inline-flex items-center gap-1.5 rounded-lg border border-stone-200 px-3 py-2 text-xs font-medium text-stone-700"><Plus size={13} /> Register feature</button>
    </div>
    {adding ? <form onSubmit={submit} className="space-y-3 rounded-lg border border-accent/20 bg-accent/5 p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs font-medium text-stone-700">Feature name
          <div className="mt-1 flex rounded-lg border border-stone-200 bg-white focus-within:border-accent"><span className="border-r border-stone-200 px-3 py-2 font-mono text-xs text-stone-400">custom.</span><input required value={suffix} onChange={(event) => setSuffix(event.target.value.toLowerCase().replace(/^custom\./, "").replace(/[^a-z0-9_.]+/g, "_"))} pattern="[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){0,4}" placeholder="journal.publish" className="min-w-0 flex-1 rounded-r-lg px-3 py-2 font-mono text-xs outline-none" /></div>
        </label>
        <label className="text-xs font-medium text-stone-700">Display label
          <input required maxLength={80} value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Publish journal" className="mt-1 block w-full rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm" />
        </label>
      </div>
      <label className="block text-xs font-medium text-stone-700">User impact when it fails
        <input required maxLength={500} value={failureMessage} onChange={(event) => setFailureMessage(event.target.value)} placeholder="A user was prevented from publishing a journal entry." className="mt-1 block w-full rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm" />
      </label>
      <div className="flex items-center gap-3"><button disabled={create.isPending} className="rounded-lg bg-accent px-3 py-2 text-xs font-medium text-white disabled:opacity-50">{create.isPending ? "Registering…" : "Register feature"}</button><button type="button" onClick={() => setAdding(false)} className="px-2 py-2 text-xs text-stone-500">Cancel</button></div>
      {create.isError ? <p className="text-xs text-red-600">{create.error instanceof Error ? create.error.message : "Could not register this feature."}</p> : null}
    </form> : null}
    {health.isError ? <p className="text-xs text-red-600">Could not load the feature catalog.</p> : health.isLoading ? <Spinner className="h-4 w-4 text-accent" /> : custom.length ? <div className="space-y-3">{custom.map((feature) => <CustomFeatureRow key={feature.key} sourceId={source.id} feature={feature} />)}</div> : <p className="rounded-lg border border-dashed border-stone-200 px-4 py-5 text-center text-xs text-stone-400">No custom features registered yet. NoxCue standards remain available below.</p>}
  </Panel>;
}

function CustomFeatureRow({ sourceId, feature }: { sourceId: string; feature: NoxCueFeaturesResponse["features"][number] }) {
  const save = useSaveNoxCueFeature(sourceId);
  const remove = useDeleteNoxCueFeature(sourceId);
  const { confirm, dialogProps } = useConfirm();
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(feature.label);
  const [failureMessage, setFailureMessage] = useState(feature.failureMessage);
  const update = (enabled = feature.enabled) => save.mutate({ key: feature.key, input: { label, failureMessage, enabled } }, { onSuccess: () => setEditing(false) });
  const deleteFeature = async () => {
    if (await confirm({ title: `Delete ${feature.label}?`, message: "Future events using this key will be recorded as unregistered-feature errors. Historical results remain stored.", confirmLabel: "Delete feature", variant: "danger" })) remove.mutate(feature.key);
  };
  return <><div className={`rounded-lg border p-4 ${feature.enabled ? "border-stone-200 bg-white" : "border-stone-200 bg-stone-50"}`}>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="text-sm font-medium text-stone-800">{feature.label}</span><span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${feature.enabled ? "bg-green-100 text-green-700" : "bg-stone-200 text-stone-600"}`}>{feature.enabled ? "Active" : "Paused"}</span></div><code className="mt-1 block truncate text-[11px] text-stone-400">{feature.key}</code><p className="mt-2 text-xs text-stone-500">{feature.failureMessage}</p></div>
      <div className="flex items-center gap-2"><label className="inline-flex items-center gap-1.5 text-xs text-stone-600"><input type="checkbox" checked={feature.enabled} disabled={save.isPending} onChange={(event) => update(event.target.checked)} /> Accept events</label><button type="button" onClick={() => setEditing((value) => !value)} className="rounded-lg border border-stone-200 px-2.5 py-1.5 text-xs text-stone-600">Edit</button><button type="button" onClick={() => void deleteFeature()} className="p-1.5 text-red-600" aria-label={`Delete ${feature.label}`}><Trash2 size={13} /></button></div>
    </div>
    {editing ? <div className="mt-3 grid gap-3 border-t border-stone-100 pt-3"><label className="text-xs font-medium text-stone-600">Display label<input maxLength={80} value={label} onChange={(event) => setLabel(event.target.value)} className="mt-1 block w-full rounded-lg border border-stone-200 px-3 py-2 text-sm" /></label><label className="text-xs font-medium text-stone-600">User impact<input maxLength={500} value={failureMessage} onChange={(event) => setFailureMessage(event.target.value)} className="mt-1 block w-full rounded-lg border border-stone-200 px-3 py-2 text-sm" /></label><div><button type="button" onClick={() => update()} disabled={save.isPending || !label.trim() || !failureMessage.trim()} className="rounded-lg bg-accent px-3 py-2 text-xs font-medium text-white disabled:opacity-50">Save</button></div></div> : null}
    {save.isError || remove.isError ? <p className="mt-2 text-xs text-red-600">Could not update this custom feature.</p> : null}
  </div><ConfirmDialog {...dialogProps} /></>;
}

function AuthHealthPanel({ source }: { source: NoxCueSource }) {
  const health = useNoxCueFeatures(source.id);
  const publishable = source.keys.some((key) => key.kind === "publishable" && !key.revokedAt);
  const testedAt = health.data?.features.map((feature) => feature.lastTestAt).filter(Boolean).sort().at(-1) ?? null;
  const issueCount = health.data?.features.filter((feature) => feature.enabled && feature.status === "issue").length ?? 0;
  return <Panel>
    <div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex items-center gap-2"><Activity size={16} /><h3 className="text-sm font-semibold text-stone-900">Feature health</h3></div><p className="mt-1 text-xs text-stone-500">NoxCue standards and registered custom features use the same outcomes. Every system failure is stored with its message and actual technical error, then alerts Slack immediately.</p></div><button type="button" onClick={() => void health.refetch()} disabled={health.isFetching} className="inline-flex items-center gap-1.5 rounded-lg border border-stone-200 px-3 py-2 text-xs font-medium disabled:opacity-50">{health.isFetching ? <Spinner size="sm" /> : <RefreshCw size={13} />} Check now</button></div>
    <div className="grid gap-2 sm:grid-cols-3">
      <SetupChip label="Origin saved" complete={source.allowedOrigins.length > 0} detail={source.allowedOrigins[0] ?? "Add the app origin"} />
      <SetupChip label="Publishable key" complete={publishable} detail={publishable ? "Active" : "Create a publishable key"} />
      <SetupChip label="End-to-end test" complete={Boolean(testedAt)} detail={testedAt ? `Received ${new Date(testedAt).toLocaleString()}` : "Run noxcue.test() in the app"} />
    </div>
    {issueCount ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">{issueCount} feature{issueCount === 1 ? " has" : "s have"} an unresolved critical incident. Slack is notified for every system failure.</p> : null}
    {health.isError ? <p className="text-xs text-red-600">Could not load feature health.</p> : health.isLoading ? <Spinner className="h-4 w-4 text-accent" /> : <div className="grid gap-3 sm:grid-cols-2">{health.data?.features.filter((feature) => feature.enabled).map((feature) => <div key={feature.key} className={`rounded-lg border p-3 ${feature.status === "issue" ? "border-red-200 bg-red-50" : feature.status === "healthy" ? "border-green-200 bg-green-50/50" : "border-stone-200 bg-stone-50"}`}><div className="flex items-center justify-between gap-2"><span className="min-w-0"><span className="text-sm font-medium text-stone-800">{feature.label}</span><span className="ml-2 rounded bg-stone-200 px-1.5 py-0.5 text-[10px] font-medium text-stone-600">{feature.kind === "standard" ? "NoxCue standard" : "Custom"}</span></span><HealthBadge status={feature.status} /></div><p className="mt-1 text-[11px] leading-4 text-stone-500">{feature.description}</p><p className="mt-2 text-[11px] text-stone-500">24h: {feature.successes24h} successful · {feature.rejections24h} rejected · {feature.failures24h} system failures</p>{feature.lastResultAt ? <p className="mt-1 text-[11px] text-stone-400">Last result {new Date(feature.lastResultAt).toLocaleString()}</p> : null}</div>)}</div>}
  </Panel>;
}

function EndpointHealthPanel({ source }: { source: NoxCueSource }) {
  const test = useTestNoxCueEndpoint();
  const destination = useSlackChannels(source.effectiveAlertSlackConnectionId || undefined);
  const channel = destination.channels.data?.find((candidate) => candidate.id === source.effectiveAlertSlackChannelId);
  const lastCheckFailed = Boolean(source.healthLastError);
  const stateStyle = source.healthStatus === "issue"
    ? "border-red-200 bg-red-50"
    : lastCheckFailed ? "border-amber-200 bg-amber-50" : source.healthStatus === "healthy"
      ? "border-green-200 bg-green-50" : "border-stone-200 bg-stone-50";

  return <Panel>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <div className="flex items-center gap-2"><Server size={16} /><h3 className="text-sm font-semibold text-stone-900">Endpoint health</h3></div>
        <p className="mt-1 text-xs leading-5 text-stone-500">NoxCue checks the saved public URL every minute. Two failed checks open one incident; two successful checks close it.</p>
      </div>
      <HealthBadge status={source.healthStatus} />
    </div>
    {!source.healthEnabled ? <div className="rounded-lg border border-dashed border-stone-200 p-4 text-xs leading-5 text-stone-500">Add a public HTTPS health URL above, turn on checks, and save the source. No app-side code or ingest key is needed.</div> : <>
      <div className={`rounded-lg border p-4 ${stateStyle}`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-stone-900">{source.healthUrl}</p>
            <p className="mt-1 text-xs text-stone-600">
              {source.healthLastCheckedAt ? `Checked ${new Date(source.healthLastCheckedAt).toLocaleString()}` : "Waiting for the first scheduled check"}
              {source.healthLastStatusCode ? ` · HTTP ${source.healthLastStatusCode}` : ""}
              {source.healthLastLatencyMs !== null ? ` · ${source.healthLastLatencyMs} ms` : ""}
            </p>
            {source.healthLastError ? <p role="alert" className="mt-2 text-xs font-medium text-amber-800">{source.healthStatus === "issue" ? "Incident: " : "One failed check; confirming: "}{source.healthLastError}</p> : null}
          </div>
          <button type="button" onClick={() => test.mutate(source.id)} disabled={test.isPending || !source.healthUrl || !source.alertsEnabled || !source.effectiveAlertSlackChannelId} className="inline-flex items-center gap-1.5 rounded-lg border border-stone-200 bg-white px-3 py-2 text-xs font-medium text-stone-700 disabled:opacity-50">
            {test.isPending ? <Spinner size="sm" /> : <Send size={13} />} Send latest check to Slack
          </button>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-stone-500">
        <span>Alerts: {channel ? `#${channel.name}` : source.effectiveAlertSlackChannelId ? "configured channel" : "no channel configured"} · {routeLabel(source.alertSlackRouteLevel)}</span>
        <span>Only status, latency, and timestamps are retained. Bodies and headers are discarded.</span>
      </div>
      {!source.alertsEnabled ? <p className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">Immediate Slack alerts are paused for {environmentLabel(source.environment).toLowerCase()}. Endpoint checks continue and their status remains visible here.</p> : !source.effectiveAlertSlackChannelId ? <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">Choose this project’s NoxCue alerts destination before testing. Endpoint incidents use the alert route, not the daily-stats route.</p> : null}
      {test.isSuccess ? <p role="status" className={`rounded-lg border px-3 py-2 text-xs ${test.data.healthy ? "border-green-200 bg-green-50 text-green-800" : "border-amber-200 bg-amber-50 text-amber-800"}`}>{test.data.healthy ? `The latest scheduled check returned HTTP ${test.data.statusCode} in ${test.data.latencyMs} ms.` : `The latest scheduled check failed: ${test.data.error ?? "unknown error"}.`} {test.data.delivered ? `Slack accepted the matching test message${channel ? ` in #${channel.name}` : ""}.` : "The matching Slack message is queued; check the channel to confirm it."}</p> : null}
      {test.isError ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">{test.error instanceof Error ? test.error.message : "Could not complete the endpoint and Slack test."}</p> : null}
    </>}
  </Panel>;
}

function SetupChip({ label, complete, detail }: { label: string; complete: boolean; detail: string }) {
  return <div className={`rounded-lg border p-3 ${complete ? "border-green-200 bg-green-50" : "border-stone-200 bg-stone-50"}`}><div className="flex items-center gap-1.5 text-xs font-medium text-stone-800">{complete ? <CheckCircle2 size={13} className="text-green-700" /> : <CircleDashed size={13} className="text-stone-400" />}{label}</div><p className="mt-1 truncate text-[11px] text-stone-500">{detail}</p></div>;
}

function HealthBadge({ status }: { status: "waiting" | "healthy" | "issue" }) {
  const styles = status === "healthy" ? "bg-green-100 text-green-700" : status === "issue" ? "bg-red-100 text-red-700" : "bg-stone-200 text-stone-600";
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${styles}`}>{status === "issue" ? "Issue" : status === "healthy" ? "Healthy" : "Waiting"}</span>;
}

function RequestExample({ environment }: { environment: NoxCueEnvironment }) {
  const [copied, setCopied] = useState(false);
  const command = `await fetch("https://app.unticket.ai/api/cues/public/v1/events", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Nox-Ingest-Key": process.env.NOXCUE_INGEST_KEY,
  },
  body: JSON.stringify({
    type: "user.registered",
    environment: "${environment}",
    userId: user.id,
  }),
});`;
  return <div className="mt-3 space-y-2">
    <div className="flex items-center justify-between gap-2">
      <div><p className="text-xs font-semibold text-amber-900">Add after signup commits</p><p className="mt-0.5 text-[11px] text-amber-800">Registration also counts as activity for that day.</p></div>
      <button type="button" onClick={() => { void navigator.clipboard.writeText(command).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); }); }} className="inline-flex items-center gap-1 rounded-lg border border-amber-200 bg-white px-2 py-1.5 text-xs text-amber-800">{copied ? <Check size={12} /> : <Clipboard size={12} />} {copied ? "Copied" : "Copy code"}</button>
    </div>
    <pre className="overflow-x-auto rounded bg-stone-950 p-3 text-xs text-stone-100">{command}</pre>
    <details className="text-xs text-amber-900"><summary className="cursor-pointer font-medium">Returning users</summary><p className="mt-1 leading-5 text-amber-800">Send the same request with <code>type: "user.active"</code> after a meaningful authenticated action. NoxCue deduplicates each user per local day.</p></details>
  </div>;
}

function DailyUserStats({ source }: { source: NoxCueSource }) {
  const health = useNoxCueMetrics(source.id);
  const latest = health.data?.days[0];
  const catalog = new Map(health.data?.catalog.map((metric) => [metric.key, metric]) ?? []);
  const keys = [...USER_STAT_KEYS, ...(health.data?.catalog.filter((metric) => metric.domain === "activity").map((metric) => metric.key) ?? [])];
  const visible = latest
    ? keys.flatMap((key) => latest.metrics[key] ? [{ key, ...latest.metrics[key] }] : [])
    : [];
  return <Panel>
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="text-sm font-semibold text-stone-900">Daily user stats</h3><p className="mt-1 text-xs text-stone-500">The latest standardized snapshot retained by NoxCue.</p></div>{latest ? <span className="text-xs text-stone-500">{latest.period} · {health.data?.digests[0]?.status ? `Slack: ${health.data.digests[0].status}` : "Brief not sent yet"}</span> : null}</div>
    {health.isLoading ? <Spinner className="h-4 w-4 text-accent" /> : latest && visible.length ? <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{visible.map((metric) => <div key={metric.key} className="rounded-lg border border-stone-100 bg-stone-50 p-4"><div className="text-xl font-semibold text-stone-900">{formatUserStat(catalog.get(metric.key)?.unit, metric.value)}</div><div className="mt-1 text-xs text-stone-500">{catalog.get(metric.key)?.label ?? metric.key}</div></div>)}</div> : lastUserEventAt(source) ? <p className="rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-xs leading-5 text-blue-700">Events are arriving. The first completed-day snapshot will appear after {source.digestTimeLocal} {source.timezone}.</p> : <p className="text-xs text-stone-400">Waiting for the first user event.</p>}
  </Panel>;
}

function formatUserStat(unit: "count" | "ratio" | "decimal" | undefined, value: number) {
  return unit === "ratio"
    ? `${(value * 100).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`
    : value.toLocaleString(undefined, { maximumFractionDigits: unit === "decimal" ? 2 : 0 });
}

function DeleteSourceButton({ sourceId, sourceName, mutation, onDeleted }: { sourceId: string; sourceName: string; mutation: ReturnType<typeof useDeleteNoxCueSource>; onDeleted: () => void }) {
  const { confirm, dialogProps } = useConfirm();
  const remove = async () => {
    if (await confirm({ title: `Delete ${sourceName}?`, message: "Its key will stop working. Saved daily totals are retained.", confirmLabel: "Delete source", variant: "danger" })) mutation.mutate(sourceId, { onSuccess: onDeleted });
  };
  return <><button type="button" onClick={() => void remove()} className="flex items-center gap-1 px-2 py-2 text-xs text-red-600"><Trash2 size={13} /> Delete</button><ConfirmDialog {...dialogProps} /></>;
}

function Panel({ children }: { children: React.ReactNode }) {
  return <section className="space-y-4 rounded-xl border border-stone-200 bg-white p-5">{children}</section>;
}
