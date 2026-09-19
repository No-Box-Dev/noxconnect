import { useState } from "react";
import { Mail, RotateCcw, Send } from "lucide-react";
import { Spinner } from "@/components/Spinner";
import {
  useNoxSpotResolutionTemplate,
  usePreviewNoxSpotResolutionTemplate,
  useSaveNoxSpotResolutionTemplate,
  useTestNoxSpotResolutionTemplate,
} from "@/hooks/useNoxSpot";
import type { NoxSpotResolutionPreview, NoxSpotResolutionTemplate } from "@/lib/types";

const fieldClass = "mt-1 w-full rounded-lg border border-stone-200 bg-white px-2.5 py-2 text-xs text-stone-800";

export function NoxSpotResolutionEmailTemplate({ siteId }: { siteId: string }) {
  const templateQuery = useNoxSpotResolutionTemplate(siteId);
  const save = useSaveNoxSpotResolutionTemplate(siteId);
  const preview = usePreviewNoxSpotResolutionTemplate(siteId);
  const test = useTestNoxSpotResolutionTemplate(siteId);
  const [draftOverride, setDraftOverride] = useState<NoxSpotResolutionTemplate | null>(null);
  const [testRecipient, setTestRecipient] = useState("");

  const document = templateQuery.data;
  const draft = draftOverride ?? document?.template;
  const update = <K extends keyof NoxSpotResolutionTemplate>(key: K, value: NoxSpotResolutionTemplate[K]) => {
    if (!draft) return;
    setDraftOverride({ ...draft, [key]: value });
  };
  const error = save.error || preview.error || test.error;

  return (
    <details className="mt-3 rounded-lg border border-stone-200 p-3">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-xs font-medium text-stone-600">
        <Mail size={14} /> Resolution email
        {document ? (
          <span className="rounded-full bg-stone-100 px-2 py-0.5 text-[10px] font-normal text-stone-500">
            {document.usingDefault ? "Default" : "Custom"}
          </span>
        ) : null}
      </summary>
      <div className="mt-3 border-t border-stone-100 pt-3">
        <p className="text-xs leading-5 text-stone-500">
          NoxConnect safely renders this message and Postmark delivers it. The verified sender, fix evidence, AI safety rules, and reopen workflow cannot be changed here.
        </p>
        {templateQuery.isLoading || !draft || !document ? (
          <div className="flex items-center gap-2 py-5 text-xs text-stone-400"><Spinner size="sm" /> Loading template…</div>
        ) : (
          <>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <label className="text-xs font-medium text-stone-500">Tone
                <select value={draft.tone} onChange={(event) => update("tone", event.target.value as NoxSpotResolutionTemplate["tone"])} className={fieldClass}>
                  <option value="default">Warm and direct</option>
                  <option value="warm">Warm and reassuring</option>
                  <option value="formal">Professional and formal</option>
                  <option value="concise">As concise as possible</option>
                </select>
              </label>
              <label className="text-xs font-medium text-stone-500">Reply-to email
                <input type="email" value={draft.replyTo ?? ""} onChange={(event) => update("replyTo", event.target.value.trim() || null)} placeholder="support@example.com" className={fieldClass} />
              </label>
              <label className="text-xs font-medium text-stone-500 sm:col-span-2">Subject
                <input value={draft.subject} onChange={(event) => update("subject", event.target.value)} maxLength={200} required className={fieldClass} />
              </label>
              <label className="text-xs font-medium text-stone-500 sm:col-span-2">Opening acknowledgement
                <textarea value={draft.acknowledgement} onChange={(event) => update("acknowledgement", event.target.value)} maxLength={500} required rows={2} className={fieldClass} />
              </label>
              <label className="text-xs font-medium text-stone-500 sm:col-span-2">Reopen explanation
                <textarea value={draft.reopenText} onChange={(event) => update("reopenText", event.target.value)} maxLength={500} required rows={2} className={fieldClass} />
              </label>
              <label className="text-xs font-medium text-stone-500">Button label
                <input value={draft.buttonLabel} onChange={(event) => update("buttonLabel", event.target.value)} maxLength={60} required className={fieldClass} />
              </label>
              <label className="text-xs font-medium text-stone-500">Final thank-you
                <input value={draft.closing} onChange={(event) => update("closing", event.target.value)} maxLength={500} required className={fieldClass} />
              </label>
            </div>
            <p className="mt-2 text-[11px] text-stone-400">Available variables: <code>{"{{report_title}}"}</code> and <code>{"{{site_name}}"}</code>.</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={save.isPending}
                onClick={() => save.mutate({ template: draft, revision: document.revision }, { onSuccess: () => setDraftOverride(null) })}
                className="rounded-lg bg-stone-900 px-3 py-2 text-xs font-medium text-white disabled:opacity-50"
              >{save.isPending ? "Saving…" : "Save template"}</button>
              <button
                type="button"
                disabled={preview.isPending}
                onClick={() => preview.mutate(draft)}
                className="rounded-lg border border-stone-200 px-3 py-2 text-xs font-medium text-stone-600 disabled:opacity-50"
              >{preview.isPending ? "Preparing…" : "Preview"}</button>
              <button
                type="button"
                disabled={save.isPending}
                onClick={() => save.mutate({ template: null, revision: document.revision }, { onSuccess: () => setDraftOverride(null) })}
                className="inline-flex items-center gap-1 rounded-lg border border-stone-200 px-3 py-2 text-xs font-medium text-stone-500 disabled:opacity-50"
              ><RotateCcw size={12} /> Reset to default</button>
            </div>
            <div className="mt-4 flex flex-col gap-2 rounded-lg bg-stone-50 p-3 sm:flex-row sm:items-end">
              <label className="min-w-0 flex-1 text-xs font-medium text-stone-500">Send a test through Postmark
                <input type="email" value={testRecipient} onChange={(event) => setTestRecipient(event.target.value)} placeholder="you@example.com" className={fieldClass} />
              </label>
              <button
                type="button"
                disabled={test.isPending || !testRecipient.trim()}
                onClick={() => test.mutate({ recipient: testRecipient.trim(), template: draft })}
                className="inline-flex h-9 items-center justify-center gap-1 rounded-lg bg-accent px-3 text-xs font-medium text-white disabled:opacity-50"
              >{test.isPending ? <Spinner size="sm" /> : <Send size={12} />} {test.isSuccess ? "Sent" : "Send test"}</button>
            </div>
            {error ? <p className="mt-2 text-xs text-red-600">{error instanceof Error ? error.message : "Template request failed"}</p> : null}
            {preview.data ? <EmailPreview preview={preview.data.preview} /> : null}
          </>
        )}
      </div>
    </details>
  );
}

function EmailPreview({ preview }: { preview: NoxSpotResolutionPreview }) {
  return (
    <div className="mt-4 overflow-hidden rounded-lg border border-stone-200 bg-white">
      <div className="border-b border-stone-100 bg-stone-50 px-4 py-2 text-[11px] text-stone-500">
        <span className="font-medium text-stone-700">Subject:</span> {preview.subject}
        {preview.replyTo ? <span className="ml-3"><span className="font-medium text-stone-700">Reply-to:</span> {preview.replyTo}</span> : null}
      </div>
      <div className="space-y-3 p-4 text-xs leading-5 text-stone-700">
        <p>{preview.greeting}</p>
        <p>{preview.acknowledgement}</p>
        {preview.summary.split(/\n\s*\n/).map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
        <p>{preview.reopenText}</p>
        <span className="inline-block rounded-lg bg-stone-900 px-3 py-2 font-medium text-white">{preview.buttonLabel}</span>
        <p>{preview.closing}</p>
      </div>
    </div>
  );
}
