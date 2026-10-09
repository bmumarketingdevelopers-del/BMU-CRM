"use client";
// v14: the org's custom fields on a record page (lead, client, project, request, creator). Hidden when the org has
// no fields for that record type. People who can change the record fill them in here.
import { useEffect, useState } from "react";
import { customFieldDisplay, workflowRunStatusLabels, type CustomFieldDefView, type CustomFieldEntity, type CustomFieldRecordView, type CustomFieldValue, type WorkflowRunRow } from "@bmu/shared";
import { Panel } from "@/components/dash";
import { Badge, Button, Input, Select } from "@/components/ui";
import { api } from "@/lib/api";

export function CustomFieldsPanel({ entity, id, className = "" }: { entity: CustomFieldEntity; id: string; className?: string }) {
  const [view, setView] = useState<CustomFieldRecordView | null>(null);
  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState<Record<string, CustomFieldValue>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.customFields
      .values(entity, id)
      .then((v) => live && setView(v))
      .catch(() => live && setView(null));
    return () => {
      live = false;
    };
  }, [entity, id]);

  if (!view || view.fields.length === 0) return null;

  const start = () => {
    setValues({ ...view.values });
    setEditing(true);
    setError(null);
  };
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      setView(await api.customFields.setValues(entity, id, values));
      setEditing(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel
      title="More details"
      subtitle="Your organisation's own fields"
      className={className}
      action={
        view.canEdit && !editing ? (
          <Button variant="ghost" className="px-2 py-1" onClick={start}>
            Edit
          </Button>
        ) : undefined
      }
    >
      {editing ? (
        <div className="space-y-3" data-testid="custom-fields-form">
          {view.fields.map((f) => (
            <label key={f.key} className="block text-sm">
              <span className="mb-1 block text-xs text-ink-muted">
                {f.label}
                {f.required && <span className="text-red"> *</span>}
              </span>
              <ValueInput def={f} value={values[f.key] ?? null} onChange={(v) => setValues((s) => ({ ...s, [f.key]: v }))} />
              {f.helpText && <span className="mt-0.5 block text-xs text-ink-muted">{f.helpText}</span>}
            </label>
          ))}
          {error && <p className="border border-red bg-red/10 px-3 py-2 text-sm">{error}</p>}
          <div className="flex gap-2">
            <Button onClick={save} disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </Button>
            <Button variant="ghost" onClick={() => setEditing(false)} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <dl className="grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-3 gap-y-2 text-sm" data-testid="custom-fields">
          {view.fields.map((f) => (
            <div key={f.key} className="contents">
              <dt className="text-ink-muted">{f.label}</dt>
              <dd className="min-w-0 break-words">{customFieldDisplay(f, view.values[f.key])}</dd>
            </div>
          ))}
        </dl>
      )}
    </Panel>
  );
}

function ValueInput({ def, value, onChange }: { def: CustomFieldDefView; value: CustomFieldValue; onChange: (v: CustomFieldValue) => void }) {
  switch (def.type) {
    case "long_text":
      return <textarea value={value == null ? "" : String(value)} rows={3} onChange={(e) => onChange(e.target.value)} className="w-full border border-border bg-surface-raised px-3 py-2 text-sm" />;
    case "number":
    case "money":
      return <Input type="number" step={def.type === "money" ? "0.01" : "any"} value={value == null ? "" : String(value)} onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))} />;
    case "date":
      return <Input type="date" value={value == null ? "" : String(value)} onChange={(e) => onChange(e.target.value || null)} />;
    case "select":
      return (
        <Select value={value == null ? "" : String(value)} onChange={(e) => onChange(e.target.value || null)} className="w-full">
          <option value="">—</option>
          {def.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </Select>
      );
    case "checkbox":
      return (
        <Select value={value === true ? "yes" : value === false ? "no" : ""} onChange={(e) => onChange(e.target.value === "" ? null : e.target.value === "yes")} className="w-full">
          <option value="">—</option>
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </Select>
      );
    default:
      return <Input value={value == null ? "" : String(value)} maxLength={200} onChange={(e) => onChange(e.target.value)} />;
  }
}

/** Workflows this record is going through (or went through). Hidden when there are none. */
export function RecordWorkflows({ entity, id, className = "" }: { entity: string; id: string; className?: string }) {
  const [rows, setRows] = useState<WorkflowRunRow[] | null>(null);
  useEffect(() => {
    let live = true;
    api.workflows
      .forRecord(entity, id)
      .then((r) => live && setRows(r))
      .catch(() => live && setRows(null));
    return () => {
      live = false;
    };
  }, [entity, id]);
  if (!rows?.length) return null;
  return (
    <Panel title="Workflows" subtitle="Follow-ups running on this record" className={className}>
      <ul className="space-y-2 text-sm">
        {rows.slice(0, 6).map((r) => (
          <li key={r.id}>
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{r.workflowName}</span>
              <Badge tone={r.status === "done" ? "green" : r.status === "failed" ? "red" : r.status === "cancelled" ? "neutral" : "amber"}>{workflowRunStatusLabels[r.status]}</Badge>
            </span>
            <span className="block text-xs text-ink-muted">{r.where}</span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
