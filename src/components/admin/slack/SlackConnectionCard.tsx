import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, MessageSquare } from "lucide-react";
import {
  startSlackOAuth,
  disconnectSlack,
  updateSlackConnectionProject,
  type SlackConnection,
} from "@/lib/slack-api";
import { apiPost } from "@/lib/api";
import { useSlackChannels } from "@/components/admin/slack/useSlackChannels";
import { SlackRouteField } from "@/components/admin/slack/SlackRouteField";
import { SlackChannelStatusBadge } from "@/components/admin/slack/SlackChannelStatusBadge";
import { findSlackChannelStatus } from "@/lib/slack-channel-status";
import { useFeedProjects } from "@/hooks/useNoxlink";
import type { FeedProject } from "@/lib/noxlink-api";
import { actionableSlackFeedback, slackOAuthFeedback } from "@/lib/slack-feedback";

// The NoxConnect-section Slack card: connection lifecycle (connect / reconnect /
// disconnect), health stats, and the organization fallback channel. Per-tool
// routes live in their own tool sections via SlackRouteField.
export function SlackConnectionCard() {
  const qc = useQueryClient();
  const { status } = useSlackChannels();
  const projects = useFeedProjects();
  const [newProjectId, setNewProjectId] = useState("");

  // Seed the OAuth-failure banner from the ?slack= param at first render —
  // the callback redirects back with the failure reason in the URL.
  const [error, setError] = useState<string | null>(() => {
    const flag = new URLSearchParams(window.location.search).get("slack");
    return flag && flag !== "ok" && flag !== "cancelled"
      ? slackOAuthFeedback(flag)
      : null;
  });
  const [busy, setBusy] = useState<"connect" | "disconnect" | null>(null);

  // Honors the ?slack=ok param the OAuth callback redirects to: refetch
  // everything Slack-shaped, then strip the param so a reload doesn't
  // re-trigger it. (Failure values are handled by the error initializer.)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const flag = params.get("slack");
    if (!flag) return;
    if (flag === "ok") {
      void Promise.all([
        qc.refetchQueries({ queryKey: ["slack-status"], type: "all" }),
        qc.refetchQueries({ queryKey: ["integrations-status"], type: "all" }),
        qc.refetchQueries({ queryKey: ["slack-channels"], type: "all" }),
      // Server side wipes the public channel selections
      // when the team_id changes (or on disconnect). Invalidate the local
      // settings cache too so the UI doesn't show channels selected after a
      // workspace switch.
        qc.refetchQueries({ queryKey: ["settings"], type: "all" }),
      ]);
    }
    params.delete("slack");
    const next = params.toString();
    window.history.replaceState({}, "", `${window.location.pathname}${next ? `?${next}` : ""}`);
  }, [qc]);

  async function handleConnect(options?: { team?: string | null; projectId?: string | null }) {
    setError(null);
    setBusy("connect");
    try {
      const { url } = await startSlackOAuth(options);
      window.location.href = url;
    } catch (err) {
      setError(actionableSlackFeedback(err, "Start Connect Slack again; if it repeats, ask an operator to review the deployment."));
      setBusy(null);
    }
  }

  async function handleDisconnect(connectionId: string) {
    setError(null);
    setBusy("disconnect");
    try {
      await disconnectSlack(connectionId);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["slack-status"] }),
        qc.invalidateQueries({ queryKey: ["integrations-status"] }),
        // Server cleared the public Slack channel selections.
        // Refetch so the dropdowns don't show stale selections.
        qc.invalidateQueries({ queryKey: ["settings"] }),
      ]);
    } catch (err) {
      setError(actionableSlackFeedback(err, "Refresh the connection list, then disconnect the workspace again."));
    } finally {
      setBusy(null);
    }
  }

  if (status.isLoading) {
    return (
      <div className="bg-white rounded-xl border border-stone-200 p-5">
        <Loader2 size={14} className="animate-spin text-stone-400" />
      </div>
    );
  }

  const data = status.data;
  const allProjects = projects.data ?? [];
  const activeProjects = allProjects.filter((project) => !project.archived && project.routing_enabled === 1);
  const existingAssignmentsComplete = data?.connections?.every((connection) => connection.projectId) ?? true;

  return (
    <div className="bg-white rounded-xl border border-stone-200 p-5 space-y-4">
      <div className="flex items-center gap-2">
        <MessageSquare size={14} className="text-stone-500" />
        <h2 className="text-sm font-semibold text-stone-900">NoxConnect · Slack</h2>
        <span className="rounded-full bg-stone-100 px-2 py-0.5 text-[11px] font-medium text-stone-500">Optional</span>
        {data?.connected && data.teamName && (
          <span className={`inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded border ${data.health === "degraded" || data.blockedDeliveries > 0 ? "bg-amber-50 text-amber-700 border-amber-200" : "bg-green-50 text-green-700 border-green-200"}`}>
            {data.needsReconnect ? "Reconnect required" : data.health === "degraded" || data.blockedDeliveries > 0 ? "Needs attention" : data.health === "unknown" ? "Checking" : "Connected"} · {data.teamName}
          </span>
        )}
      </div>
      <p className="text-xs text-stone-400">
        One Slack workspace can serve the whole organization. To add another,
        assign the current workspace and the new workspace to projects first.
        The bot must be added to private channels before it can post there.
      </p>

      {data?.connections?.length ? (
        <div className="space-y-2">
          {data.connections.map((connection) => (
            <SlackConnectionRow
              key={connection.id}
              connection={connection}
              disconnecting={busy === "disconnect"}
              projects={allProjects.filter((project) => (
                (!project.archived && project.routing_enabled === 1) || project.id === connection.projectId
              ))}
              projectRequired={Boolean(data.projectAssignmentRequired)}
              reconnecting={busy === "connect"}
              onReconnect={() => handleConnect({
                team: connection.teamId,
                projectId: connection.projectId,
              })}
              onDisconnect={handleDisconnect}
              onError={setError}
            />
          ))}
        </div>
      ) : null}

      {data?.connected && (
        <div className="grid gap-2 rounded-lg bg-stone-50 p-3 text-xs sm:grid-cols-3">
          <div><span className="text-stone-400">Pending</span><p className="mt-0.5 font-medium text-stone-700">{data.pendingDeliveries}</p></div>
          <div><span className="text-stone-400">Blocked</span><p className={`mt-0.5 font-medium ${data.blockedDeliveries > 0 ? "text-amber-700" : "text-stone-700"}`}>{data.blockedDeliveries}</p></div>
          <div><span className="text-stone-400">Last delivered</span><p className="mt-0.5 font-medium text-stone-700">{data.lastDeliveredAt ? new Date(data.lastDeliveredAt).toLocaleString() : "No deliveries yet"}</p></div>
          {data.lastError ? <p className="sm:col-span-3 text-amber-700">{actionableSlackFeedback(data.lastError, "Reconnect the affected workspace, then send a test message.")}</p> : null}
        </div>
      )}

      {data?.needsReconnect && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          This organization is still connected through the legacy Slack app.
          Use Reconnect on each affected workspace to migrate it to NoxConnect;
          existing channel choices are retained.
        </div>
      )}

      {!data?.appConfigured && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-800">
          The Slack app credentials aren't configured on this deployment. An operator
          needs to set <code>SLACK_CLIENT_ID</code>, <code>SLACK_CLIENT_SECRET</code>,
          and <code>SLACK_SIGNING_SECRET</code> as Cloudflare Pages secrets.
        </div>
      )}

      {!data?.connected ? (
        <button
          type="button"
          onClick={() => handleConnect({ team: null })}
          disabled={busy === "connect" || !data?.canConfigure || !data?.appConfigured}
          className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-accent text-white text-xs font-medium hover:bg-accent/90 disabled:opacity-50 cursor-pointer"
        >
          {busy === "connect" && <Loader2 size={12} className="animate-spin" />}
          Connect Slack
        </button>
      ) : (
        <>
          <div className="border-t border-stone-100 pt-4">
            <SlackRouteField
              label="Organization fallback"
              helpText="Used only when a service-specific channel is empty."
              kind="fallback"
              routeKey="fallbackChannelId"
            />
          </div>

          <div className="space-y-2 border-t border-stone-100 pt-3">
            <label className="block text-xs font-medium text-stone-600">
              Project for new workspace
              <select
                value={newProjectId}
                onChange={(event) => setNewProjectId(event.target.value)}
                className="mt-1.5 block w-full max-w-sm rounded-lg border border-stone-200 bg-white px-2.5 py-1.5 text-xs text-stone-700"
              >
                <option value="">Choose project</option>
                {activeProjects.map((project) => (
                  <option key={project.id} value={project.id}>{project.name}</option>
                ))}
              </select>
            </label>
            {!existingAssignmentsComplete ? (
              <p className="text-xs text-amber-700">Assign every connected workspace to a project before adding another.</p>
            ) : null}
            <div className="flex items-center gap-3 flex-wrap">
            <button
              type="button"
              onClick={() => handleConnect({ team: null, projectId: newProjectId })}
              disabled={busy === "connect" || !data.canConfigure || !data.appConfigured || !newProjectId || !existingAssignmentsComplete}
              className="inline-flex cursor-pointer items-center gap-2 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent/90 disabled:opacity-50"
            >
              {busy === "connect" && <Loader2 size={12} className="animate-spin" />}
              Add Slack workspace
            </button>
            {(data.health === "degraded" || data.needsReconnect) ? <span className="text-xs text-amber-700">Reconnect by adding the affected workspace again.</span> : null}
            </div>
          </div>
        </>
      )}
      {error && <span className="text-xs text-red-500">{error}</span>}
    </div>
  );
}

function SlackConnectionRow({
  connection,
  disconnecting,
  projects,
  projectRequired,
  reconnecting,
  onReconnect,
  onDisconnect,
  onError,
}: {
  connection: SlackConnection;
  disconnecting: boolean;
  projects: FeedProject[];
  projectRequired: boolean;
  reconnecting: boolean;
  onReconnect: () => Promise<void>;
  onDisconnect: (connectionId: string) => Promise<void>;
  onError: (message: string | null) => void;
}) {
  const qc = useQueryClient();
  const { channels, status } = useSlackChannels(connection.id);
  const [channelId, setChannelId] = useState("");
  const [testing, setTesting] = useState(false);
  const [savingProject, setSavingProject] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; message: string } | null>(null);

  async function handleProjectChange(projectId: string) {
    onError(null);
    setSavingProject(true);
    try {
      await updateSlackConnectionProject(connection.id, projectId || null);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["slack-status"] }),
        qc.invalidateQueries({ queryKey: ["integrations-status"] }),
      ]);
    } catch (err) {
      onError(actionableSlackFeedback(err, "Choose an active project assignment, then save again."));
    } finally {
      setSavingProject(false);
    }
  }

  async function handleTest() {
    if (!channelId) return;
    onError(null);
    setFeedback(null);
    setTesting(true);
    try {
      await apiPost("/api/v1/slack/test", {
        connectionId: connection.id,
        channelId,
        kind: "connection",
      });
      await Promise.all([
        status.refetch(),
        qc.invalidateQueries({ queryKey: ["integrations-status"] }),
      ]);
      const selectedChannel = (channels.data ?? []).find((channel) => channel.id === channelId);
      setFeedback({ ok: true, message: `Test delivered to ${selectedChannel ? `#${selectedChannel.name}` : "the selected channel"}. This workspace and channel are ready.` });
    } catch (err) {
      await status.refetch();
      setFeedback({ ok: false, message: actionableSlackFeedback(err, "Review this workspace and channel, then send the test again.") });
    } finally {
      setTesting(false);
    }
  }

  const statusText = connection.needsReconnect
    ? "Reconnect this workspace, then send a test message."
    : connection.health === "degraded"
      ? actionableSlackFeedback(connection.lastError, "Reconnect this workspace, then send a test message.")
      : connection.health === "unknown"
        ? "Not verified yet. Choose a channel and send a test message."
        : "Connected and authorized.";
  const channelStatus = findSlackChannelStatus(status.data?.channelStatuses, connection.id, channelId);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-stone-200 px-3 py-2">
      <div>
        <p className="text-xs font-medium text-stone-800">
          {connection.teamName}
          {connection.isDefault ? <span className="ml-2 text-[10px] font-normal text-stone-400">Default</span> : null}
        </p>
        <p className={`text-[11px] ${connection.health === "degraded" || connection.needsReconnect ? "text-amber-700" : "text-stone-400"}`}>
          {statusText}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {connection.needsReconnect ? (
          <button
            type="button"
            onClick={() => void onReconnect()}
            disabled={reconnecting}
            aria-label={`Reconnect ${connection.teamName}`}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-accent px-2.5 py-1.5 text-xs font-medium text-white hover:bg-accent/90 disabled:opacity-50"
          >
            {reconnecting ? <Loader2 size={12} className="animate-spin" /> : null}
            {reconnecting ? "Opening Slack…" : "Reconnect"}
          </button>
        ) : null}
        <select
          value={connection.projectId ?? ""}
          onChange={(event) => void handleProjectChange(event.target.value)}
          disabled={savingProject}
          aria-label={`Project for ${connection.teamName}`}
          className="min-w-44 rounded-lg border border-stone-200 bg-white px-2 py-1.5 text-xs text-stone-600 disabled:opacity-50"
        >
          <option value="" disabled={projectRequired}>{projectRequired ? "Choose project" : "Organization-wide"}</option>
          {projects.map((project) => {
            const inactive = Boolean(project.archived) || project.routing_enabled !== 1;
            return (
              <option key={project.id} value={project.id} disabled={inactive}>
                {project.name}{inactive ? " (inactive)" : ""}
              </option>
            );
          })}
        </select>
        <select
          value={channelId}
          onChange={(event) => setChannelId(event.target.value)}
          disabled={channels.isLoading || channels.isError}
          aria-label={`Test channel for ${connection.teamName}`}
          className="min-w-44 rounded-lg border border-stone-200 bg-white px-2 py-1.5 text-xs text-stone-600 disabled:opacity-50"
        >
          <option value="">{channels.isLoading ? "Loading channels…" : channels.isError ? "Channels unavailable" : "Choose test channel"}</option>
          {(channels.data ?? []).map((channel) => (
            <option key={channel.id} value={channel.id}>{channel.is_private ? "🔒 " : "#"}{channel.name}</option>
          ))}
        </select>
        {channelId ? <SlackChannelStatusBadge status={channelStatus} /> : null}
        <button
          type="button"
          onClick={handleTest}
          disabled={testing || !channelId}
          className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-stone-200 bg-white px-2.5 py-1.5 text-xs font-medium text-blue-600 hover:border-blue-200 hover:bg-blue-50 disabled:opacity-50"
        >
          {testing ? <Loader2 size={12} className="animate-spin" /> : null}
          {testing ? "Sending…" : "Send test"}
        </button>
        <button
          type="button"
          onClick={() => void onDisconnect(connection.id)}
          disabled={disconnecting}
          className="cursor-pointer text-xs text-stone-500 hover:text-red-600 disabled:opacity-50"
        >
          Disconnect
        </button>
      </div>
      {channels.isError ? (
        <p className="w-full text-xs text-red-500">{actionableSlackFeedback(channels.error, "Reconnect this workspace, then reload its channels.")}</p>
      ) : null}
      {feedback ? <p className={`w-full text-xs ${feedback.ok ? "text-green-600" : "text-red-500"}`}>{feedback.message}</p> : null}
    </div>
  );
}

// Read-only summary for non-admins, fed by the shared NoxConnect status —
// no admin-only API calls.
export function SlackConnectionSummaryCard({
  connected,
  teamName,
}: {
  connected: boolean;
  teamName: string | null;
}) {
  return (
    <div className="bg-white rounded-xl border border-stone-200 p-5 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <MessageSquare size={14} className="text-stone-500" />
        <h2 className="text-sm font-semibold text-stone-900">NoxConnect · Slack</h2>
        <span className="rounded-full bg-stone-100 px-2 py-0.5 text-[11px] font-medium text-stone-500">Optional</span>
        <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${connected ? "border-green-200 bg-green-50 text-green-700" : "border-amber-200 bg-amber-50 text-amber-700"}`}>
          {connected ? `Connected${teamName ? ` · ${teamName}` : ""}` : "Not connected"}
        </span>
      </div>
      <p className="text-xs text-stone-500">An organization admin manages this connection and its channel routing.</p>
    </div>
  );
}
