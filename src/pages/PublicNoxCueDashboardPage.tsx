import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, AlertTriangle, Bell, CheckCircle2, ChevronDown, Clock3, ExternalLink, LockKeyhole, LogOut, RefreshCw, ShieldCheck } from "lucide-react";
import { useParams } from "react-router-dom";
import { Spinner } from "@/components/Spinner";

interface Comparison {
  yesterday: number | null;
  average30d: number | null;
  sampleDays: number;
  history: Array<{ period: string; value: number }>;
}
interface DashboardSource {
  id: string; name: string; environment: string; period: string;
  settings: { collecting: boolean; digestEnabled: boolean; alertsEnabled: boolean; timezone: string; digestTimeLocal: string };
  endpoint: { enabled: boolean; url: string | null; status: "waiting" | "healthy" | "issue"; lastCheckedAt: string | null; statusCode: number | null; latencyMs: number | null; error: string | null };
  metrics: Record<string, number>;
  comparisons: Record<string, Comparison>;
  metricLabels: Record<string, string>;
  features: Array<{
    key: string; label: string; description: string; failureMessage: string;
    status: "waiting" | "healthy" | "issue"; lastResultAt: string | null;
    lastFailureAt: string | null; lastSuccessAt: string | null; incidentStartedAt: string | null;
    consecutiveFailures: number; successfulAttemptsSinceLastFailure: number;
    lastReason: string | null; successes24h: number; rejections24h: number; failures24h: number;
    results: Array<{
      id: string; outcome: "success" | "rejected" | "failure"; reason: string | null;
      message: string | null; error: { name: string | null; message: string; code: string | null; status: number | null; stack: string | null } | null;
      context: { environment: string | null; release: string | null; runtime: string | null; url: string | null };
      diagnosis: { summary: string | null; possibleCauses: string[]; possibleFixes: string[] };
      durationMs: number | null; occurredAt: string; receivedAt: string;
    }>;
  }>;
  errors: Array<{
    fingerprint: string; title: string; errorCode: string | null; component: string | null; firstSeenAt: string; lastSeenAt: string; occurrenceCount: number;
    status: "open" | "acknowledged" | "resolved"; acknowledgedAt: string | null; acknowledgedBy: string | null; resolvedAt: string | null; resolvedBy: string | null;
    occurrences: Array<{ id: string; message: string | null; occurredAt: string; receivedAt: string; url: string | null; errorCode: string | null; component: string | null; environment: string | null; release: string | null; runtime: string | null; errorName: string | null; errorStack: string | null; errorStatus: number | null; fatal: boolean; unhandled: boolean }>;
  }>;
}
interface DashboardData { project: { name: string }; generatedAt: string; sources: DashboardSource[] }
type DashboardTab = "stats" | "alerts";

const STANDARD_LABELS: Record<string, string> = {
  "users.new": "New users", "users.total": "Total users", "users.active.daily": "Daily active",
  "users.active.weekly": "Weekly active", "users.active.monthly": "Monthly active",
  "users.stickiness.dau_mau": "DAU / MAU",
};

function formatValue(key: string, value: number) {
  return key.includes("ratio") || key.endsWith("dau_mau")
    ? `${(value * 100).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`
    : value.toLocaleString(undefined, { maximumFractionDigits: key.endsWith(".per_user") ? 2 : 0 });
}

function formatDate(value: string | null) {
  return value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "Not checked yet";
}

function humanizeReason(value: string | null) {
  if (!value) return "Critical failure";
  return value.replaceAll("_", " ").replace(/^./, (character) => character.toUpperCase());
}

function featureAction(feature: DashboardSource["features"][number]) {
  const reason = feature.lastReason ?? "";
  if (reason === "timeout" || reason === "network_error") return "Check upstream latency and the network path used by this journey.";
  if (reason === "database_unavailable") return "Check database health, connection limits and recent failovers.";
  if (reason === "rate_limited") return "Check provider rate limits and recent request volume.";
  if (reason === "configuration_error") return "Review the production configuration and credentials for this journey.";
  if (reason === "email_delivery_failed" || feature.key.includes("email_verification") || feature.key.includes("password_reset")) {
    return "Check the email provider, verified sender and recent delivery failures.";
  }
  if (reason === "dependency_unavailable" || feature.key.startsWith("auth.")) {
    return "Check the authentication provider, production credentials and recent application logs.";
  }
  return "Trace the latest failed event in the application logs and verify the affected dependency.";
}

function receiptTiming(occurredAt: string, receivedAt: string) {
  const delay = Math.max(0, new Date(receivedAt).valueOf() - new Date(occurredAt).valueOf());
  if (!Number.isFinite(delay) || delay < 1_000) return "received immediately";
  if (delay < 60_000) return `received ${Math.round(delay / 1_000)}s later`;
  return `received ${Math.round(delay / 60_000)}m later`;
}

function Sparkline({ values, issue = false }: { values: number[]; issue?: boolean }) {
  const points = useMemo(() => {
    if (!values.length) return "";
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    return values.map((value, index) => `${(index / Math.max(values.length - 1, 1)) * 100},${32 - ((value - min) / range) * 26}`).join(" ");
  }, [values]);
  return <svg viewBox="0 0 100 36" preserveAspectRatio="none" aria-hidden="true" className="h-12 w-full overflow-visible">
    <path d="M0 32 H100" stroke="currentColor" className="text-stone-200" strokeWidth="1" />
    <polyline points={points} fill="none" stroke={issue ? "#fb7185" : "#ef7974"} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
  </svg>;
}

function NoxCueBrand({ compact = false }: { compact?: boolean }) {
  return <div className="flex items-center gap-3">
    <span className={`grid ${compact ? "size-9 rounded-[11px]" : "size-11 rounded-[14px]"} place-items-center bg-gradient-to-br from-[#fe795d] to-[#9b78f4] text-white shadow-lg shadow-[#9b78f4]/10`}><Activity size={compact ? 17 : 20} strokeWidth={2.25} /></span>
    <div><p className={`${compact ? "text-lg" : "text-xl"} font-display tracking-tight text-stone-900`}><span className="font-bold">Nox</span><span className="font-normal">Cue</span></p>{compact ? null : <p className="mt-0.5 text-[10px] uppercase tracking-[0.22em] text-stone-400">Product health</p>}</div>
  </div>;
}

function StatusPill({ on, label }: { on: boolean; label: string }) {
  return <span className={`rounded-full border px-2.5 py-1 text-[11px] font-medium ${on ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-stone-200 bg-stone-100 text-stone-500"}`}>{label}: {on ? "On" : "Off"}</span>;
}

export function PublicNoxCueDashboardPage() {
  const { slug = "" } = useParams();
  const [data, setData] = useState<DashboardData | null>(null);
  const [projectName, setProjectName] = useState("NoxCue dashboard");
  const [passwordRequired, setPasswordRequired] = useState(false);
  const [password, setPassword] = useState("");
  const [selectedSourceId, setSelectedSourceId] = useState("");
  const [activeTab, setActiveTab] = useState<DashboardTab>("stats");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const result = await fetch(`/api/public/cue-dashboards/${encodeURIComponent(slug)}`, { cache: "no-store" });
      const body = await result.json() as DashboardData & { error?: string; projectName?: string };
      if (result.status === 401) {
        setProjectName(body.projectName || "NoxCue dashboard"); setPasswordRequired(true); setData(null); return;
      }
      if (!result.ok) throw new Error(body.error || "This dashboard is unavailable.");
      setData(body); setProjectName(body.project.name); setPasswordRequired(false);
      setSelectedSourceId((current) => body.sources.some((source) => source.id === current) ? current : body.sources[0]?.id ?? "");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "This dashboard is unavailable."); }
    finally { setLoading(false); }
  }, [slug]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { const previous = document.title; document.title = `${projectName} · NoxCue`; return () => { document.title = previous; }; }, [projectName]);

  const login = async (event: React.FormEvent) => {
    event.preventDefault(); setLoading(true); setError("");
    try {
      const result = await fetch(`/api/public/cue-dashboards/${encodeURIComponent(slug)}/login`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }),
      });
      const body = await result.json() as { error?: string };
      if (!result.ok) throw new Error(body.error || "Could not unlock this dashboard.");
      setPassword(""); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not unlock this dashboard."); setLoading(false); }
  };

  if (loading && !data) return <main className="flex min-h-screen items-center justify-center bg-[#fafaf9]"><Spinner size="lg" /></main>;
  if (passwordRequired) return <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[#fafaf9] px-5 py-12 text-stone-900">
    <div className="pointer-events-none absolute inset-0 opacity-70 [background:radial-gradient(circle_at_15%_10%,#fdefee_0,transparent_34%),radial-gradient(circle_at_90%_85%,rgba(155,120,244,.10)_0,transparent_32%)]" />
    <form onSubmit={login} className="relative w-full max-w-md overflow-hidden rounded-3xl border border-stone-200 bg-white/95 p-7 shadow-2xl shadow-stone-300/35 sm:p-9">
      <div className="absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r from-[#fe795d] to-[#9b78f4]" />
      <div className="mb-8 flex items-center justify-between gap-4"><NoxCueBrand /><p className="rounded-full border border-stone-200 bg-stone-50 px-2.5 py-1 text-[10px] uppercase tracking-[0.16em] text-stone-400">Dashboard</p></div>
      <h1 className="mb-4 font-display text-2xl text-stone-900">{projectName}</h1>
      <div className="mb-5 flex items-start gap-3 rounded-2xl bg-stone-50 p-4"><LockKeyhole className="mt-0.5 shrink-0 text-[#c85f5b]" size={18} /><p className="text-sm leading-6 text-stone-600">Enter the project password to view its read-only product health dashboard.</p></div>
      <label className="text-xs font-medium uppercase tracking-wider text-stone-500">Password<input autoFocus type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required className="mt-2 w-full rounded-xl border border-stone-300 bg-white px-4 py-3 text-base text-stone-900 outline-none transition focus:border-[#ef7974] focus:ring-2 focus:ring-[#ef7974]/15" /></label>
      {error ? <p role="alert" className="mt-3 text-sm text-red-600">{error}</p> : null}
      <button disabled={loading || !password} className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl bg-[#ef7974] px-4 py-3 text-sm font-semibold text-[#18181b] transition hover:bg-[#f38b86] disabled:opacity-50">{loading ? <Spinner size="sm" /> : <ShieldCheck size={17} />} Open dashboard</button>
      <p className="mt-6 text-center text-xs text-stone-400">Read-only access · no account required</p>
    </form>
  </main>;
  if (!data) return <main className="flex min-h-screen items-center justify-center bg-[#fafaf9] px-5 text-stone-500"><p>{error || "This dashboard is unavailable."}</p></main>;

  const source = data.sources.find((candidate) => candidate.id === selectedSourceId) ?? data.sources[0];
  return <main className="min-h-screen bg-[#fafaf9] text-stone-800">
    <header className="relative overflow-hidden border-b border-stone-200 bg-white">
      <div className="absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r from-[#fe795d] to-[#9b78f4]" />
      <div className="pointer-events-none absolute inset-0 opacity-60 [background:radial-gradient(circle_at_80%_-20%,rgba(155,120,244,.10),transparent_35%)]" />
      <div className="mx-auto max-w-6xl px-5 py-7 sm:px-8">
        <div className="flex flex-wrap items-start justify-between gap-5">
          <div className="relative"><NoxCueBrand compact /><h1 className="mt-5 font-display text-4xl text-stone-900">{data.project.name}</h1><p className="mt-2 text-sm text-stone-500">Completed day {source?.period ?? "—"} · Updated {formatDate(data.generatedAt)}</p></div>
          <div className="relative flex gap-2"><button onClick={() => void load()} disabled={loading} className="inline-flex items-center gap-2 rounded-full border border-stone-200 bg-white px-4 py-2 text-xs text-stone-600 hover:border-[#ef7974]/50 hover:bg-[#fdefee] hover:text-[#a94d49]"><RefreshCw size={14} /> Refresh</button><button onClick={async () => { await fetch(`/api/public/cue-dashboards/${encodeURIComponent(slug)}`, { method: "DELETE" }); setData(null); setPasswordRequired(true); }} className="inline-flex items-center gap-2 rounded-full border border-stone-200 bg-white px-4 py-2 text-xs text-stone-600 hover:border-[#ef7974]/50 hover:bg-[#fdefee] hover:text-[#a94d49]"><LogOut size={14} /> Lock</button></div>
        </div>
        {data.sources.length > 1 ? <div className="relative mt-6 flex flex-wrap gap-2">{data.sources.map((candidate) => <button key={candidate.id} onClick={() => setSelectedSourceId(candidate.id)} className={`rounded-full px-3 py-1.5 text-xs font-medium capitalize ${candidate.id === source?.id ? "bg-[#ef7974] text-stone-900" : "bg-stone-100 text-stone-500 hover:bg-stone-200 hover:text-stone-700"}`}>{candidate.environment}</button>)}</div> : null}
      </div>
    </header>
    {!source ? <div className="mx-auto max-w-6xl px-5 py-12 text-stone-500">No NoxCue environments are linked to this project.</div> : <Dashboard key={source.id} source={source} activeTab={activeTab} onTabChange={setActiveTab} />}
    <footer className="border-t border-stone-200 px-5 py-7 text-center text-xs text-stone-400"><span className="font-display"><strong className="text-stone-600">Nox</strong>Cue</span> · protected through <span className="font-display"><strong className="text-stone-600">Nox</strong>Connect</span></footer>
  </main>;
}

function Dashboard({ source, activeTab, onTabChange }: { source: DashboardSource; activeTab: DashboardTab; onTabChange: (tab: DashboardTab) => void }) {
  const [expandedError, setExpandedError] = useState<string | null>(null);
  const [expandedFeature, setExpandedFeature] = useState<string | null>(null);
  const metricEntries = Object.entries(source.metrics);
  const featureIssues = source.features.filter((feature) => feature.status === "issue");
  const activeErrors = source.errors.filter((error) => error.status !== "resolved");
  const healthyFeatures = source.features.filter((feature) => feature.status === "healthy").length;
  return <div className="mx-auto max-w-6xl space-y-8 px-5 py-9 sm:px-8">
    <nav role="tablist" aria-label="Dashboard sections" className="flex border-b border-stone-200">
      <button id="noxcue-stats-tab" type="button" role="tab" aria-selected={activeTab === "stats"} aria-controls="noxcue-stats-panel" onClick={() => onTabChange("stats")} className={`relative flex items-center gap-2 px-1 pb-3 pr-6 text-sm font-medium transition ${activeTab === "stats" ? "text-stone-900 after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:bg-[#ef7974]" : "text-stone-400 hover:text-stone-700"}`}><Activity size={15} /> Stats</button>
      <button id="noxcue-alerts-tab" type="button" role="tab" aria-selected={activeTab === "alerts"} aria-controls="noxcue-alerts-panel" onClick={() => onTabChange("alerts")} className={`relative flex items-center gap-2 px-1 pb-3 pr-6 text-sm font-medium transition ${activeTab === "alerts" ? "text-stone-900 after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:bg-[#ef7974]" : "text-stone-400 hover:text-stone-700"}`}><Bell size={15} /> Alerts{featureIssues.length || activeErrors.length || source.endpoint.status === "issue" ? <span className="size-1.5 rounded-full bg-red-500" aria-hidden="true" title="Active issue" /> : null}</button>
    </nav>
    {activeTab === "stats" ? <section id="noxcue-stats-panel" role="tabpanel" aria-labelledby="noxcue-stats-tab"><div className="mb-4 flex flex-wrap items-center justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#b7524f] capitalize">{source.environment}</p><h2 className="mt-1 font-display text-2xl text-stone-900">Daily pulse</h2></div><div className="flex flex-wrap gap-2"><StatusPill on={source.settings.collecting} label="Collection" /><StatusPill on={source.settings.digestEnabled} label="Digest" /></div></div>
      {metricEntries.length ? <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{metricEntries.map(([key, value]) => {
        const comparison = source.comparisons[key]; const yesterday = comparison?.yesterday; const delta = yesterday === null || yesterday === undefined ? null : value - yesterday;
        return <article key={key} className="rounded-2xl border border-stone-200 bg-white p-5 shadow-sm shadow-stone-200/30"><div className="flex items-start justify-between gap-3"><div><p className="text-xs text-stone-500">{source.metricLabels[key] ?? STANDARD_LABELS[key] ?? key}</p><p className="mt-1 text-3xl font-semibold tracking-tight text-stone-900">{formatValue(key, value)}</p></div><p className={`text-xs font-medium ${delta === null || delta === 0 ? "text-stone-400" : delta > 0 ? "text-emerald-700" : "text-amber-700"}`}>{delta === null ? "No comparison" : delta === 0 ? "Same as yesterday" : `${delta > 0 ? "+" : ""}${formatValue(key, delta)} vs yesterday`}</p></div><div className="mt-4"><Sparkline values={comparison?.history.map((point) => point.value) ?? []} /></div><p className="mt-1 text-[11px] text-stone-400">30d average {comparison?.average30d === null || comparison?.average30d === undefined ? "—" : formatValue(key, comparison.average30d)}</p></article>;
      })}</div> : <div className="rounded-2xl border border-dashed border-stone-300 p-6 text-sm text-stone-500">No completed-day statistics yet.</div>}
    </section> : <div id="noxcue-alerts-panel" role="tabpanel" aria-labelledby="noxcue-alerts-tab" className="space-y-8">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#b7524f] capitalize">{source.environment}</p><h2 className="mt-1 font-display text-2xl text-stone-900">Alert health</h2></div><StatusPill on={source.settings.alertsEnabled} label="Alerts" /></div>
    <div className="grid gap-5 lg:grid-cols-2">
      <section className="rounded-2xl border border-stone-200 bg-white p-5 shadow-sm shadow-stone-200/30"><div className="flex items-start justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-stone-400">Endpoint</p><h2 className="mt-1 font-display text-xl text-stone-900">Availability</h2></div><HealthStatus status={source.endpoint.enabled ? source.endpoint.status : "off"} /></div>{source.endpoint.enabled ? <div className="mt-5 space-y-2 text-sm text-stone-700"><p className="break-all">{source.endpoint.url}</p><p className="text-xs text-stone-400">{formatDate(source.endpoint.lastCheckedAt)}{source.endpoint.statusCode ? ` · HTTP ${source.endpoint.statusCode}` : ""}{source.endpoint.latencyMs !== null ? ` · ${source.endpoint.latencyMs} ms` : ""}</p>{source.endpoint.error ? <p className="flex gap-2 rounded-xl bg-red-50 p-3 text-xs text-red-700"><AlertTriangle size={14} className="shrink-0" />{source.endpoint.error}</p> : null}</div> : <p className="mt-5 text-sm text-stone-400">Endpoint monitoring is not enabled.</p>}</section>
      <section className="rounded-2xl border border-stone-200 bg-white p-5 shadow-sm shadow-stone-200/30">
        <div className="flex items-start justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-stone-400">Features</p><h2 className="mt-1 font-display text-xl text-stone-900">User journeys</h2></div><HealthStatus status={featureIssues.length ? "issue" : healthyFeatures ? "healthy" : "waiting"} /></div>
        <div className="mt-5 grid grid-cols-3 gap-2 text-center"><MiniStat label="Healthy" value={healthyFeatures} /><MiniStat label="Open incidents" value={featureIssues.length} /><MiniStat label="Waiting" value={source.features.length - healthyFeatures - featureIssues.length} /></div>
        {featureIssues.length ? <p className="mt-4 text-xs leading-5 text-stone-500">Open incidents need developer review. A quiet 24-hour window—or a later successful attempt—does not silently close a critical incident.</p> : null}
        {featureIssues.length ? <div className="mt-4 space-y-3">{featureIssues.map((feature, index) => {
          const expanded = expandedFeature === feature.key;
          const failedResult = feature.results.find((result) => result.outcome === "failure");
          const possibleCauses = failedResult?.diagnosis.possibleCauses ?? [];
          const possibleFixes = failedResult?.diagnosis.possibleFixes.length
            ? failedResult.diagnosis.possibleFixes : [featureAction(feature)];
          return <article key={feature.key} className={`overflow-hidden rounded-xl border transition ${expanded ? "border-red-300 bg-white" : "border-red-100 bg-red-50"}`}>
            <button type="button" aria-expanded={expanded} aria-controls={`feature-incident-${index}`} onClick={() => setExpandedFeature(expanded ? null : feature.key)} className="w-full p-4 text-left">
              <div className="flex items-start justify-between gap-3"><div><p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-red-600">Action required</p><p className="mt-1 text-sm font-semibold text-stone-900">{feature.label}</p></div><ChevronDown size={16} className={`mt-1 shrink-0 text-red-500 transition-transform ${expanded ? "rotate-180" : ""}`} /></div>
              <p className="mt-2 text-xs leading-5 text-stone-700">Investigate: {possibleFixes[0]}</p>
              <p className="mt-2 text-[11px] text-stone-500">Open since {formatDate(feature.incidentStartedAt ?? feature.lastFailureAt)} · {feature.failures24h ? `${feature.failures24h} new failure${feature.failures24h === 1 ? "" : "s"} in 24h` : "No new failures in 24h"}</p>
            </button>
            {expanded ? <div id={`feature-incident-${index}`} className="border-t border-red-100 px-4 pb-4 pt-3">
              <dl className="grid gap-3 text-xs sm:grid-cols-2">
                <div><dt className="text-stone-400">Origin</dt><dd className="mt-1 font-medium text-stone-700">{source.name} · <span className="capitalize">{source.environment}</span></dd></div>
                <div><dt className="text-stone-400">Incident reason</dt><dd className="mt-1 font-medium text-stone-700">{humanizeReason(feature.lastReason)}</dd></div>
                <div><dt className="text-stone-400">Last failure</dt><dd className="mt-1 font-medium text-stone-700">{formatDate(feature.lastFailureAt)}</dd></div>
                <div><dt className="text-stone-400">Last successful attempt</dt><dd className="mt-1 font-medium text-stone-700">{feature.lastSuccessAt ? formatDate(feature.lastSuccessAt) : "None recorded"}</dd></div>
              </dl>
              {feature.successfulAttemptsSinceLastFailure > 0 ? <p className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-xs leading-5 text-emerald-800">{feature.successfulAttemptsSinceLastFailure} successful attempt{feature.successfulAttemptsSinceLastFailure === 1 ? " has" : "s have"} been recorded since the last failure. This is useful evidence, but does not close a critical incident automatically.</p> : null}
              <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50/70 p-4 text-xs leading-5 text-stone-700">
                <p className="font-semibold text-stone-900">Diagnostic guidance</p>
                <p className="mt-1 text-stone-500">NoxCue detected and explained the failure. It has not changed your application or attempted a fix.</p>
                {possibleCauses.length ? <div className="mt-3"><p className="font-medium text-stone-800">Possible causes</p><ul className="mt-1 list-disc space-y-1 pl-4">{possibleCauses.map((cause) => <li key={cause}>{cause}</li>)}</ul></div> : null}
                <div className="mt-3"><p className="font-medium text-stone-800">Possible fixes to investigate</p><ul className="mt-1 list-disc space-y-1 pl-4">{possibleFixes.map((fix) => <li key={fix}>{fix}</li>)}</ul></div>
              </div>
              <div className="mt-4"><p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-stone-400">NoxCue event history</p>
                {feature.results.length ? <div className="mt-2 space-y-2">{feature.results.map((result) => <div key={result.id} className="rounded-lg bg-stone-50 p-3 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2"><span className={`rounded-full px-2 py-0.5 text-[10px] font-medium capitalize ${result.outcome === "failure" ? "bg-red-100 text-red-700" : result.outcome === "success" ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>{result.outcome}</span><span className="text-[11px] text-stone-400">{formatDate(result.occurredAt)}</span></div>
                  <p className="mt-2 font-medium text-stone-700">{result.message ?? result.error?.message ?? humanizeReason(result.reason)}</p>
                  <div className="mt-2 flex flex-wrap gap-1.5">{[result.context.environment, result.context.runtime, result.context.release ? `release ${result.context.release}` : null, result.error?.status ? `HTTP ${result.error.status}` : null].filter(Boolean).map((value) => <span key={value} className="rounded-full bg-stone-200/70 px-2 py-1 text-[10px] text-stone-600">{value}</span>)}</div>
                  {result.error?.stack ? <pre className="mt-2 max-h-36 overflow-auto whitespace-pre-wrap break-words rounded-md bg-stone-900 p-2 font-mono text-[10px] leading-4 text-stone-200">{result.error.stack}</pre> : null}
                  {result.context.url ? <a href={result.context.url} target="_blank" rel="noreferrer" className="mt-2 inline-flex max-w-full items-center gap-1 text-[11px] text-[#b7524f] hover:text-[#93403d]"><span className="truncate">{result.context.url}</span><ExternalLink size={11} className="shrink-0" /></a> : null}
                  <p className="mt-2 break-all font-mono text-[10px] text-stone-400">{result.id}</p>
                  <p className="mt-1 text-[10px] text-stone-400">Occurred {formatDate(result.occurredAt)} · {receiptTiming(result.occurredAt, result.receivedAt)}{result.durationMs !== null ? ` · ${result.durationMs} ms` : ""}</p>
                </div>)}</div> : <p className="mt-2 text-xs text-stone-400">Detailed events are no longer retained for this incident.</p>}
              </div>
            </div> : null}
          </article>;
        })}</div> : <p className="mt-4 text-xs text-stone-400">No feature incident is currently open.</p>}
      </section>
    </div>
    <section><div className="mb-4 flex flex-wrap items-end justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#b7524f]">Errors</p><h2 className="mt-1 font-display text-2xl text-stone-900">Error incidents</h2></div><p className="text-xs text-stone-500">{activeErrors.length ? `${activeErrors.length} unresolved` : "No action required"}</p></div>{source.errors.length ? <div className="grid gap-3 sm:grid-cols-2">{source.errors.map((item, index) => {
      const itemKey = `${item.title}:${item.errorCode ?? ""}:${index}`;
      const expanded = expandedError === itemKey;
      return <article key={itemKey} className={`rounded-2xl border bg-white shadow-sm shadow-stone-200/30 transition ${expanded ? "sm:col-span-2" : ""} ${item.status === "open" ? "border-red-200" : item.status === "acknowledged" ? "border-amber-200" : "border-stone-200"}`}>
        <button type="button" aria-expanded={expanded} aria-controls={`error-log-${index}`} onClick={() => setExpandedError(expanded ? null : itemKey)} className="w-full p-4 text-left">
          <div className="flex items-start justify-between gap-3"><div><p className={`text-[10px] font-semibold uppercase tracking-[0.16em] ${item.status === "open" ? "text-red-600" : item.status === "acknowledged" ? "text-amber-600" : "text-stone-400"}`}>{item.status === "open" ? "Action required" : item.status === "acknowledged" ? "Acknowledged" : "Resolved"}</p><p className="mt-1 font-medium text-stone-800">{item.title}</p></div><span className="shrink-0 rounded-full bg-stone-100 px-2 py-1 text-xs text-stone-500">{item.occurrenceCount}×</span></div>
          <p className="mt-2 text-xs text-stone-400">{[item.component, item.errorCode].filter(Boolean).join(" · ") || "No error code"}</p>
          <div className="mt-3 flex items-center justify-between gap-3 text-[11px] text-stone-400"><span className="flex items-center gap-1.5"><Clock3 size={12} /> Last seen {formatDate(item.lastSeenAt)}</span><span className="flex items-center gap-1 text-[#b7524f]">{expanded ? "Hide logs" : item.occurrences.length ? `View ${item.occurrences.length} log${item.occurrences.length === 1 ? "" : "s"}` : "View logs"}<ChevronDown size={13} className={`transition-transform ${expanded ? "rotate-180" : ""}`} /></span></div>
        </button>
        {expanded ? <div id={`error-log-${index}`} className="border-t border-stone-200 px-4 pb-4 pt-3">
          {item.occurrences.length ? <div className="space-y-3">{item.occurrences.map((log, logIndex) => <div key={log.id} className="rounded-xl bg-stone-50 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs font-medium text-stone-700">Occurrence {item.occurrenceCount - logIndex}</p><p className="text-[11px] text-stone-400">{formatDate(log.occurredAt)}</p></div>
            {log.message ? <pre className="mt-3 whitespace-pre-wrap break-words font-sans text-xs leading-5 text-stone-700">{log.message}</pre> : <p className="mt-3 text-xs italic text-stone-400">No error message was supplied.</p>}
            <div className="mt-3 flex flex-wrap gap-2">{[log.component, log.errorCode, log.environment, log.runtime, log.release ? `release ${log.release}` : null, log.errorStatus ? `HTTP ${log.errorStatus}` : null].filter(Boolean).map((value) => <span key={value} className="rounded-full bg-stone-200/70 px-2 py-1 text-[10px] text-stone-600">{value}</span>)}{log.fatal ? <span className="rounded-full bg-red-50 px-2 py-1 text-[10px] text-red-700">Fatal</span> : null}{log.unhandled ? <span className="rounded-full bg-red-50 px-2 py-1 text-[10px] text-red-700">Unhandled</span> : null}</div>
            {log.errorStack ? <pre className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-stone-900 p-3 font-mono text-[10px] leading-4 text-stone-200">{log.errorStack}</pre> : null}
            {log.url ? <a href={log.url} target="_blank" rel="noreferrer" className="mt-3 inline-flex max-w-full items-center gap-1 text-[11px] text-[#b7524f] hover:text-[#93403d]"><span className="truncate">{log.url}</span><ExternalLink size={11} className="shrink-0" /></a> : null}
          </div>)}</div> : <p className="text-xs text-stone-400">Detailed logs were not retained for this older error group.</p>}
          {item.occurrenceCount > item.occurrences.length ? <p className="mt-3 text-[11px] text-stone-400">Showing the latest {item.occurrences.length} retained occurrence{item.occurrences.length === 1 ? "" : "s"} of {item.occurrenceCount} total.</p> : null}
        </div> : null}
      </article>;
    })}</div> : <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5 text-sm text-emerald-700"><span className="inline-flex items-center gap-2"><CheckCircle2 size={16} /> No errors have been recorded for this environment.</span></div>}</section>
    </div>}
  </div>;
}

function MiniStat({ label, value }: { label: string; value: number }) { return <div className="rounded-xl bg-stone-50 px-3 py-3"><p className="text-xl font-semibold text-stone-900">{value}</p><p className="mt-1 text-[11px] text-stone-400">{label}</p></div>; }
function HealthStatus({ status }: { status: string }) {
  const view = status === "healthy" ? ["Healthy", "text-emerald-700 bg-emerald-50"] : status === "issue" ? ["Issue", "text-red-700 bg-red-50"] : status === "off" ? ["Off", "text-stone-500 bg-stone-100"] : ["Waiting", "text-amber-700 bg-amber-50"];
  return <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${view[1]}`}>{view[0]}</span>;
}
