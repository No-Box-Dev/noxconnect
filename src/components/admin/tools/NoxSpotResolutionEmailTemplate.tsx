import { useState } from "react";
import { Mail, RotateCcw, Send } from "lucide-react";
import { Spinner } from "@/components/Spinner";
import {
  useNoxSpotResolutionTemplate,
  usePreviewNoxSpotResolutionTemplate,
  useSaveNoxSpotResolutionTemplate,
  useTestNoxSpotResolutionTemplate,
} from "@/hooks/useNoxSpot";
import type { NoxSpotResolutionAppearance, NoxSpotResolutionPreview, NoxSpotResolutionTemplate } from "@/lib/types";

const fieldClass = "mt-1 w-full rounded-lg border border-stone-200 bg-white px-2.5 py-2 text-xs text-stone-800";
const fontOptions = [
  { value: "system", label: "Clean sans serif" },
  { value: "playnist", label: "Playnist display + sans" },
  { value: "humanist", label: "Friendly humanist" },
  { value: "editorial", label: "Editorial serif" },
  { value: "mono", label: "Monospace" },
] as const;

const previewFonts = {
  system: { heading: "Arial, Helvetica, sans-serif", body: "Arial, Helvetica, sans-serif" },
  playnist: { heading: '"HF Gesco Bold", Georgia, serif', body: '"IBM Plex Sans Variable", Arial, sans-serif' },
  humanist: { heading: '"Trebuchet MS", Arial, sans-serif', body: '"Trebuchet MS", Arial, sans-serif' },
  editorial: { heading: 'Georgia, "Times New Roman", serif', body: 'Georgia, "Times New Roman", serif' },
  mono: { heading: '"Courier New", monospace', body: '"Courier New", monospace' },
} as const;

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
  const updateAppearance = <K extends keyof NoxSpotResolutionAppearance>(key: K, value: NoxSpotResolutionAppearance[K]) => {
    if (!draft) return;
    setDraftOverride({ ...draft, appearance: { ...draft.appearance, [key]: value } });
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
              <label className="text-xs font-medium text-stone-500">Sender name
                <input value={draft.senderName} onChange={(event) => update("senderName", event.target.value)} maxLength={80} required className={fieldClass} />
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
            <fieldset className="mt-4 rounded-lg border border-stone-200 p-3">
              <legend className="px-1 text-xs font-semibold text-stone-700">Brand appearance</legend>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="text-xs font-medium text-stone-500">Font style
                  <select value={draft.appearance.fontPreset} onChange={(event) => updateAppearance("fontPreset", event.target.value as NoxSpotResolutionAppearance["fontPreset"])} className={fieldClass}>
                    {fontOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                </label>
                <div className="hidden sm:block" />
                <ColorField label="Brand / button" value={draft.appearance.accentColor} onChange={(value) => updateAppearance("accentColor", value)} />
                <ColorField label="Email background" value={draft.appearance.backgroundColor} onChange={(value) => updateAppearance("backgroundColor", value)} />
                <ColorField label="Card background" value={draft.appearance.surfaceColor} onChange={(value) => updateAppearance("surfaceColor", value)} />
                <ColorField label="Main text" value={draft.appearance.textColor} onChange={(value) => updateAppearance("textColor", value)} />
                <ColorField label="Muted text" value={draft.appearance.mutedColor} onChange={(value) => updateAppearance("mutedColor", value)} />
              </div>
              <p className="mt-2 text-[11px] leading-4 text-stone-400">Email clients may substitute their nearest installed font. Every option includes reliable fallbacks.</p>
            </fieldset>
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
  const fonts = previewFonts[preview.appearance.fontPreset];
  return (
    <div className="mt-4 overflow-hidden rounded-lg border border-stone-200" style={{ background: preview.appearance.backgroundColor, fontFamily: fonts.body }}>
      <div className="border-b border-stone-100 bg-stone-50 px-4 py-2 text-[11px] text-stone-500">
        <span className="font-medium text-stone-700">Subject:</span> {preview.subject}
        {preview.replyTo ? <span className="ml-3"><span className="font-medium text-stone-700">Reply-to:</span> {preview.replyTo}</span> : null}
      </div>
      <div className="m-4 space-y-3 rounded-lg border-2 p-4 text-xs leading-5" style={{ background: preview.appearance.surfaceColor, borderColor: preview.appearance.textColor, boxShadow: `4px 4px 0 ${preview.appearance.accentColor}`, color: preview.appearance.textColor }}>
        <p className="text-base font-bold" style={{ color: preview.appearance.accentColor, fontFamily: fonts.heading }}>{preview.siteName} <span className="text-xs font-normal" style={{ color: preview.appearance.mutedColor, fontFamily: fonts.body }}>via NoxSpot</span></p>
        <p>{preview.greeting}</p>
        <p>{preview.acknowledgement}</p>
        {preview.summary.split(/\n\s*\n/).map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
        <p>{preview.reopenText}</p>
        <span className="inline-block rounded-lg px-3 py-2 font-medium" style={{ background: preview.appearance.accentColor, color: contrastingTextColor(preview.appearance.accentColor) }}>{preview.buttonLabel}</span>
        <p>{preview.closing}</p>
      </div>
    </div>
  );
}

function contrastingTextColor(hex: string) {
  const [red, green, blue] = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16));
  return (red * 299 + green * 587 + blue * 114) / 1000 >= 150 ? "#000000" : "#FFFFFF";
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="text-xs font-medium text-stone-500">{label}
      <span className="mt-1 flex items-center gap-2">
        <input type="color" value={value} onChange={(event) => onChange(event.target.value.toUpperCase())} className="h-9 w-11 cursor-pointer rounded border border-stone-200 bg-white p-1" />
        <input value={value} onChange={(event) => onChange(event.target.value.toUpperCase())} pattern="^#[0-9A-Fa-f]{6}$" maxLength={7} className="min-w-0 flex-1 rounded-lg border border-stone-200 bg-white px-2.5 py-2 font-mono text-xs text-stone-800" />
      </span>
    </label>
  );
}
