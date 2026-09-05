import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, KeyRound, RotateCw, Trash2 } from "lucide-react";
import { apiDelete, apiGet, apiPost } from "@/lib/api";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

type Environment = "live" | "test";
type ApiTokenMetadata = {
  id: string;
  name: string;
  environment: Environment;
  projectId: string;
  projectName: string | null;
  prefix: string;
  scopes: string[];
  createdBy: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

type SecretResponse = {
  token: string;
  credential: { id: string; prefix: string };
  warning: string;
};

type Project = { id: string; name: string; routing_enabled: number; archived: number };

const SERVICE_SCOPES = ["noxfeed", "noxspot", "noxcue"] as const;

export function ApiTokensSection() {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [environment, setEnvironment] = useState<Environment>("live");
  const [projectId, setProjectId] = useState("");
  const [expiresInDays, setExpiresInDays] = useState(90);
  const [scopes, setScopes] = useState<string[]>(["services:read"]);
  const [newSecret, setNewSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pendingAction, setPendingAction] = useState<{ type: "rotate" | "revoke"; token: ApiTokenMetadata } | null>(null);

  const tokens = useQuery({
    queryKey: ["api-tokens"],
    queryFn: () => apiGet<{ tokens: ApiTokenMetadata[] }>("/api/v1/api-tokens"),
  });
  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: () => apiGet<{ projects: Project[] }>("/api/projects"),
  });
  const availableProjects = useMemo(
    () => projects.data?.projects.filter((project) => project.routing_enabled === 1 && project.archived !== 1) ?? [],
    [projects.data],
  );
  const selectedProjectId = projectId || availableProjects[0]?.id || "";
  const activeTokens = useMemo(() => tokens.data?.tokens.filter((token) => !token.revokedAt) ?? [], [tokens.data]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["api-tokens"] });
  const createToken = useMutation({
    mutationFn: () => apiPost<SecretResponse>("/api/v1/api-tokens", { name, environment, projectId: selectedProjectId, scopes, expiresInDays }),
    onSuccess: (result) => {
      setNewSecret(result.token);
      setCopied(false);
      setName("");
      void refresh();
    },
  });
  const rotateToken = useMutation({
    mutationFn: (id: string) => apiPost<SecretResponse>(`/api/v1/api-tokens/${id}/rotate`),
    onSuccess: (result) => {
      setNewSecret(result.token);
      setCopied(false);
      void refresh();
    },
  });
  const revokeToken = useMutation({
    mutationFn: (id: string) => apiDelete(`/api/v1/api-tokens/${id}`),
    onSuccess: () => { void refresh(); },
  });

  function setServiceAccess(service: string, access: "none" | "read" | "write") {
    setScopes((current) => {
      const next = current.filter((scope) => !scope.startsWith(`${service}:`));
      return access === "none" ? next : [...next, `${service}:${access}`];
    });
  }

  async function copySecret() {
    if (!newSecret) return;
    await navigator.clipboard.writeText(newSecret);
    setCopied(true);
  }

  function confirmAction() {
    if (!pendingAction) return;
    if (pendingAction.type === "rotate") rotateToken.mutate(pendingAction.token.id);
    else revokeToken.mutate(pendingAction.token.id);
    setPendingAction(null);
  }

  return (
    <div className="space-y-5">
      {newSecret ? (
        <section className="rounded-xl border border-amber-300 bg-amber-50 p-5">
          <h3 className="text-sm font-semibold text-amber-950">Copy this token now</h3>
          <p className="mt-1 text-xs leading-5 text-amber-800">It is shown once and cannot be recovered. Store it in the automation runtime's secret manager.</p>
          <div className="mt-3 flex items-center gap-2">
            <code className="min-w-0 flex-1 overflow-x-auto rounded-lg border border-amber-200 bg-white px-3 py-2 text-xs text-stone-800">{newSecret}</code>
            <button type="button" onClick={() => void copySecret()} className="inline-flex items-center gap-1.5 rounded-lg bg-stone-900 px-3 py-2 text-xs font-medium text-white">
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}{copied ? "Copied" : "Copy"}
            </button>
          </div>
          <button type="button" onClick={() => setNewSecret(null)} className="mt-3 text-xs font-medium text-amber-900 underline">I have stored it securely</button>
        </section>
      ) : null}

      <section className="rounded-xl border border-stone-200 bg-white p-5">
        <div className="flex items-start gap-3">
          <KeyRound className="mt-0.5 h-5 w-5 text-stone-500" />
          <div><h3 className="text-sm font-semibold text-stone-900">Create automation token</h3><p className="mt-1 text-xs text-stone-500">One project, a fixed expiry, and only the service access selected below.</p></div>
        </div>
        <label className="mt-3 block text-xs font-medium text-stone-700">Project<select value={selectedProjectId} onChange={(event) => setProjectId(event.target.value)} disabled={projects.isLoading || availableProjects.length === 0} className="mt-1 w-full rounded-lg border border-stone-300 px-3 py-2 text-sm font-normal"><option value="" disabled>{projects.isLoading ? "Loading projects…" : availableProjects.length === 0 ? "Enable a project first" : "Choose a project"}</option>{availableProjects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <label className="text-xs font-medium text-stone-700">Name<input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} placeholder="CI production" className="mt-1 w-full rounded-lg border border-stone-300 px-3 py-2 text-sm font-normal" /></label>
          <label className="text-xs font-medium text-stone-700">Environment<select value={environment} onChange={(event) => setEnvironment(event.target.value as Environment)} className="mt-1 w-full rounded-lg border border-stone-300 px-3 py-2 text-sm font-normal"><option value="live">Live</option><option value="test">Test</option></select></label>
          <label className="text-xs font-medium text-stone-700">Expires<select value={expiresInDays} onChange={(event) => setExpiresInDays(Number(event.target.value))} className="mt-1 w-full rounded-lg border border-stone-300 px-3 py-2 text-sm font-normal"><option value={30}>30 days</option><option value={90}>90 days</option><option value={180}>180 days</option><option value={365}>1 year</option></select></label>
        </div>
        <div className="mt-4 overflow-hidden rounded-lg border border-stone-200">
          <div className="grid grid-cols-[1fr_9rem] bg-stone-50 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-stone-500"><span>Scope</span><span>Access</span></div>
          <label className="grid grid-cols-[1fr_9rem] items-center border-t border-stone-100 px-3 py-2 text-sm"><span>Service discovery</span><select value={scopes.includes("services:read") ? "read" : "none"} onChange={(event) => setScopes((current) => event.target.value === "read" ? [...new Set([...current, "services:read"])] : current.filter((scope) => scope !== "services:read"))} className="rounded-md border border-stone-300 px-2 py-1 text-xs"><option value="none">None</option><option value="read">Read</option></select></label>
          {SERVICE_SCOPES.map((service) => {
            const access = scopes.includes(`${service}:write`) ? "write" : scopes.includes(`${service}:read`) ? "read" : "none";
            return <label key={service} className="grid grid-cols-[1fr_9rem] items-center border-t border-stone-100 px-3 py-2 text-sm"><span className="capitalize">{service}</span><select value={access} onChange={(event) => setServiceAccess(service, event.target.value as "none" | "read" | "write")} className="rounded-md border border-stone-300 px-2 py-1 text-xs"><option value="none">None</option><option value="read">Read</option><option value="write">Read + write</option></select></label>;
          })}
        </div>
        <button type="button" disabled={!name.trim() || !selectedProjectId || scopes.length === 0 || createToken.isPending} onClick={() => createToken.mutate()} className="mt-4 rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40">{createToken.isPending ? "Creating…" : "Create token"}</button>
        {createToken.isError ? <p className="mt-2 text-xs text-red-700">{createToken.error.message}</p> : null}
      </section>

      <section className="rounded-xl border border-stone-200 bg-white p-5">
        <h3 className="text-sm font-semibold text-stone-900">Active tokens</h3>
        <p className="mt-1 text-xs text-stone-500">Only prefixes and metadata remain visible after creation.</p>
        <div className="mt-4 divide-y divide-stone-100">
          {tokens.isLoading ? <p className="py-3 text-xs text-stone-500">Loading tokens…</p> : null}
          {tokens.isError ? <p className="py-3 text-xs text-red-700">Could not load API tokens.</p> : null}
          {!tokens.isLoading && activeTokens.length === 0 ? <p className="py-3 text-xs text-stone-500">No active automation tokens.</p> : null}
          {activeTokens.map((token) => <div key={token.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
            <div><div className="flex items-center gap-2"><strong className="text-sm text-stone-800">{token.name}</strong><span className="rounded bg-stone-100 px-1.5 py-0.5 text-[10px] uppercase text-stone-500">{token.environment}</span></div><code className="mt-1 block text-[11px] text-stone-500">{token.prefix}…</code><p className="mt-1 text-[11px] text-stone-500">Project: {token.projectName ?? token.projectId}</p><p className="mt-1 text-[11px] text-stone-400">Expires {token.expiresAt ? new Date(token.expiresAt).toLocaleDateString() : "never"} · {token.scopes.join(", ")}</p></div>
            <div className="flex gap-2"><button type="button" disabled={rotateToken.isPending} onClick={() => setPendingAction({ type: "rotate", token })} className="inline-flex items-center gap-1 rounded-md border border-stone-300 px-2 py-1.5 text-xs text-stone-700"><RotateCw className="h-3.5 w-3.5" />Rotate</button><button type="button" disabled={revokeToken.isPending} onClick={() => setPendingAction({ type: "revoke", token })} className="inline-flex items-center gap-1 rounded-md border border-red-200 px-2 py-1.5 text-xs text-red-700"><Trash2 className="h-3.5 w-3.5" />Revoke</button></div>
          </div>)}
        </div>
      </section>
      <ConfirmDialog
        open={pendingAction !== null}
        title={pendingAction?.type === "rotate" ? `Rotate ${pendingAction.token.name}?` : `Revoke ${pendingAction?.token.name ?? "token"}?`}
        message={pendingAction?.type === "rotate" ? "The current token will stop working immediately. You must copy and deploy the replacement secret." : "This token will stop working immediately. This cannot be undone."}
        confirmLabel={pendingAction?.type === "rotate" ? "Rotate token" : "Revoke token"}
        variant={pendingAction?.type === "revoke" ? "danger" : "default"}
        onConfirm={confirmAction}
        onCancel={() => setPendingAction(null)}
      />
    </div>
  );
}
