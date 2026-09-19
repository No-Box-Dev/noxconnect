import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Check, Clipboard, Clock3, Plus, Radar, RefreshCw, Send, Trash2 } from "lucide-react";
import { Spinner } from "@/components/Spinner";
import { cn } from "@/lib/cn";
import { useFeedProjects } from "@/hooks/useNoxlink";
import {
  useCreateNoxSpotSite,
  useDeleteNoxSpotSite,
  useNoxSpotSites,
  useRetryNoxSpotDeliveries,
  useTestNoxSpotSlack,
  useUpdateNoxSpotSite,
} from "@/hooks/useNoxSpot";
import { fetchSlackChannels, fetchSlackStatus, type SlackConnection } from "@/lib/slack-api";
import { fetchIntegrationsStatus } from "@/lib/integrations-api";
import type { NoxSpotSite } from "@/lib/types";
import { NoxSpotWidgetConfiguration } from "@/components/admin/tools/NoxSpotWidgetConfiguration";
import { NoxSpotResolutionEmailTemplate } from "@/components/admin/tools/NoxSpotResolutionEmailTemplate";
import { ConfirmDialog, useConfirm } from "@/components/ui/ConfirmDialog";

function SiteSetup({ sites, loading }: { sites: NonNullable<ReturnType<typeof useNoxSpotSites>["data"]>; loading: boolean }) {
  const { data: projects = [] } = useFeedProjects();
  const activeProjects = useMemo(() => projects.filter((project) => !project.archived), [projects]);
  const create = useCreateNoxSpotSite();
  const integrations = useQuery({ queryKey: ["integrations-status"], queryFn: fetchIntegrationsStatus, staleTime: 30_000 });
  const slackStatus = useQuery({ queryKey: ["slack-status"], queryFn: fetchSlackStatus, staleTime: 30_000 });
  const [name, setName] = useState("");
  const [projectId, setProjectId] = useState("");

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim() || !projectId) return;
    create.mutate({ name: name.trim(), projectId }, {
      onSuccess: () => { setName(""); setProjectId(""); },
    });
  };

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(280px,360px)_1fr]">
      <form onSubmit={submit} className="h-fit space-y-4 rounded-xl border border-stone-200 bg-white p-5">
        <div>
          <h2 className="font-medium text-stone-900">Add a capture site</h2>
          <p className="mt-1 text-xs text-stone-500">It uses this Nox workspace, GitHub project access, and optional Slack connection.</p>
        </div>
        <label className="block text-xs font-medium text-stone-600">
          Name
          <input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} required placeholder="Customer app" className="mt-1.5 w-full rounded-lg border border-stone-200 px-3 py-2 text-sm" />
        </label>
        <label className="block text-xs font-medium text-stone-600">
          GitHub project
          <select value={projectId} onChange={(event) => setProjectId(event.target.value)} className="mt-1.5 w-full rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm">
            <option value="">Select a project</option>
            {activeProjects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </label>
        <button disabled={create.isPending || !name.trim() || !projectId} className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-50">
          {create.isPending ? <Spinner size="sm" /> : <Plus size={15} />} Add site
        </button>
      </form>

      <div className="space-y-3">
        {loading ? <Loading /> : sites.length === 0 ? <Empty title="No capture sites configured" /> : sites.map((site) => (
          <SiteCard
            key={site.id}
            site={site}
            slackConnected={Boolean(integrations.data?.slack.connected && integrations.data?.canConfigure)}
            connections={slackStatus.data?.connections ?? []}
            defaultConnectionId={slackStatus.data?.defaultConnectionId ?? ""}
            fallbackChannelId={integrations.data?.slack.channels.fallback ?? ""}
          />
        ))}
      </div>
    </div>
  );
}

export function NoxSpotAdminSetup() {
  const { data: sites = [], isLoading } = useNoxSpotSites();
  return <SiteSetup sites={sites} loading={isLoading} />;
}

function SiteCard({
  site,
  slackConnected,
  connections,
  defaultConnectionId,
  fallbackChannelId,
}: {
  site: NonNullable<ReturnType<typeof useNoxSpotSites>["data"]>[number];
  slackConnected: boolean;
  connections: SlackConnection[];
  defaultConnectionId: string;
  fallbackChannelId: string;
}) {
  const [copied, setCopied] = useState(false);
  const update = useUpdateNoxSpotSite();
  const deleteSite = useDeleteNoxSpotSite();
  const testSlack = useTestNoxSpotSlack();
  const retryDeliveries = useRetryNoxSpotDeliveries();
  const { confirm, dialogProps } = useConfirm();
  const connectionId = site.slackConnectionId || defaultConnectionId;
  const slackChannels = useQuery({
    queryKey: ["slack-channels", connectionId || "default"],
    queryFn: () => fetchSlackChannels(connectionId).then((result) => result.channels),
    enabled: slackConnected && Boolean(connectionId),
    staleTime: 60_000,
  });
  const snippet = `<script src="https://api.noxspot.dev/widget/${site.id}.js" defer></script>`;
  const copy = async () => {
    await navigator.clipboard.writeText(snippet);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="rounded-xl border border-stone-200 bg-white p-5">
      <div className="flex items-start gap-3">
        <div className="rounded-lg bg-orange-50 p-2 text-accent"><Radar size={17} /></div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-medium text-stone-900">{site.name}</h3>
            {site.repo && <span className="rounded bg-stone-100 px-1.5 py-0.5 text-[11px] text-stone-500">{site.repo}</span>}
          </div>
          <p className="mt-1 text-xs text-stone-400">{site.openIssueCount} open · {site.issueCount} total</p>
        </div>
        <button
          type="button"
          disabled={deleteSite.isPending}
          onClick={async () => {
            const accepted = await confirm({
              title: `Delete ${site.name}?`,
              message: "Stored screenshots will be removed. Existing GitHub issues will remain.",
              confirmLabel: "Delete site",
              variant: "danger",
            });
            if (accepted) deleteSite.mutate(site.id);
          }}
          className="rounded-lg p-2 text-stone-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
          title="Delete capture site"
        >
          <Trash2 size={15} />
        </button>
      </div>
      <ConfirmDialog {...dialogProps} />
      <div className="mt-4">
        <p className="text-xs font-medium text-stone-700">Install snippet</p>
        <p className="mt-1 text-xs leading-5 text-stone-500">
          Paste this directly into the page you want to capture, ideally before <code>&lt;/body&gt;</code>. Do not place NoxSpot inside an iframe or sandbox; it must run in the main document to capture the page correctly.
        </p>
        <div className="mt-2 flex items-center gap-2 rounded-lg bg-stone-950 px-3 py-2.5">
          <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap text-xs text-stone-200">{snippet}</code>
          <button onClick={copy} className="shrink-0 text-stone-400 hover:text-white" title="Copy install code">
            {copied ? <Check size={15} /> : <Clipboard size={15} />}
          </button>
        </div>
      </div>
      <details className="mt-3 rounded-lg border border-stone-200 p-3">
        <summary className="cursor-pointer text-xs font-medium text-stone-600">Widget behavior</summary>
        <form
          className="mt-3 grid gap-3 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            update.mutate({
              id: site.id,
              buttonColor: String(data.get("buttonColor")),
              buttonText: String(data.get("buttonText")),
              widgetMode: data.get("widgetMode") === "release" ? "release" : "development",
              autoErrorLogging: data.get("autoErrorLogging") === "on",
            });
          }}
        >
          <label className="text-xs font-medium text-stone-500">Button text
            <input name="buttonText" defaultValue={site.buttonText} required maxLength={40} className="mt-1 w-full rounded-lg border border-stone-200 px-2 py-1.5 text-xs" />
          </label>
          <label className="text-xs font-medium text-stone-500">Button color
            <input name="buttonColor" type="color" defaultValue={site.buttonColor} className="mt-1 h-8 w-full rounded-lg border border-stone-200 p-1" />
          </label>
          <label className="text-xs font-medium text-stone-500">Reporter experience
            <select name="widgetMode" defaultValue={site.widgetMode} className="mt-1 w-full rounded-lg border border-stone-200 bg-white px-2 py-1.5 text-xs">
              <option value="development">Development</option>
              <option value="release">Release</option>
            </select>
          </label>
          <label className="flex items-end gap-2 pb-1 text-xs font-medium text-stone-500">
            <input name="autoErrorLogging" type="checkbox" defaultChecked={site.autoErrorLogging} /> Automatically report browser errors
          </label>
          <button type="submit" disabled={update.isPending} className="rounded-lg bg-stone-900 px-3 py-2 text-xs font-medium text-white disabled:opacity-50 sm:col-span-2">
            {update.isPending ? "Saving…" : "Save widget behavior"}
          </button>
        </form>
      </details>
      <NoxSpotWidgetConfiguration site={site} />
      <NoxSpotResolutionEmailTemplate siteId={site.id} />
      <div className="mt-3 rounded-lg border border-stone-200 bg-stone-50 p-3 text-xs leading-5 text-stone-600">
        External access now uses named, email-based guests. Manage access under Nox → People and choose this project plus NoxSpot.
      </div>
      <details className="mt-3 rounded-lg border border-stone-200 p-3">
        <summary className="flex cursor-pointer list-none items-center gap-2 text-xs font-medium text-stone-600">
          Slack delivery <SlackHealthBadge health={site.slackHealth} />
        </summary>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label className="text-xs font-medium text-stone-500" htmlFor={`spot-slack-${site.id}`}>Slack alerts</label>
        {slackConnected ? (
          <>
            <select
              aria-label={`Slack workspace for ${site.name}`}
              value={connectionId}
              disabled={update.isPending}
              onChange={(event) => update.mutate({ id: site.id, slackConnectionId: event.target.value || null, slackChannelId: null })}
              className="min-w-40 rounded-lg border border-stone-200 bg-white px-2 py-1.5 text-xs text-stone-600"
            >
              {connections.map((connection) => <option key={connection.id} value={connection.id}>{connection.teamName}</option>)}
            </select>
            <select
              id={`spot-slack-${site.id}`}
              value={site.slackChannelId ?? ""}
              disabled={update.isPending || slackChannels.isLoading}
              onChange={(event) => update.mutate({ id: site.id, slackConnectionId: connectionId, slackChannelId: event.target.value || null })}
              className="min-w-48 rounded-lg border border-stone-200 bg-white px-2 py-1.5 text-xs text-stone-600"
            >
              <option value="">{fallbackChannelId ? "Organization fallback" : "No channel"}</option>
              {(slackChannels.data ?? []).map((channel) => <option key={channel.id} value={channel.id}>#{channel.name}</option>)}
            </select>
          </>
        ) : (
          <span className="text-xs text-stone-400">Connect Slack once in Integrations to enable alerts.</span>
        )}
        {slackConnected && (site.slackChannelId || fallbackChannelId) ? (
          <button
            type="button"
            disabled={testSlack.isPending}
            onClick={() => testSlack.mutate(site.slackChannelId || fallbackChannelId)}
            className="inline-flex items-center gap-1 rounded-lg border border-stone-200 px-2 py-1.5 text-xs text-stone-600 hover:bg-stone-50 disabled:opacity-50"
          >
            {testSlack.isPending ? <Spinner size="sm" /> : <Send size={12} />} {testSlack.isSuccess ? "Sent" : "Test"}
          </button>
        ) : null}
        {site.slackBlockedCount > 0 ? (
          <button
            type="button"
            disabled={retryDeliveries.isPending || !slackConnected}
            onClick={() => retryDeliveries.mutate(site.id)}
            className="inline-flex items-center gap-1 rounded-lg border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs font-medium text-amber-700 hover:bg-amber-100 disabled:opacity-50"
          >
            <RefreshCw size={12} /> Retry {site.slackBlockedCount}
          </button>
        ) : null}
      </div>
      {site.slackEffectiveChannelId ? (
        <div className="mt-2 space-y-1 text-xs">
          {site.slackPendingCount > 0 ? <p className="text-blue-600">{site.slackPendingCount} notification{site.slackPendingCount === 1 ? "" : "s"} pending delivery.</p> : null}
          {site.slackLastDeliveredAt ? <p className="text-stone-400">Last delivered {new Date(site.slackLastDeliveredAt).toLocaleString()}.</p> : null}
          {site.slackLastError ? <p className="flex items-start gap-1 text-amber-700"><AlertTriangle size={12} className="mt-0.5 shrink-0" />{site.slackLastError}</p> : null}
          {testSlack.isError ? <p className="text-red-600">{testSlack.error instanceof Error ? testSlack.error.message : "Slack test failed"}</p> : null}
        </div>
      ) : null}
      <NoxSpotDailySummarySettings
        key={`${site.id}:${site.dailySummaryEnabled}`}
        site={site}
      />
      </details>
    </div>
  );
}

export function NoxSpotDailySummarySettings({ site }: { site: NoxSpotSite }) {
  const update = useUpdateNoxSpotSite();
  const [enabled, setEnabled] = useState(site.dailySummaryEnabled);

  return (
    <form
      className="mt-4 border-t border-stone-100 pt-3"
      onSubmit={(event) => {
        event.preventDefault();
        update.mutate({
          id: site.id,
          dailySummaryEnabled: enabled,
        });
      }}
    >
      <div className="flex flex-wrap items-center gap-3">
        <div className="mr-auto min-w-52">
          <p className="flex items-center gap-1.5 text-xs font-medium text-stone-700">
            <Clock3 size={13} /> Daily issue summary
          </p>
          <p className="mt-1 text-[11px] leading-4 text-stone-400">
            Posts issues filed and solved in the previous 24 hours, including how each solved issue was closed. Sent daily at 00:00 UTC.
          </p>
        </div>
        <label className="inline-flex items-center gap-2 text-xs font-medium text-stone-600">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          Enabled
        </label>
        <button
          type="submit"
          disabled={update.isPending}
          className="rounded-lg bg-stone-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
        >
          {update.isPending ? "Saving…" : "Save summary"}
        </button>
      </div>
      {update.isSuccess ? <p className="mt-2 text-[11px] text-green-700">Daily summary settings saved.</p> : null}
      {update.isError ? (
        <p role="alert" className="mt-2 text-[11px] text-red-600">
          {update.error instanceof Error ? update.error.message : "Daily summary settings could not be saved."}
        </p>
      ) : null}
    </form>
  );
}

function SlackHealthBadge({ health }: { health: NoxSpotSite["slackHealth"] }) {
  const view = health === "connected"
    ? { label: "Healthy", className: "border-green-200 bg-green-50 text-green-700", icon: <Check size={11} /> }
    : health === "pending"
      ? { label: "Pending", className: "border-blue-200 bg-blue-50 text-blue-700", icon: <Clock3 size={11} /> }
      : health === "degraded"
        ? { label: "Needs attention", className: "border-amber-200 bg-amber-50 text-amber-700", icon: <AlertTriangle size={11} /> }
        : health === "disconnected"
          ? { label: "Disconnected", className: "border-red-200 bg-red-50 text-red-700", icon: <AlertTriangle size={11} /> }
          : { label: "Off", className: "border-stone-200 bg-stone-50 text-stone-500", icon: null };
  return <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium", view.className)}>{view.icon}{view.label}</span>;
}

function Loading() {
  return <div className="flex items-center justify-center py-16"><Spinner className="h-6 w-6 text-accent" /></div>;
}

function Empty({ title, action, onAction }: { title: string; action?: string; onAction?: () => void }) {
  return (
    <div className="rounded-xl border border-dashed border-stone-300 bg-white py-14 text-center">
      <Radar className="mx-auto h-7 w-7 text-stone-300" />
      <p className="mt-3 text-sm text-stone-500">{title}</p>
      {action && <button onClick={onAction} className="mt-3 text-sm font-medium text-accent hover:underline">{action}</button>}
    </div>
  );
}
