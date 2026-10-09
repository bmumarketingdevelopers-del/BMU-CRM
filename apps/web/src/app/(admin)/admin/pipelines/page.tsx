"use client";

import { useState } from "react";
import { PIPELINE_KINDS, PIPELINE_LEAD_REQUIRED, pipelineDefaultLabel, pipelineKindLabels, pipelineLeadRequiredLabels, pipelineLockedStages, type PipelineConfigView, type PipelineKind, type PipelineStage, type PipelinesView } from "@bmu/shared";
import { Panel, Tabs } from "@/components/dash";
import { Badge, Button, Input, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { WithData, fmtWhen } from "../automations/_parts/kit";

export default function PipelinesPage() {
  const [kind, setKind] = useState<PipelineKind>("lead");
  const state = useLoad(() => api.pipelines.all(), { live: ["PipelineConfig", "CustomFieldDef"] });
  return (
    <>
      <PageTitle title="Pipeline Settings" subtitle="Rename, reorder or hide stages, set what must be filled in before a lead moves on, and a time target for each stage." />
      <div className="mb-6">
        <Tabs<PipelineKind> value={kind} onChange={setKind} options={PIPELINE_KINDS.map((k) => ({ value: k, label: pipelineKindLabels[k].label }))} />
      </div>
      <WithData state={state}>{(view) => <Editor key={kind} view={view} config={view.pipelines.find((p) => p.kind === kind)!} reload={state.reload} />}</WithData>
    </>
  );
}

function Editor({ view, config, reload }: { view: PipelinesView; config: PipelineConfigView; reload: () => void }) {
  const kind = config.kind;
  const [stages, setStages] = useState<PipelineStage[]>(() => config.stages.map((s) => ({ ...s, requiredFields: [...s.requiredFields] })));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const dirty = JSON.stringify(stages) !== JSON.stringify(config.stages);
  const locked = pipelineLockedStages(kind);
  const readOnly = !view.canEdit;
  const required = [...PIPELINE_LEAD_REQUIRED.map((k) => ({ key: k as string, label: pipelineLeadRequiredLabels[k] })), ...view.leadCustomFields.map((f) => ({ key: `custom.${f.key}`, label: f.label }))];

  const up = (i: number, p: Partial<PipelineStage>) => {
    setStages((s) => s.map((x, k) => (k === i ? { ...x, ...p } : x)));
    setFlash(null);
  };
  const move = (i: number, dir: -1 | 1) => {
    const next = [...stages];
    const [x] = next.splice(i, 1);
    next.splice(i + dir, 0, x);
    setStages(next);
    setFlash(null);
  };
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.pipelines.update(kind, { stages });
      setStages(r.stages);
      setFlash("Saved.");
      reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const reset = async () => {
    if (!window.confirm(`Go back to the standard ${pipelineKindLabels[kind].label.toLowerCase()}?`)) return;
    setBusy(true);
    try {
      const r = await api.pipelines.reset(kind);
      setStages(r.stages);
      reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title={pipelineKindLabels[kind].label} subtitle={pipelineKindLabels[kind].hint} flush>
      {readOnly && <p className="mx-5 mt-4 border border-border bg-canvas/60 px-3 py-2 text-sm text-ink-muted">Only the Founder and Admins can change pipelines.</p>}
      <fieldset disabled={readOnly}>
        <ol className="divide-y divide-border" data-testid="pipeline-stages">
          {stages.map((s, i) => (
            <li key={s.key} className={`grid gap-3 px-5 py-3 md:grid-cols-[2rem_minmax(0,1.2fr)_auto_auto_auto] md:items-center ${s.hidden ? "bg-canvas/40" : ""}`}>
              <span className="text-sm tabular-nums text-ink-muted">{i + 1}.</span>
              <div className="min-w-0">
                <Input aria-label={`Name for ${pipelineDefaultLabel(kind, s.key)}`} value={s.label} maxLength={40} onChange={(e) => up(i, { label: e.target.value })} />
                <p className="mt-0.5 text-[11px] text-ink-muted">
                  Standard name: {pipelineDefaultLabel(kind, s.key)}
                  {locked.includes(s.key) && " · always shown"}
                </p>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={!s.hidden} disabled={locked.includes(s.key)} onChange={(e) => up(i, { hidden: !e.target.checked })} /> Shown
              </label>
              <label className="flex items-center gap-2 text-sm">
                <span className="text-xs text-ink-muted">Target</span>
                <Input type="number" min={1} max={365} aria-label={`Target days for ${s.label}`} value={s.targetDays ?? ""} placeholder="—" onChange={(e) => up(i, { targetDays: e.target.value ? Math.min(365, Math.max(1, Number(e.target.value))) : null })} className="w-20" />
                <span className="text-xs text-ink-muted">days</span>
              </label>
              <span className="flex gap-1 text-xs">
                <button type="button" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up" className="border border-border px-2 py-0.5 text-ink-muted hover:text-ink disabled:opacity-30">
                  ↑
                </button>
                <button type="button" disabled={i === stages.length - 1} onClick={() => move(i, 1)} aria-label="Move down" className="border border-border px-2 py-0.5 text-ink-muted hover:text-ink disabled:opacity-30">
                  ↓
                </button>
              </span>
              {kind === "lead" && s.key !== "new" && s.key !== "lost" && (
                <div className="md:col-span-4 md:col-start-2">
                  <p className="text-xs text-ink-muted">Must be filled in before a lead moves here:</p>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {required.map((r) => {
                      const on = s.requiredFields.includes(r.key);
                      return (
                        <button key={r.key} type="button" aria-pressed={on} onClick={() => up(i, { requiredFields: on ? s.requiredFields.filter((x) => x !== r.key) : [...s.requiredFields, r.key] })} className={`border px-2 py-0.5 text-xs ${on ? "border-charcoal bg-charcoal text-ivory" : "border-border text-ink-muted hover:border-ink hover:text-ink"}`}>
                          {r.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </li>
          ))}
        </ol>
      </fieldset>
      <div className="flex flex-wrap items-center gap-3 border-t border-border px-5 py-4">
        {!readOnly && (
          <Button onClick={save} disabled={busy || !dirty}>
            {busy ? "Saving…" : dirty ? "Save changes" : "Saved"}
          </Button>
        )}
        {!readOnly && config.customised && (
          <Button variant="ghost" onClick={reset} disabled={busy}>
            Back to standard
          </Button>
        )}
        {config.customised ? (
          <span className="text-xs text-ink-muted">
            Changed {fmtWhen(config.updatedAt)}
            {config.updatedBy ? ` by ${config.updatedBy}` : ""}
          </span>
        ) : (
          <Badge>Standard</Badge>
        )}
        {error && <p className="basis-full border border-red bg-red/10 px-3 py-2 text-sm">{error}</p>}
        {flash && !dirty && <p className="basis-full border border-green bg-green/10 px-3 py-2 text-sm">{flash}</p>}
        <p className="basis-full text-xs text-ink-muted">Renaming never breaks anything: reports, filters and workflows keep working because the stage underneath stays the same.</p>
      </div>
    </Panel>
  );
}
