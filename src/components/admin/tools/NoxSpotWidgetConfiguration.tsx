import { useState } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useUpdateNoxSpotSite } from "@/hooks/useNoxSpot";
import type { NoxSpotBlock, NoxSpotEnvironment, NoxSpotSite } from "@/lib/types";
import { DEFAULT_NOXSPOT_BLOCKS } from "../../../../shared/noxspot-defaults";


const BLOCK_TYPES: Array<{ value: NoxSpotBlock["type"]; label: string }> = [
  { value: "title", label: "Title" },
  { value: "description", label: "Description" },
  { value: "reporter", label: "Reporter" },
  { value: "contact_email", label: "Contact email" },
  { value: "custom_text", label: "Custom text" },
  { value: "custom_textarea", label: "Custom long text" },
  { value: "custom_select", label: "Custom select" },
  { value: "element_picker", label: "Selected elements" },
  { value: "metadata", label: "Browser metadata" },
  { value: "console_logs", label: "Console logs" },
];

const REQUIRED_FIELD_TYPES = new Set<NoxSpotBlock["type"]>([
  "description", "reporter", "contact_email", "custom_text", "custom_textarea", "custom_select",
]);

function copyEnvironments(value: NoxSpotEnvironment[]): NoxSpotEnvironment[] {
  return value.map((environment) => ({ ...environment }));
}

function copyBlocks(value: readonly NoxSpotBlock[]): NoxSpotBlock[] {
  return value.map((block) => ({ ...block, options: block.options ? [...block.options] : undefined, environments: block.environments ? [...block.environments] : [] }));
}

function move<T>(items: T[], index: number, direction: -1 | 1): T[] {
  const nextIndex = index + direction;
  if (nextIndex < 0 || nextIndex >= items.length) return items;
  const next = [...items];
  [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
  return next;
}

function newBlockId(): string {
  return `block-${crypto.randomUUID()}`;
}

export function NoxSpotWidgetConfiguration({ site }: { site: NoxSpotSite }) {
  return <NoxSpotWidgetConfigurationEditor key={`${site.id}:${site.updatedAt}`} site={site} />;
}

function NoxSpotWidgetConfigurationEditor({ site }: { site: NoxSpotSite }) {
  const update = useUpdateNoxSpotSite();
  const [environments, setEnvironments] = useState(() => copyEnvironments(site.environments));
  const [blocks, setBlocks] = useState(() => copyBlocks(site.blocks));

  const renameEnvironment = (index: number, name: string) => {
    const oldName = environments[index]?.name;
    setEnvironments((current) => current.map((environment, currentIndex) => currentIndex === index ? { ...environment, name } : environment));
    if (oldName) {
      setBlocks((current) => current.map((block) => ({
        ...block,
        environments: (block.environments ?? []).map((environment) => environment === oldName ? name : environment),
      })));
    }
  };

  const removeEnvironment = (index: number) => {
    const removedName = environments[index]?.name;
    setEnvironments((current) => current.filter((_, currentIndex) => currentIndex !== index));
    if (removedName) {
      setBlocks((current) => current.map((block) => ({
        ...block,
        environments: (block.environments ?? []).filter((environment) => environment !== removedName),
      })));
    }
  };

  const formIsValid = blocks.length === 0 || blocks.filter((block) => block.type === "title").length === 1;
  const environmentsValid = environments.every((environment) => environment.name.trim() && environment.url.trim()) &&
    new Set(environments.map((environment) => environment.name.trim().toLowerCase())).size === environments.length;
  const selectsValid = blocks.every((block) => block.type !== "custom_select" || (block.options?.length ?? 0) > 0);

  return (
    <details className="mt-3 rounded-lg border border-stone-200 p-3">
      <summary className="cursor-pointer text-xs font-medium text-stone-600">Environments and report form</summary>
      <div className="mt-4 space-y-6">
        <section className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h4 className="text-xs font-semibold text-stone-700">Allowed environments</h4>
              <p className="mt-1 text-xs text-stone-400">When configured, only these origins can load or submit the widget.</p>
            </div>
            <button
              type="button"
              onClick={() => setEnvironments((current) => [...current, { name: `Environment ${current.length + 1}`, url: "", enabled: true }])}
              className="inline-flex items-center gap-1 rounded-lg border border-stone-200 px-2 py-1.5 text-xs text-stone-600 hover:bg-stone-50"
            >
              <Plus size={12} /> Add
            </button>
          </div>

          {environments.length === 0 ? (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">Compatibility mode: all origins are currently accepted.</p>
          ) : environments.map((environment, index) => (
            <div key={index} className="grid gap-2 rounded-lg bg-stone-50 p-3 sm:grid-cols-2">
              <label className="text-xs text-stone-500">Name
                <input value={environment.name} maxLength={60} onChange={(event) => renameEnvironment(index, event.target.value)} className="mt-1 w-full rounded-md border border-stone-200 bg-white px-2 py-1.5 text-xs" />
              </label>
              <label className="text-xs text-stone-500">Origin or hostname
                <input value={environment.url} maxLength={500} placeholder="app.example.com" onChange={(event) => setEnvironments((current) => current.map((item, currentIndex) => currentIndex === index ? { ...item, url: event.target.value } : item))} className="mt-1 w-full rounded-md border border-stone-200 bg-white px-2 py-1.5 text-xs" />
              </label>
              <label className="text-xs text-stone-500">Button text override
                <input value={environment.buttonText ?? ""} maxLength={40} placeholder={site.buttonText} onChange={(event) => setEnvironments((current) => current.map((item, currentIndex) => currentIndex === index ? { ...item, buttonText: event.target.value || null } : item))} className="mt-1 w-full rounded-md border border-stone-200 bg-white px-2 py-1.5 text-xs" />
              </label>
              <label className="text-xs text-stone-500">Reporter experience
                <select value={environment.widgetMode ?? ""} onChange={(event) => setEnvironments((current) => current.map((item, currentIndex) => currentIndex === index ? { ...item, widgetMode: (event.target.value || null) as NoxSpotEnvironment["widgetMode"] } : item))} className="mt-1 w-full rounded-md border border-stone-200 bg-white px-2 py-1.5 text-xs">
                  <option value="">Use site default</option>
                  <option value="development">Development</option>
                  <option value="release">Release</option>
                </select>
              </label>
              <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
                <label className="inline-flex items-center gap-2 text-xs text-stone-600">
                  <input type="checkbox" checked={environment.enabled !== false} onChange={(event) => setEnvironments((current) => current.map((item, currentIndex) => currentIndex === index ? { ...item, enabled: event.target.checked } : item))} /> Enabled
                </label>
                <label className="inline-flex items-center gap-2 text-xs text-stone-600">
                  Color override
                  <input type="color" value={environment.buttonColor || site.buttonColor} onChange={(event) => setEnvironments((current) => current.map((item, currentIndex) => currentIndex === index ? { ...item, buttonColor: event.target.value } : item))} className="h-7 w-10 rounded border border-stone-200 p-0.5" />
                </label>
                <button type="button" onClick={() => setEnvironments((current) => move(current, index, -1))} disabled={index === 0} className="ml-auto rounded p-1 text-stone-400 hover:bg-white disabled:opacity-30" title="Move environment up"><ArrowUp size={13} /></button>
                <button type="button" onClick={() => setEnvironments((current) => move(current, index, 1))} disabled={index === environments.length - 1} className="rounded p-1 text-stone-400 hover:bg-white disabled:opacity-30" title="Move environment down"><ArrowDown size={13} /></button>
                <button type="button" onClick={() => removeEnvironment(index)} className="rounded p-1 text-stone-400 hover:bg-red-50 hover:text-red-600" title="Remove environment"><Trash2 size={13} /></button>
              </div>
            </div>
          ))}
        </section>

        <section className="space-y-3 border-t border-stone-100 pt-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h4 className="text-xs font-semibold text-stone-700">Report form</h4>
              <p className="mt-1 text-xs text-stone-400">An empty configuration uses the widget's safe default form.</p>
            </div>
            <div className="flex gap-2">
              {blocks.length === 0 ? (
                <button type="button" onClick={() => setBlocks(copyBlocks(DEFAULT_NOXSPOT_BLOCKS))} className="rounded-lg border border-stone-200 px-2 py-1.5 text-xs text-stone-600 hover:bg-stone-50">Customize defaults</button>
              ) : null}
              <button type="button" onClick={() => setBlocks((current) => [...current, { id: newBlockId(), type: "custom_text", label: "Question", required: false, environments: [] }])} className="inline-flex items-center gap-1 rounded-lg border border-stone-200 px-2 py-1.5 text-xs text-stone-600 hover:bg-stone-50"><Plus size={12} /> Add block</button>
            </div>
          </div>

          {blocks.map((block, index) => (
            <div key={block.id} className="space-y-2 rounded-lg bg-stone-50 p-3">
              <div className="grid gap-2 sm:grid-cols-[minmax(140px,1fr)_minmax(160px,1.5fr)_auto]">
                <select value={block.type} onChange={(event) => setBlocks((current) => current.map((item, currentIndex) => currentIndex === index ? { ...item, type: event.target.value as NoxSpotBlock["type"], options: event.target.value === "custom_select" ? (item.options?.length ? item.options : ["Option 1"]) : undefined } : item))} className="rounded-md border border-stone-200 bg-white px-2 py-1.5 text-xs">
                  {BLOCK_TYPES.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
                </select>
                <input value={block.label ?? ""} maxLength={120} placeholder="Default label" onChange={(event) => setBlocks((current) => current.map((item, currentIndex) => currentIndex === index ? { ...item, label: event.target.value || null } : item))} className="rounded-md border border-stone-200 bg-white px-2 py-1.5 text-xs" />
                <div className="flex items-center gap-1">
                  <button type="button" onClick={() => setBlocks((current) => move(current, index, -1))} disabled={index === 0} className="rounded p-1 text-stone-400 hover:bg-white disabled:opacity-30" title="Move block up"><ArrowUp size={13} /></button>
                  <button type="button" onClick={() => setBlocks((current) => move(current, index, 1))} disabled={index === blocks.length - 1} className="rounded p-1 text-stone-400 hover:bg-white disabled:opacity-30" title="Move block down"><ArrowDown size={13} /></button>
                  <button type="button" onClick={() => setBlocks((current) => current.filter((_, currentIndex) => currentIndex !== index))} className="rounded p-1 text-stone-400 hover:bg-red-50 hover:text-red-600" title="Remove block"><Trash2 size={13} /></button>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                {REQUIRED_FIELD_TYPES.has(block.type) ? (
                  <label className="inline-flex items-center gap-2 text-xs text-stone-600"><input type="checkbox" checked={block.required === true} onChange={(event) => setBlocks((current) => current.map((item, currentIndex) => currentIndex === index ? { ...item, required: event.target.checked } : item))} /> Required</label>
                ) : null}
                {environments.map((environment) => (
                  <label key={environment.name} className="inline-flex items-center gap-1 text-xs text-stone-500">
                    <input type="checkbox" checked={(block.environments ?? []).includes(environment.name)} onChange={(event) => setBlocks((current) => current.map((item, currentIndex) => {
                      if (currentIndex !== index) return item;
                      const scoped = new Set(item.environments ?? []);
                      if (event.target.checked) scoped.add(environment.name); else scoped.delete(environment.name);
                      return { ...item, environments: [...scoped] };
                    }))} /> {environment.name || "Unnamed"}
                  </label>
                ))}
                {environments.length > 0 && (block.environments?.length ?? 0) === 0 ? <span className="text-[11px] text-stone-400">Shown in all environments</span> : null}
              </div>
              {block.type === "custom_select" ? (
                <label className="block text-xs text-stone-500">Options (one per line)
                  <textarea value={(block.options ?? []).join("\n")} rows={3} onChange={(event) => setBlocks((current) => current.map((item, currentIndex) => currentIndex === index ? { ...item, options: event.target.value.split("\n").map((option) => option.trim()).filter(Boolean) } : item))} className="mt-1 w-full rounded-md border border-stone-200 bg-white px-2 py-1.5 text-xs" />
                </label>
              ) : null}
            </div>
          ))}
          {!formIsValid ? <p className="text-xs text-red-600">A custom form must contain exactly one title block.</p> : null}
          {!environmentsValid ? <p className="text-xs text-red-600">Environment names and origins are required and names must be unique.</p> : null}
          {!selectsValid ? <p className="text-xs text-red-600">Every select block needs at least one option.</p> : null}
        </section>

        <button
          type="button"
          disabled={update.isPending || !formIsValid || !environmentsValid || !selectsValid}
          onClick={() => update.mutate({ id: site.id, environments, blocks })}
          className="w-full rounded-lg bg-stone-900 px-3 py-2 text-xs font-medium text-white disabled:opacity-50"
        >
          {update.isPending ? "Saving…" : "Save environments and form"}
        </button>
      </div>
    </details>
  );
}
