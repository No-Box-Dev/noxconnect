import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Cpu, Loader2, RefreshCw } from "lucide-react";
import { fetchLlmSettings, setAiMode, type AiMode } from "@/lib/llm-settings";

const AI_MODES: AiMode[] = ["managed", "disabled"];

export function LlmSettingsSection() {
  const queryClient = useQueryClient();
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["llm-settings"],
    queryFn: fetchLlmSettings,
    staleTime: 30_000,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function changeMode(mode: AiMode) {
    setBusy(true);
    setError(null);
    try {
      await setAiMode(mode);
      await queryClient.invalidateQueries({ queryKey: ["llm-settings"] });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 rounded-xl border border-stone-200 bg-white p-5">
      <div className="flex items-center gap-2">
        <Cpu size={14} className="text-stone-500" />
        <h2 className="text-sm font-semibold text-stone-900">AI service</h2>
        <button
          type="button"
          onClick={() => refetch()}
          className="ml-auto inline-flex cursor-pointer items-center gap-1 text-xs text-stone-500 hover:text-stone-700"
        >
          <RefreshCw size={12} /> Refresh
        </button>
      </div>

      <p className="text-xs text-stone-400">
        Nox securely provides managed AI for NoxFeed generation and NoxConnect matching. Clients do not need an API account or key.
      </p>

      {isLoading ? (
        <p className="inline-flex items-center gap-2 text-xs text-stone-400">
          <Loader2 size={12} className="animate-spin" /> Loading…
        </p>
      ) : isError ? (
        <p className="text-xs text-red-500">Failed to load AI settings.</p>
      ) : data ? (
        <>
          <div className="grid grid-cols-2 gap-2">
            {AI_MODES.map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => changeMode(mode)}
                disabled={busy || data.mode === mode}
                className={`rounded-lg border px-3 py-2 text-xs font-medium capitalize disabled:opacity-50 ${
                  data.mode === mode
                    ? "border-accent bg-accent/10 text-accent"
                    : "border-stone-200 text-stone-600 hover:border-stone-300"
                }`}
              >
                {mode}
              </button>
            ))}
          </div>
          <p className="text-xs text-stone-500">
            {data.mode === "disabled"
              ? "AI is disabled for this organization."
              : `${data.managed.available ? "Ready" : "Unavailable"} · ${data.managed.provider} · ${data.managed.model}`}
          </p>
          <div className="space-y-1 rounded-lg bg-stone-50 px-3 py-2 text-xs text-stone-500">
            <p>
              NoxFeed generation · {data.managed.services.noxfeed.available ? "Ready" : "Unavailable"}
            </p>
            <p>
              NoxConnect matching · {data.managed.services.noxconnect.available ? "Ready" : "Unavailable"}
            </p>
          </div>
          {error ? <p className="text-xs text-red-500">{error}</p> : null}
        </>
      ) : null}
    </div>
  );
}
