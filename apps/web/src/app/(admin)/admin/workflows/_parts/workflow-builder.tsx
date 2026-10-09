"use client";
// Visual workflow builder: the trigger card, optional start checks, then a vertical tree of steps with "+"
// inserts between them. If / else and approval steps open two side-by-side paths. Click a step to edit it.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, type ReactNode } from "react";
import {
  AUTOMATION_ACTION_TYPES,
  AUTOMATION_AREAS,
  AUTOMATION_OPS,
  AUTOMATION_TRIGGERS,
  WORKFLOW_EXTRA_ACTION_TYPES,
  WORKFLOW_SET_STATUS,
  WORKFLOW_STEP_KINDS,
  WORKFLOW_WAIT_UNITS,
  automationActionInfo,
  automationOpLabels,
  automationRecipientLabels,
  automationTrigger,
  workflowActionLabel,
  workflowDateFields,
  workflowExtraActionInfo,
  workflowFieldSpecs,
  workflowStepKindInfo,
  workflowStepPhrase,
  workflowSummary,
  workflowWaitUnitLabels,
  workflowWalk,
  type AutomationAction,
  type AutomationActionType,
  type AutomationArea,
  type AutomationTriggerDef,
  type AutomationTriggerKey,
  type WorkflowAction,
  type WorkflowCondition,
  type WorkflowDetail,
  type WorkflowInput,
  type WorkflowMatch,
  type WorkflowOptions,
  type WorkflowStep,
  type WorkflowStepKind,
  type WorkflowTestResult,
} from "@bmu/shared";
import { Badge, Button, Input, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { Toggle, fmtWhen } from "../../automations/_parts/kit";
import { ActionFields, Block, Connector, Field, IconBtn, Placeholders, TextArea, actionDefaults, argDefaults } from "../../automations/_parts/rule-builder";

type Draft = {
  name: string;
  description: string;
  enabled: boolean;
  trigger: AutomationTriggerKey;
  triggerArgs: Record<string, string | number>;
  start: { match: WorkflowMatch; conditions: WorkflowCondition[] };
  steps: WorkflowStep[];
};

const LEAD_ENTITIES = ["Lead", "Proposal"];
const newId = (p: string) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function initialDraft(initial?: WorkflowDetail): Draft {
  if (initial) return { name: initial.name, description: initial.description ?? "", enabled: initial.enabled, trigger: initial.trigger, triggerArgs: { ...initial.triggerArgs }, start: clone(initial.start), steps: clone(initial.steps) };
  const t = automationTrigger("lead_created")!;
  return { name: "", description: "", enabled: true, trigger: t.key, triggerArgs: argDefaults(t), start: { match: "all", conditions: [] }, steps: [{ id: newId("a"), kind: "action", action: { type: "notify", to: "owner", message: "New lead: {{record}}." } }] };
}

const toInput = (d: Draft): WorkflowInput => ({ ...d, name: d.name.trim() || automationTrigger(d.trigger)!.label, description: d.description.trim() || null });

// ---------------------------------------------------------------------------
// Tree helpers. A list is "root" or "<stepId>:<branch>" (then / else / approved / rejected).

type ListId = string;
const BRANCHES = { if: ["then", "else"], approval: ["approved", "rejected"] } as const;

function editList(steps: WorkflowStep[], list: ListId, fn: (l: WorkflowStep[]) => WorkflowStep[]): WorkflowStep[] {
  if (list === "root") return fn(steps);
  return steps.map((s) => {
    if (s.kind === "if") return { ...s, then: list === `${s.id}:then` ? fn(s.then) : editList(s.then, list, fn), else: list === `${s.id}:else` ? fn(s.else) : editList(s.else, list, fn) };
    if (s.kind === "approval") return { ...s, approved: list === `${s.id}:approved` ? fn(s.approved) : editList(s.approved, list, fn), rejected: list === `${s.id}:rejected` ? fn(s.rejected) : editList(s.rejected, list, fn) };
    return s;
  });
}

function editStep(steps: WorkflowStep[], id: string, fn: (s: WorkflowStep) => WorkflowStep | null): WorkflowStep[] {
  const out: WorkflowStep[] = [];
  for (const s of steps) {
    if (s.id === id) {
      const n = fn(s);
      if (n) out.push(n);
      continue;
    }
    if (s.kind === "if") out.push({ ...s, then: editStep(s.then, id, fn), else: editStep(s.else, id, fn) });
    else if (s.kind === "approval") out.push({ ...s, approved: editStep(s.approved, id, fn), rejected: editStep(s.rejected, id, fn) });
    else out.push(s);
  }
  return out;
}

function workflowActionDefaults(type: string, t: AutomationTriggerDef, entity: string): WorkflowAction {
  switch (type) {
    case "score_lead":
      return { type: "score_lead" };
    case "send_whatsapp":
      return { type: "send_whatsapp", to: LEAD_ENTITIES.includes(entity) ? "lead" : "client", message: "Hello from BMU Marketing about {{record}}." };
    case "set_status":
      return { type: "set_status", status: WORKFLOW_SET_STATUS[entity]?.[0]?.value ?? "" };
    case "set_custom_field":
      return { type: "set_custom_field", field: "", value: "" };
    case "reassign_open_work":
      return { type: "reassign_open_work", to: "manager" };
    default:
      return actionDefaults(type as AutomationActionType, t) as WorkflowAction;
  }
}

function stepDefaults(kind: WorkflowStepKind, t: AutomationTriggerDef, dateFields: { value: string }[], specs: { key: string }[]): WorkflowStep {
  switch (kind) {
    case "action":
      return { id: newId("a"), kind, action: workflowActionDefaults("notify", t, t.entity) };
    case "if":
      return { id: newId("i"), kind, match: "all", conditions: [{ field: specs[0]?.key ?? "", op: "equals", value: "" }], then: [], else: [] };
    case "wait":
      return { id: newId("w"), kind, amount: 1, unit: "days" };
    case "wait_until":
      return { id: newId("u"), kind, field: dateFields[0]?.value ?? "", offsetDays: 0 };
    case "approval":
      return { id: newId("p"), kind, title: "Approve the next step for {{record}}", approverRole: "founder", expiresInDays: 3, approved: [], rejected: [] };
    case "stop":
      return { id: newId("s"), kind };
  }
}

// ---------------------------------------------------------------------------

type Ctx = {
  trigger: AutomationTriggerDef;
  options: WorkflowOptions;
  readOnly: boolean;
  specs: ReturnType<typeof workflowFieldSpecs>;
  dates: { value: string; label: string }[];
  names: Record<string, string>;
  dateLabels: Record<string, string>;
  counts: Record<string, { at: number; done: number }>;
  selected: string | null;
  select: (id: string | null) => void;
  insert: (list: ListId, index: number, kind: WorkflowStepKind) => void;
  update: (id: string, s: WorkflowStep) => void;
  remove: (id: string) => void;
  move: (list: ListId, index: number, dir: -1 | 1) => void;
  recipientChoices: (allowClient: boolean) => { value: string; label: string }[];
};

export function WorkflowBuilder({ initial, options, onSaved }: { initial?: WorkflowDetail; options: WorkflowOptions; onSaved?: () => void }) {
  const router = useRouter();
  const readOnly = !options.canManage;
  const [draft, setDraft] = useState<Draft>(() => initialDraft(initial));
  const [saved, setSaved] = useState(() => JSON.stringify(initialDraft(initial)));
  const [area, setArea] = useState<AutomationArea>(() => automationTrigger(draft.trigger)!.area);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "test" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [test, setTest] = useState<WorkflowTestResult | null>(null);

  const trigger = automationTrigger(draft.trigger)!;
  const names = useMemo(() => Object.fromEntries(options.users.map((u) => [u.id, u.name])), [options.users]);
  const specs = useMemo(() => workflowFieldSpecs(draft.trigger, options.customFields), [draft.trigger, options.customFields]);
  const dates = useMemo(() => workflowDateFields(draft.trigger, options.customFields), [draft.trigger, options.customFields]);
  const dateLabels = useMemo(() => Object.fromEntries(dates.map((d) => [d.value, d.label])), [dates]);
  const dirty = JSON.stringify(draft) !== saved;
  let stepCount = 0;
  workflowWalk(draft.steps, () => stepCount++);

  const set = (patch: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setFlash(null);
  };
  const setSteps = (fn: (s: WorkflowStep[]) => WorkflowStep[]) => {
    setDraft((d) => ({ ...d, steps: fn(d.steps) }));
    setFlash(null);
  };

  const pickTrigger = (t: AutomationTriggerDef) => {
    const ok = new Set(workflowFieldSpecs(t.key, options.customFields).map((f) => f.key));
    set({ trigger: t.key, triggerArgs: argDefaults(t), start: { ...draft.start, conditions: draft.start.conditions.filter((c) => ok.has(c.field)) } });
    setTest(null);
  };

  const recipientChoices = (allowClient: boolean) => [
    ...trigger.people.map((p) => ({ value: p, label: automationRecipientLabels[p] })),
    { value: "role", label: automationRecipientLabels.role },
    { value: "users", label: automationRecipientLabels.users },
    ...(allowClient ? [{ value: "client", label: "The client's contacts" }] : []),
  ];

  const ctx: Ctx = {
    trigger,
    options,
    readOnly,
    specs,
    dates,
    names,
    dateLabels,
    counts: initial?.stepCounts ?? {},
    selected,
    select: setSelected,
    insert: (list, index, kind) => {
      const s = stepDefaults(kind, trigger, dates, specs);
      setSteps((steps) => editList(steps, list, (l) => [...l.slice(0, index), s, ...l.slice(index)]));
      setSelected(s.id);
    },
    update: (id, s) => setSteps((steps) => editStep(steps, id, () => s)),
    remove: (id) => {
      setSteps((steps) => editStep(steps, id, () => null));
      setSelected(null);
    },
    move: (list, index, dir) =>
      setSteps((steps) =>
        editList(steps, list, (l) => {
          const next = [...l];
          const [x] = next.splice(index, 1);
          next.splice(index + dir, 0, x);
          return next;
        }),
      ),
    recipientChoices,
  };

  const save = async () => {
    setBusy("save");
    setError(null);
    try {
      if (initial) {
        const r = await api.workflows.update(initial.id, toInput(draft));
        const fresh = initialDraft(r);
        setDraft(fresh);
        setSaved(JSON.stringify(fresh));
        setFlash(r.version !== initial.version ? `Saved as version ${r.version}. Runs already in progress finish on the version they started with.` : "Saved.");
        onSaved?.();
      } else {
        const r = await api.workflows.create(toInput(draft));
        router.push(`/admin/workflows/${r.id}`);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const runTest = async () => {
    setBusy("test");
    setError(null);
    try {
      setTest(await api.workflows.test(toInput(draft)));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!initial || !window.confirm(`Delete "${initial.name}"? It stops straight away and runs in progress are stopped. Its history stays in the run log.`)) return;
    setBusy("delete");
    try {
      await api.workflows.remove(initial.id);
      router.push("/admin/workflows");
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  };

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_300px]">
      <div className="min-w-0">
        <fieldset disabled={readOnly} className="min-w-0">
          <Block step="When" title="This happens">
            <div className="-mx-1 mb-4 flex flex-wrap gap-1">
              {AUTOMATION_AREAS.map((a) => (
                <button key={a} type="button" onClick={() => setArea(a)} className={`px-2.5 py-1 text-sm ${area === a ? "bg-charcoal text-ivory" : "text-ink-muted hover:text-ink"}`}>
                  {a}
                </button>
              ))}
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {AUTOMATION_TRIGGERS.filter((t) => t.area === area).map((t) => {
                const on = t.key === draft.trigger;
                return (
                  <button key={t.key} type="button" onClick={() => pickTrigger(t)} aria-pressed={on} className={`border p-3 text-left transition-colors ${on ? "border-charcoal bg-canvas/50 shadow-[inset_3px_0_0_#8BB72C]" : "border-border hover:border-ink"}`}>
                    <span className="block text-sm font-medium">
                      {t.label}
                      {t.workflowOnly && <span className="ml-2 text-[10px] uppercase tracking-[0.1em] text-ink-muted">new</span>}
                    </span>
                    <span className="mt-0.5 block text-xs leading-relaxed text-ink-muted">{t.description}</span>
                  </button>
                );
              })}
            </div>
            {trigger.area !== area && <p className="mt-3 text-xs text-ink-muted">Selected: {trigger.label} ({trigger.area})</p>}
            {trigger.args.length > 0 && (
              <div className="mt-4 flex flex-wrap gap-4 border-t border-border pt-4">
                {trigger.args.map((a) => (
                  <label key={a.key} className="text-sm">
                    <span className="mb-1 block text-xs text-ink-muted">{a.label}</span>
                    {a.type === "number" ? (
                      <span className="flex items-center gap-2">
                        <Input type="number" min={a.min} max={a.max} value={draft.triggerArgs[a.key] ?? ""} onChange={(e) => set({ triggerArgs: { ...draft.triggerArgs, [a.key]: e.target.value === "" ? "" : Number(e.target.value) } })} className="w-24" />
                        {a.unit && <span className="text-ink-muted">{a.unit}</span>}
                      </span>
                    ) : (
                      <Select value={String(draft.triggerArgs[a.key] ?? "")} onChange={(e) => set({ triggerArgs: { ...draft.triggerArgs, [a.key]: e.target.value } })}>
                        {a.dynamic === "forms" && <option value="">Any form</option>}
                        {(a.dynamic === "forms" ? options.forms : (a.options ?? [])).map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </Select>
                    )}
                  </label>
                ))}
              </div>
            )}
            <p className="mt-4 text-xs text-ink-muted">Each record goes through a workflow once. {trigger.event ? "Records from before it was switched on are left alone." : "Records already in this state when you switch it on are picked up too (up to a week back)."}</p>
          </Block>

          <Connector />

          <Block step="Only if" title="Start checks" hint="Optional.">
            <Conditions ctx={ctx} match={draft.start.match} conditions={draft.start.conditions} onChange={(match, conditions) => set({ start: { match, conditions } })} emptyText={`No checks: every ${trigger.entity.toLowerCase()} that matches above starts the workflow.`} allowEmpty />
          </Block>

          <Connector />

          <section className="border border-border bg-surface-raised">
            <header className="flex flex-wrap items-baseline gap-3 border-b border-border px-4 py-3 sm:px-5">
              <span className="bg-charcoal px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-ivory">Then</span>
              <h2 className="text-[15px] font-semibold tracking-tight">Steps</h2>
              <span className="text-xs text-ink-muted">
                {stepCount} of 60 · click a step to change it, or + to add one
              </span>
            </header>
            <div className="p-4 sm:p-5">
              <StepList ctx={ctx} list="root" steps={draft.steps} />
            </div>
          </section>
        </fieldset>
        {test && <TestPanel result={test} onClose={() => setTest(null)} />}
      </div>

      <aside className="space-y-4 self-start lg:sticky lg:top-6">
        <section className="border border-border bg-surface-raised p-4">
          <p className="text-[11px] uppercase tracking-[0.1em] text-ink-muted">In short</p>
          <p className="mt-2 text-sm leading-relaxed">{workflowSummary(draft, names)}</p>
        </section>
        <fieldset disabled={readOnly} className="space-y-4 border border-border bg-surface-raised p-4">
          <label className="block text-sm">
            <span className="mb-1 block text-xs text-ink-muted">Workflow name</span>
            <Input value={draft.name} placeholder={trigger.label} maxLength={120} onChange={(e) => set({ name: e.target.value })} />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-xs text-ink-muted">Note for the team (optional)</span>
            <textarea value={draft.description} maxLength={500} rows={2} onChange={(e) => set({ description: e.target.value })} className="w-full border border-border bg-surface-raised px-3 py-2 text-sm" />
          </label>
          <div className="flex items-center justify-between gap-3 text-sm">
            <span>
              {draft.enabled ? "Switched on" : "Switched off"}
              <span className="block text-xs text-ink-muted">{draft.enabled ? "New records start runs" : "No new runs until switched on"}</span>
            </span>
            <Toggle on={draft.enabled} label="Switch workflow on or off" onChange={readOnly ? undefined : (v) => set({ enabled: v })} />
          </div>
        </fieldset>
        {error && <p className="border border-red bg-red/10 px-3 py-2 text-sm">{error}</p>}
        {flash && !dirty && <p className="border border-green bg-green/10 px-3 py-2 text-sm">{flash}</p>}
        <div className="flex flex-col gap-2">
          {!readOnly && (
            <Button onClick={save} disabled={busy !== null || (!!initial && !dirty)}>
              {busy === "save" ? "Saving…" : initial ? (dirty ? "Save changes" : "Saved") : "Create workflow"}
            </Button>
          )}
          <Button variant="secondary" onClick={runTest} disabled={busy !== null || draft.steps.length === 0}>
            {busy === "test" ? "Checking…" : "Test against current data"}
          </Button>
          <p className="text-xs text-ink-muted">Shows which records would start this workflow right now. Nothing is sent or changed.</p>
          {initial && !readOnly && (
            <Button variant="ghost" className="mt-2 self-start px-0 text-[#b4432c] hover:text-[#b4432c]" onClick={remove} disabled={busy !== null}>
              {busy === "delete" ? "Deleting…" : "Delete workflow"}
            </Button>
          )}
        </div>
        {initial && initial.versions.length > 0 && (
          <section className="border border-border bg-surface-raised p-4">
            <p className="text-[11px] uppercase tracking-[0.1em] text-ink-muted">Versions</p>
            <ul className="mt-2 space-y-1.5 text-sm">
              {initial.versions.map((v) => (
                <li key={v.id} className="flex items-baseline justify-between gap-2">
                  <span>
                    v{v.number} {v.number === initial.version && <Badge tone="green">Live</Badge>}
                    <span className="block text-xs text-ink-muted">
                      {fmtWhen(v.createdAt)}
                      {v.createdBy ? ` · ${v.createdBy}` : ""}
                    </span>
                  </span>
                  <span className="text-xs text-ink-muted">
                    {v.runs} run{v.runs === 1 ? "" : "s"}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step tree

function StepList({ ctx, list, steps, depth = 0 }: { ctx: Ctx; list: ListId; steps: WorkflowStep[]; depth?: number }) {
  return (
    <div>
      <Insert ctx={ctx} list={list} index={0} depth={depth} />
      {steps.map((s, i) => (
        <div key={s.id}>
          <StepCard ctx={ctx} step={s} list={list} index={i} last={i === steps.length - 1} depth={depth} />
          <Insert ctx={ctx} list={list} index={i + 1} depth={depth} />
        </div>
      ))}
      {steps.length === 0 && <p className="py-1 text-center text-xs text-ink-muted">{depth === 0 ? "No steps yet." : "Nothing on this path: the workflow carries on below."}</p>}
    </div>
  );
}

function Insert({ ctx, list, index, depth }: { ctx: Ctx; list: ListId; index: number; depth: number }) {
  const [open, setOpen] = useState(false);
  if (ctx.readOnly) return <div aria-hidden className="mx-auto h-4 w-px bg-ink-muted/40" />;
  const kinds = WORKFLOW_STEP_KINDS.filter((k) => depth < 4 || (k !== "if" && k !== "approval"));
  return (
    <div className="relative flex flex-col items-center">
      <span aria-hidden className="h-2 w-px bg-ink-muted/40" />
      <button type="button" onClick={() => setOpen((v) => !v)} aria-label="Add a step here" title="Add a step here" className={`flex h-5 w-5 items-center justify-center border text-xs leading-none ${open ? "border-charcoal bg-charcoal text-ivory" : "border-border bg-surface-raised text-ink-muted hover:border-ink hover:text-ink"}`}>
        +
      </button>
      <span aria-hidden className="h-2 w-px bg-ink-muted/40" />
      {open && (
        <div className="z-10 mb-2 grid w-full max-w-md gap-px border border-border bg-border shadow-sm sm:grid-cols-2">
          {kinds.map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => {
                ctx.insert(list, index, k);
                setOpen(false);
              }}
              className="bg-surface-raised px-3 py-2 text-left hover:bg-canvas"
            >
              <span className="block text-sm font-medium">{workflowStepKindInfo[k].label}</span>
              <span className="block text-[11px] leading-snug text-ink-muted">{workflowStepKindInfo[k].description}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const kindTone: Record<WorkflowStepKind, string> = {
  action: "border-l-[#8BB72C]",
  if: "border-l-charcoal",
  wait: "border-l-amber",
  wait_until: "border-l-amber",
  approval: "border-l-[#5b7fb8]",
  stop: "border-l-[#b4432c]",
};

function StepCard({ ctx, step, list, index, last, depth }: { ctx: Ctx; step: WorkflowStep; list: ListId; index: number; last: boolean; depth: number }) {
  const open = ctx.selected === step.id;
  const count = ctx.counts[step.id];
  const kindLabel = step.kind === "action" ? workflowActionLabel(step.action.type) : workflowStepKindInfo[step.kind].label;
  const branches = step.kind === "if" || step.kind === "approval" ? BRANCHES[step.kind] : null;
  return (
    <div className={`border border-l-4 border-border ${kindTone[step.kind]} bg-surface-raised ${open ? "ring-1 ring-charcoal" : ""}`}>
      <div className="flex flex-wrap items-start justify-between gap-2 px-3 py-2">
        <button type="button" onClick={() => ctx.select(open ? null : step.id)} className="min-w-0 flex-1 text-left" aria-expanded={open}>
          <span className="block text-[11px] uppercase tracking-[0.1em] text-ink-muted">{kindLabel}</span>
          <span className="block text-sm leading-snug">{workflowStepPhrase(step, ctx.specs, ctx.names, ctx.dateLabels)}</span>
        </button>
        <span className="flex flex-wrap items-center gap-1 text-xs">
          {count && count.at > 0 && <Badge tone="amber">{count.at} here now</Badge>}
          {count && count.done > 0 && <span className="text-ink-muted">{count.done} passed</span>}
          {!ctx.readOnly && (
            <>
              <IconBtn label="Move up" disabled={index === 0} onClick={() => ctx.move(list, index, -1)}>
                ↑
              </IconBtn>
              <IconBtn label="Move down" disabled={last} onClick={() => ctx.move(list, index, 1)}>
                ↓
              </IconBtn>
              <IconBtn label="Remove step" onClick={() => (branches && !window.confirm("Remove this step and everything on its paths?") ? undefined : ctx.remove(step.id))}>
                Remove
              </IconBtn>
            </>
          )}
        </span>
      </div>
      {open && (
        <div className="space-y-3 border-t border-border bg-canvas/30 p-3">
          <StepEditor ctx={ctx} step={step} />
        </div>
      )}
      {branches && (step.kind === "if" || step.kind === "approval") && (
        // Side by side at the top level; deeper paths stack so cards stay readable.
        <div className={`grid gap-px border-t border-border bg-border ${depth === 0 ? "md:grid-cols-2" : ""}`}>
          {branches.map((b) => {
            const children = (step as Record<string, unknown>)[b] as WorkflowStep[];
            const label = b === "then" ? "Yes" : b === "else" ? "No" : b === "approved" ? "Approved" : "Rejected or no answer";
            return (
              <div key={b} className="min-w-0 bg-surface-raised p-2">
                <p className={`mb-1 inline-block px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-[0.1em] ${b === "then" || b === "approved" ? "bg-green/15 text-ink" : "bg-canvas text-ink-muted"}`}>{label}</p>
                <StepList ctx={ctx} list={`${step.id}:${b}`} steps={children} depth={depth + 1} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Editors

function StepEditor({ ctx, step }: { ctx: Ctx; step: WorkflowStep }) {
  const up = (s: WorkflowStep) => ctx.update(step.id, s);
  switch (step.kind) {
    case "action":
      return <ActionEditor ctx={ctx} action={step.action} onChange={(action) => up({ ...step, action })} />;
    case "if":
      return (
        <>
          <Conditions ctx={ctx} match={step.match} conditions={step.conditions} onChange={(match, conditions) => up({ ...step, match, conditions })} />
          <p className="text-xs text-ink-muted">“When it started” fields are as they were when the record entered the workflow. “Right now” fields are read fresh each time this step is reached.</p>
        </>
      );
    case "wait":
      return (
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Wait for">
            <Input type="number" min={1} value={step.amount} onChange={(e) => up({ ...step, amount: Math.max(1, Number(e.target.value) || 1) })} className="w-24" />
          </Field>
          <Field label="Unit">
            <Select value={step.unit} onChange={(e) => up({ ...step, unit: e.target.value as typeof step.unit })}>
              {WORKFLOW_WAIT_UNITS.map((u) => (
                <option key={u} value={u}>
                  {workflowWaitUnitLabels[u]}
                </option>
              ))}
            </Select>
          </Field>
          <p className="basis-full text-xs text-ink-muted">Working days skip Sundays and your holidays. The wait is saved, so it carries on after the server restarts.</p>
        </div>
      );
    case "wait_until":
      return (
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Date on the record">
            <Select value={step.field} onChange={(e) => up({ ...step, field: e.target.value })}>
              {!ctx.dates.some((d) => d.value === step.field) && <option value={step.field}>{step.field || "Choose…"}</option>}
              {ctx.dates.map((d) => (
                <option key={d.value} value={d.value}>
                  {d.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Days before (−) or after (+)">
            <Input type="number" min={-60} max={60} value={step.offsetDays} onChange={(e) => up({ ...step, offsetDays: Number(e.target.value) || 0 })} className="w-24" />
          </Field>
          {ctx.dates.length === 0 && <p className="basis-full text-xs text-[#b4432c]">This trigger&apos;s record has no dates to wait for. Use a plain Wait instead.</p>}
          <p className="basis-full text-xs text-ink-muted">If the date has already passed, or the record has no date, the workflow carries straight on.</p>
        </div>
      );
    case "approval": {
      const by = step.approverId ? "user" : "role";
      return (
        <>
          <Field label="What needs approving">
            <Input value={step.title} maxLength={200} onChange={(e) => up({ ...step, title: e.target.value })} />
          </Field>
          <Placeholders trigger={ctx.trigger} onPick={(p) => up({ ...step, title: `${step.title} ${p}`.trim() })} />
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Who approves">
              <Select value={by} onChange={(e) => up(e.target.value === "user" ? { ...step, approverRole: undefined, approverId: ctx.options.users[0]?.id } : { ...step, approverId: undefined, approverRole: "founder" })}>
                <option value="role">Someone with a role</option>
                <option value="user">A chosen person</option>
              </Select>
            </Field>
            {by === "role" ? (
              <Field label="Role">
                <Select value={step.approverRole ?? ""} onChange={(e) => up({ ...step, approverRole: e.target.value })}>
                  {ctx.options.roles.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : (
              <Field label="Person">
                <Select value={step.approverId ?? ""} onChange={(e) => up({ ...step, approverId: e.target.value })}>
                  {ctx.options.users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <Field label="No answer after (days)">
              <Input type="number" min={1} max={30} value={step.expiresInDays} onChange={(e) => up({ ...step, expiresInDays: Math.min(30, Math.max(1, Number(e.target.value) || 1)) })} className="w-24" />
            </Field>
          </div>
          <p className="text-xs text-ink-muted">The request shows in their Approvals. If nobody answers in time, the workflow takes the “Rejected or no answer” path.</p>
        </>
      );
    }
    case "stop":
      return (
        <Field label="Reason (shown in the run log, optional)">
          <Input value={step.reason ?? ""} maxLength={200} onChange={(e) => up({ ...step, reason: e.target.value || undefined })} />
        </Field>
      );
  }
}

function ActionEditor({ ctx, action, onChange }: { ctx: Ctx; action: WorkflowAction; onChange: (a: WorkflowAction) => void }) {
  const entity = ctx.trigger.entity;
  const leadish = LEAD_ENTITIES.includes(entity);
  const types = [
    ...AUTOMATION_ACTION_TYPES.filter((t) => !automationActionInfo[t].leadOnly || leadish),
    ...WORKFLOW_EXTRA_ACTION_TYPES.filter((t) => (t === "score_lead" ? leadish : t === "set_status" ? !!WORKFLOW_SET_STATUS[entity] : t === "reassign_open_work" ? entity === "User" : true)),
  ];
  const info = (WORKFLOW_EXTRA_ACTION_TYPES as readonly string[]).includes(action.type) ? workflowExtraActionInfo[action.type as keyof typeof workflowExtraActionInfo] : automationActionInfo[action.type as AutomationActionType];
  return (
    <>
      <Field label="Do this">
        <Select value={action.type} onChange={(e) => onChange(workflowActionDefaults(e.target.value, ctx.trigger, entity))}>
          {!types.includes(action.type as (typeof types)[number]) && <option value={action.type}>{workflowActionLabel(action.type)} (doesn&apos;t fit this trigger)</option>}
          {types.map((t) => (
            <option key={t} value={t}>
              {workflowActionLabel(t)}
            </option>
          ))}
        </Select>
      </Field>
      {info && <p className="text-xs text-ink-muted">{info.description}</p>}
      <ExtraOrAutomationFields ctx={ctx} action={action} onChange={onChange} />
    </>
  );
}

function ExtraOrAutomationFields({ ctx, action: a, onChange }: { ctx: Ctx; action: WorkflowAction; onChange: (a: WorkflowAction) => void }) {
  switch (a.type) {
    case "score_lead":
      return null;
    case "send_whatsapp":
      return (
        <>
          <Field label="To">
            <Select value={a.to} onChange={(e) => onChange({ ...a, to: e.target.value as "lead" | "client" })}>
              {LEAD_ENTITIES.includes(ctx.trigger.entity) && <option value="lead">The lead</option>}
              <option value="client">The client&apos;s main contact</option>
            </Select>
          </Field>
          <Field label="Message">
            <TextArea value={a.message} rows={3} onChange={(message) => onChange({ ...a, message })} />
          </Field>
          <Placeholders trigger={ctx.trigger} onPick={(p) => onChange({ ...a, message: `${a.message} ${p}`.trim() })} />
          <p className="border-l-2 border-amber pl-3 text-xs text-ink">
            Until WhatsApp Business is connected, messages wait in the WhatsApp queue on the{" "}
            <Link href="/admin/outbox" className="underline">
              Outbox
            </Link>{" "}
            page.
          </p>
        </>
      );
    case "set_status":
      return (
        <Field label="New status">
          <Select value={a.status} onChange={(e) => onChange({ ...a, status: e.target.value })}>
            {(WORKFLOW_SET_STATUS[ctx.trigger.entity] ?? []).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
      );
    case "set_custom_field": {
      const fields = ctx.specs.filter((s) => s.group === "Custom fields");
      const f = fields.find((x) => x.key === a.field);
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Field">
            <Select value={a.field} onChange={(e) => onChange({ ...a, field: e.target.value, value: "" })}>
              <option value="">Choose…</option>
              {fields.map((x) => (
                <option key={x.key} value={x.key}>
                  {x.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Value">
            {f?.options ? (
              <Select value={a.value} onChange={(e) => onChange({ ...a, value: e.target.value })}>
                <option value="">Empty</option>
                {f.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            ) : (
              <Input value={a.value} maxLength={500} onChange={(e) => onChange({ ...a, value: e.target.value })} />
            )}
          </Field>
          {fields.length === 0 && (
            <p className="text-xs text-ink-muted sm:col-span-2">
              No custom fields this trigger can reach yet. Add some on the{" "}
              <Link href="/admin/custom-fields" className="underline">
                Custom Fields
              </Link>{" "}
              page.
            </p>
          )}
        </div>
      );
    }
    case "reassign_open_work":
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Hand over to">
            <Select value={a.to} onChange={(e) => onChange({ ...a, to: e.target.value as typeof a.to, role: e.target.value === "role" ? "account_manager" : undefined, userId: e.target.value === "user" ? ctx.options.users[0]?.id : undefined })}>
              <option value="manager">Their manager</option>
              <option value="role">The least busy person with a role</option>
              <option value="user">A chosen person</option>
            </Select>
          </Field>
          {a.to === "role" && (
            <Field label="Role">
              <Select value={a.role ?? ""} onChange={(e) => onChange({ ...a, role: e.target.value })}>
                {ctx.options.roles.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {a.to === "user" && (
            <Field label="Person">
              <Select value={a.userId ?? ""} onChange={(e) => onChange({ ...a, userId: e.target.value })}>
                {ctx.options.users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>
      );
    default:
      return <ActionFields action={a as AutomationAction} onChange={(x) => onChange(x as WorkflowAction)} trigger={ctx.trigger} options={ctx.options} recipientChoices={ctx.recipientChoices} />;
  }
}

function Conditions({ ctx, match, conditions, onChange, emptyText, allowEmpty }: { ctx: Ctx; match: WorkflowMatch; conditions: WorkflowCondition[]; onChange: (m: WorkflowMatch, c: WorkflowCondition[]) => void; emptyText?: string; allowEmpty?: boolean }) {
  const groups = [...new Set(ctx.specs.map((s) => s.group))];
  return (
    <div>
      {conditions.length > 1 && (
        <div className="mb-3 flex items-center gap-2 text-sm">
          <span className="text-ink-muted">Pass when</span>
          <Select value={match} onChange={(e) => onChange(e.target.value as WorkflowMatch, conditions)} aria-label="All or any">
            <option value="all">all of these are true</option>
            <option value="any">any of these is true</option>
          </Select>
        </div>
      )}
      {conditions.length === 0 && emptyText && <p className="text-sm text-ink-muted">{emptyText}</p>}
      <ul className="space-y-2">
        {conditions.map((c, i) => {
          const field = ctx.specs.find((f) => f.key === c.field);
          const ops = field && (field.type === "number" || field.type === "money") ? AUTOMATION_OPS : AUTOMATION_OPS.filter((o) => o !== "greater_than" && o !== "less_than");
          const upd = (p: Partial<WorkflowCondition>) => onChange(match, conditions.map((x, k) => (k === i ? { ...x, ...p } : x)));
          return (
            <li key={i} className="grid grid-cols-1 gap-2 border border-border p-2 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,0.9fr)_minmax(0,1.1fr)_auto] sm:items-center sm:border-0 sm:p-0">
              {i > 0 && <span className="text-[11px] uppercase tracking-[0.1em] text-ink-muted sm:hidden">{match === "any" ? "or" : "and"}</span>}
              <Select aria-label="Field" value={c.field} onChange={(e) => upd({ field: e.target.value, value: "", op: "equals" })} className="w-full">
                {!field && <option value={c.field}>{c.field || "Choose…"}</option>}
                {groups.map((g) => (
                  <optgroup key={g} label={g}>
                    {ctx.specs
                      .filter((s) => s.group === g)
                      .map((f) => (
                        <option key={f.key} value={f.key}>
                          {f.label}
                        </option>
                      ))}
                  </optgroup>
                ))}
              </Select>
              <Select aria-label="Comparison" value={c.op} onChange={(e) => upd({ op: e.target.value as WorkflowCondition["op"] })} className="w-full">
                {ops.map((o) => (
                  <option key={o} value={o}>
                    {automationOpLabels[o]}
                  </option>
                ))}
              </Select>
              {c.op === "is_empty" ? (
                <span className="hidden sm:block" />
              ) : field?.options ? (
                <Select aria-label="Value" value={c.value ?? ""} onChange={(e) => upd({ value: e.target.value })} className="w-full">
                  <option value="">Choose…</option>
                  {field.options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              ) : (
                <Input aria-label="Value" type={field?.type === "text" || !field ? "text" : "number"} placeholder={field?.type === "money" ? "Amount in ₹" : field?.type === "number" ? "Number" : "Text"} value={c.value ?? ""} onChange={(e) => upd({ value: e.target.value })} className="py-1.5" />
              )}
              <button type="button" disabled={!allowEmpty && conditions.length === 1} onClick={() => onChange(match, conditions.filter((_, k) => k !== i))} className="justify-self-start px-2 py-1 text-sm text-ink-muted hover:text-ink disabled:opacity-30" aria-label="Remove check">
                Remove
              </button>
            </li>
          );
        })}
      </ul>
      {!ctx.readOnly && conditions.length < 10 && (
        <Button type="button" variant="secondary" className="mt-3 px-3 py-1.5" onClick={() => onChange(match, [...conditions, { field: ctx.specs[0]?.key ?? "", op: "equals", value: "" }])}>
          Add check
        </Button>
      )}
    </div>
  );
}

function TestPanel({ result, onClose }: { result: WorkflowTestResult; onClose: () => void }) {
  return (
    <section className="mt-8 border border-border bg-surface-raised">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <h2 className="text-[15px] font-semibold tracking-tight">Test against current data</h2>
          <p className="mt-0.5 text-sm">{result.considered === 0 ? "No records match the trigger right now." : `${result.considered} record${result.considered === 1 ? "" : "s"} match the trigger; ${result.willStart} would start now.`}</p>
          <p className="mt-1 text-xs text-ink-muted">{result.note} Nothing was sent or changed.</p>
        </div>
        <Button variant="ghost" className="px-2 py-1" onClick={onClose}>
          Close
        </Button>
      </header>
      {result.outline.length > 0 && (
        <ol className="space-y-0.5 border-b border-border px-5 py-3 text-xs text-ink">
          {result.outline.map((o, i) => (
            <li key={i}>{o}</li>
          ))}
        </ol>
      )}
      {result.matches.length > 0 && (
        <ul className="divide-y divide-border">
          {result.matches.map((m) => (
            <li key={`${m.entity}-${m.entityId}`} className="flex flex-wrap items-center gap-2 px-5 py-3">
              {m.link ? (
                <Link href={m.link} className="text-sm font-medium hover:underline">
                  {m.record}
                </Link>
              ) : (
                <span className="text-sm font-medium">{m.record}</span>
              )}
              {m.passes && !m.alreadyStarted && !m.beforeStart && <Badge tone="green">Would start now</Badge>}
              {m.alreadyStarted && <Badge>Already went through</Badge>}
              {!m.alreadyStarted && m.beforeStart && m.passes && <Badge tone="dark">Example only: from before it was switched on</Badge>}
              {!m.passes && <Badge tone="amber">Start checks not met</Badge>}
              {!m.passes && m.failedCondition && <span className="basis-full text-xs text-ink-muted">Stops at: {m.failedCondition}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function WorkflowHint({ children }: { children: ReactNode }) {
  return <p className="mb-6 border border-border bg-canvas/60 px-4 py-3 text-sm text-ink-muted">{children}</p>;
}
