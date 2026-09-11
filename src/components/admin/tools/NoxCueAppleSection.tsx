import { useState } from "react";
import { BarChart3, RefreshCw, Trash2 } from "lucide-react";
import { Spinner } from "@/components/Spinner";
import { ConfirmDialog, useConfirm } from "@/components/ui/ConfirmDialog";
import {
  useConnectNoxCueApple,
  useDisconnectNoxCueApple,
  useNoxCueAppleConnection,
  useSyncNoxCueApple,
} from "@/hooks/useNoxCue";
import type { NoxCueSource } from "@/lib/noxcue-api";

export function NoxCueAppleSection({ source }: { source: NoxCueSource }) {
  const connection = useNoxCueAppleConnection(source.id, source.environment === "production");
  const connect = useConnectNoxCueApple(source.id);
  const sync = useSyncNoxCueApple(source.id);
  const disconnect = useDisconnectNoxCueApple(source.id);
  const { confirm, dialogProps } = useConfirm();
  const [appId, setAppId] = useState("");
  const [issuerId, setIssuerId] = useState("");
  const [keyId, setKeyId] = useState("");
  const [privateKey, setPrivateKey] = useState("");

  if (source.environment !== "production") return null;
  const saved = connection.data?.connected;
  const status = connection.data?.status;
  const remove = async () => {
    if (await confirm({
      title: "Disconnect App Store Connect?",
      message: "NoxCue will stop importing new Apple reports. Existing daily statistics remain stored.",
      confirmLabel: "Disconnect",
      variant: "danger",
    })) disconnect.mutate();
  };

  return <>
    <section className="space-y-4 rounded-xl border border-stone-200 bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2"><BarChart3 size={16} /><h3 className="text-sm font-semibold text-stone-900">App Store Connect analytics</h3></div>
          <p className="mt-1 max-w-3xl text-xs leading-5 text-stone-500">Import downloads, installations, deletions, sessions, and crashes into this production source. Usage and crash reports include only opted-in devices and remain separate from NoxCue user counts.</p>
        </div>
        {saved ? <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${status === "active" ? "bg-green-100 text-green-700" : status === "error" ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-700"}`}>{status === "active" ? "Connected" : status === "error" ? "Needs attention" : "Waiting for reports"}</span> : null}
      </div>

      {connection.isLoading ? <Spinner className="h-4 w-4 text-accent" /> : saved ? <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-3">
          <Summary label="Apple app ID" value={connection.data?.appId ?? "—"} />
          <Summary label="API key" value={connection.data?.keyId ?? "—"} />
          <Summary label="Latest data" value={connection.data?.lastSuccessfulPeriod ?? "Waiting"} />
        </div>
        {status === "waiting_for_reports" ? <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">Apple usually takes one to two days to generate the first ongoing reports. NoxCue checks automatically every six hours.</p> : null}
        {connection.data?.lastError ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">{connection.data.lastError}</p> : null}
        <div className="flex flex-wrap items-center gap-3 border-t border-stone-100 pt-3">
          <button type="button" onClick={() => sync.mutate()} disabled={sync.isPending} className="inline-flex items-center gap-1.5 rounded-lg border border-stone-200 px-3 py-2 text-xs font-medium text-stone-700 disabled:opacity-50">{sync.isPending ? <Spinner size="sm" /> : <RefreshCw size={13} />} Sync now</button>
          <button type="button" onClick={() => void remove()} disabled={disconnect.isPending} className="inline-flex items-center gap-1.5 px-2 py-2 text-xs text-red-600 disabled:opacity-50"><Trash2 size={13} /> Disconnect</button>
          {connection.data?.lastSyncedAt ? <span className="text-xs text-stone-400">Checked {new Date(connection.data.lastSyncedAt).toLocaleString()}</span> : null}
        </div>
        {sync.isSuccess ? <p role="status" className="text-xs text-green-700">Apple reports checked. {sync.data.processed} new report batch{sync.data.processed === 1 ? "" : "es"} processed.</p> : null}
        {sync.isError || disconnect.isError ? <p role="alert" className="text-xs text-red-600">{(sync.error ?? disconnect.error) instanceof Error ? (sync.error ?? disconnect.error)?.message : "The Apple connection could not be updated."}</p> : null}
      </div> : <form className="space-y-4" onSubmit={(event) => {
        event.preventDefault();
        connect.mutate({ appId, issuerId, keyId, privateKey }, { onSuccess: () => setPrivateKey("") });
      }}>
        <div className="grid gap-4 sm:grid-cols-3">
          <label className="text-xs font-medium text-stone-700">Apple app ID<input required inputMode="numeric" value={appId} onChange={(event) => setAppId(event.target.value)} placeholder="1476097583" className="mt-1 block w-full rounded-lg border border-stone-200 px-3 py-2 text-sm" /></label>
          <label className="text-xs font-medium text-stone-700">Issuer ID<input required value={issuerId} onChange={(event) => setIssuerId(event.target.value)} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" className="mt-1 block w-full rounded-lg border border-stone-200 px-3 py-2 text-sm" /></label>
          <label className="text-xs font-medium text-stone-700">Key ID<input required value={keyId} onChange={(event) => setKeyId(event.target.value)} placeholder="ABC123DEFG" className="mt-1 block w-full rounded-lg border border-stone-200 px-3 py-2 text-sm" /></label>
        </div>
        <label className="block text-xs font-medium text-stone-700">Private key (.p8)
          <input required type="file" accept=".p8,application/pkcs8" onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void file.text().then(setPrivateKey);
          }} className="mt-1 block w-full rounded-lg border border-stone-200 px-3 py-2 text-xs file:mr-3 file:rounded file:border-0 file:bg-stone-100 file:px-2 file:py-1 file:text-xs" />
          <span className="mt-1 block font-normal leading-4 text-stone-400">The key is encrypted before storage and is never returned to the browser. Use an Admin key for the first connection so NoxCue can create the ongoing report request.</span>
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <button disabled={connect.isPending || !privateKey} className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{connect.isPending ? "Connecting…" : "Connect Apple analytics"}</button>
          <a href="https://appstoreconnect.apple.com/access/integrations/api" target="_blank" rel="noreferrer" className="text-xs font-medium text-accent hover:underline">Open App Store Connect API keys</a>
        </div>
        {connect.isError ? <p role="alert" className="text-xs text-red-600">{connect.error instanceof Error ? connect.error.message : "Could not connect App Store Connect."}</p> : null}
      </form>}
      {connection.isError ? <p role="alert" className="text-xs text-red-600">Could not load the Apple analytics connection.</p> : null}
    </section>
    <ConfirmDialog {...dialogProps} />
  </>;
}

function Summary({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg border border-stone-100 bg-stone-50 p-3"><p className="text-[10px] font-semibold uppercase tracking-wide text-stone-400">{label}</p><p className="mt-1 truncate text-sm font-medium text-stone-800">{value}</p></div>;
}
