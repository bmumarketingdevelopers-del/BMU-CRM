"use client";

import { useState } from "react";
import { CUSTOM_FIELD_ENTITIES, CUSTOM_FIELD_TYPES, customFieldEntityLabels, customFieldTypeLabels, type CustomFieldDefView, type CustomFieldEntity, type CustomFieldType } from "@bmu/shared";
import { Panel, Tabs } from "@/components/dash";
import { Badge, Button, Input, PageTitle, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { WithData } from "../automations/_parts/kit";

const where: Record<CustomFieldEntity, string> = {
  lead: "Shown on each lead page, filterable on the lead board, and fillable from forms.",
  client: "Shown on each client page.",
  engagement: "Shown on each project page.",
  request: "Shown on each client request.",
  creator: "Shown on each creator profile.",
};

export default function CustomFieldsPage() {
  const [entity, setEntity] = useState<CustomFieldEntity>("lead");
  const [archived, setArchived] = useState(false);
  const state = useLoad(() => api.customFields.list(undefined, true));
  return (
    <>
      <PageTitle title="Custom Fields" subtitle="Add your own fields to leads, clients, projects, requests and creators. Workflows, dashboards and filters can all use them." />
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <Tabs<CustomFieldEntity> value={entity} onChange={setEntity} options={CUSTOM_FIELD_ENTITIES.map((e) => ({ value: e, label: customFieldEntityLabels[e].many }))} />
        <label className="flex items-center gap-2 text-sm text-ink-muted">
          <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> Show archived
        </label>
      </div>
      <WithData state={state}>{(rows) => <EntityFields key={entity} entity={entity} rows={rows.filter((r) => r.entity === entity && (archived || !r.archived))} reload={state.reload} />}</WithData>
    </>
  );
}

function EntityFields({ entity, rows, reload }: { entity: CustomFieldEntity; rows: CustomFieldDefView[]; reload: () => void }) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const move = async (i: number, dir: -1 | 1) => {
    const live = rows.filter((r) => !r.archived);
    const a = live[i];
    const b = live[i + dir];
    if (!a || !b) return;
    try {
      await Promise.all([api.customFields.update(a.id, { position: b.position }), api.customFields.update(b.id, { position: a.position === b.position ? a.position + dir : a.position })]);
      reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const live = rows.filter((r) => !r.archived);
  return (
    <Panel
      title={`${customFieldEntityLabels[entity].one} fields`}
      subtitle={where[entity]}
      flush
      action={
        !adding && (
          <Button variant="secondary" className="px-3 py-1.5" onClick={() => setAdding(true)}>
            Add field
          </Button>
        )
      }
    >
      {error && <p className="mx-5 mt-4 border border-red bg-red/10 px-3 py-2 text-sm">{error}</p>}
      {adding && (
        <div className="border-b border-border p-5">
          <FieldForm
            entity={entity}
            onCancel={() => setAdding(false)}
            onSaved={() => {
              setAdding(false);
              reload();
            }}
          />
        </div>
      )}
      {rows.length === 0 && !adding && <p className="px-5 py-8 text-center text-sm text-ink-muted">No custom fields on {customFieldEntityLabels[entity].many.toLowerCase()} yet.</p>}
      <ul className="divide-y divide-border">
        {rows.map((f) => {
          const i = live.indexOf(f);
          return (
            <li key={f.id} className="px-5 py-3">
              {editing === f.id ? (
                <FieldForm
                  entity={entity}
                  initial={f}
                  onCancel={() => setEditing(null)}
                  onSaved={() => {
                    setEditing(null);
                    reload();
                  }}
                />
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">
                      {f.label} {f.required && <span className="text-xs text-ink-muted">(required)</span>} {f.archived && <Badge>Archived</Badge>}
                    </p>
                    <p className="text-xs text-ink-muted">
                      {customFieldTypeLabels[f.type]}
                      {f.type === "select" ? `: ${f.options.join(", ")}` : ""} · key <code className="font-mono">{f.key}</code> · filled on {f.used} record{f.used === 1 ? "" : "s"}
                    </p>
                    {f.helpText && <p className="mt-0.5 text-xs text-ink-muted">{f.helpText}</p>}
                  </div>
                  <span className="flex gap-1 text-xs">
                    {!f.archived && (
                      <>
                        <button type="button" disabled={i <= 0} onClick={() => move(i, -1)} aria-label="Move up" className="border border-border px-2 py-0.5 text-ink-muted hover:text-ink disabled:opacity-30">
                          ↑
                        </button>
                        <button type="button" disabled={i === live.length - 1} onClick={() => move(i, 1)} aria-label="Move down" className="border border-border px-2 py-0.5 text-ink-muted hover:text-ink disabled:opacity-30">
                          ↓
                        </button>
                      </>
                    )}
                    <Button variant="ghost" className="px-2 py-0.5" onClick={() => setEditing(f.id)}>
                      Edit
                    </Button>
                  </span>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

function FieldForm({ entity, initial, onCancel, onSaved }: { entity: CustomFieldEntity; initial?: CustomFieldDefView; onCancel: () => void; onSaved: () => void }) {
  const [label, setLabel] = useState(initial?.label ?? "");
  const [type, setType] = useState<CustomFieldType>(initial?.type ?? "text");
  const [options, setOptions] = useState((initial?.options ?? []).join("\n"));
  const [required, setRequired] = useState(initial?.required ?? false);
  const [helpText, setHelpText] = useState(initial?.helpText ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const opts = options
    .split("\n")
    .map((o) => o.trim())
    .filter(Boolean);

  const save = async (archived?: boolean) => {
    setBusy(true);
    setError(null);
    try {
      if (initial) await api.customFields.update(initial.id, archived === undefined ? { label, options: type === "select" ? opts : undefined, required, helpText: helpText || null } : { archived });
      else await api.customFields.create({ entity, label, type, options: type === "select" ? opts : [], required, helpText: helpText || null });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="mb-1 block text-xs text-ink-muted">Field name</span>
          <Input value={label} maxLength={60} placeholder="e.g. Industry" onChange={(e) => setLabel(e.target.value)} autoFocus />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-xs text-ink-muted">Type {initial && "(can't change after creating)"}</span>
          <Select value={type} disabled={!!initial} onChange={(e) => setType(e.target.value as CustomFieldType)} className="w-full">
            {CUSTOM_FIELD_TYPES.map((t) => (
              <option key={t} value={t}>
                {customFieldTypeLabels[t]}
              </option>
            ))}
          </Select>
        </label>
      </div>
      {type === "select" && (
        <label className="block text-sm">
          <span className="mb-1 block text-xs text-ink-muted">Choices, one per line</span>
          <textarea value={options} rows={4} onChange={(e) => setOptions(e.target.value)} className="w-full border border-border bg-surface-raised px-3 py-2 text-sm" placeholder={"Retail\nHealthcare\nEducation"} />
        </label>
      )}
      <label className="block text-sm">
        <span className="mb-1 block text-xs text-ink-muted">Help text (optional)</span>
        <Input value={helpText} maxLength={200} onChange={(e) => setHelpText(e.target.value)} />
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} /> Required when someone fills in the fields
      </label>
      {error && <p className="border border-red bg-red/10 px-3 py-2 text-sm">{error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => save()} disabled={busy}>
          {busy ? "Saving…" : initial ? "Save" : "Add field"}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        {initial && (
          <Button variant="ghost" className="ml-auto text-ink-muted" onClick={() => save(!initial.archived)} disabled={busy}>
            {initial.archived ? "Bring back" : "Archive"}
          </Button>
        )}
      </div>
      {initial?.archived === false && <p className="text-xs text-ink-muted">Archiving hides the field everywhere. Values already filled in are kept and come back if you bring it back.</p>}
    </div>
  );
}
