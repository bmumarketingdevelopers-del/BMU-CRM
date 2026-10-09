"use client";
// Visual rule builder: WHEN → IF → THEN as three connected blocks, with a live sentence preview and a
// "test against current data" dry run.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, type ReactNode } from "react";
import {
  AUTOMATION_ACTION_TYPES,
  AUTOMATION_AI_DRAFT_KINDS,
  AUTOMATION_AREAS,
  AUTOMATION_OPS,
  AUTOMATION_TRIGGERS,
  LEAD_STAGES,
  automationActionInfo,
  automationAiDraftLabels,
  automationOpLabels,
  automationRecipientLabels,
  automationSentence,
  automationTaskAssigneeLabels,
  automationTrigger,
  leadStageLabels,
  type AutomationAction,
  type AutomationActionType,
  type AutomationArea,
  type AutomationCondition,
  type AutomationOptions,
  type AutomationRuleDetail,
  type AutomationRuleInput,
  type AutomationTestResult,
  type AutomationTriggerDef,
  type AutomationTriggerKey,
} from "@bmu/shared";
import { Badge, Button, Input, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { Toggle } from "./kit";

type Draft = {
  name: string;
  description: string;
  enabled: boolean;
  trigger: AutomationTriggerKey;
  triggerArgs: Record<string, string | number>;
  conditions: AutomationCondition[];
  actions: AutomationAction[];
};

export const argDefaults = (t: AutomationTriggerDef) => Object.fromEntries(t.args.filter((a) => a.default !== undefined).map((a) => [a.key, a.default!]));

export const actionDefaults = (type: AutomationActionType, t: AutomationTriggerDef): AutomationAction => {
  const person = (t.people[0] ?? "am") as "am";
  switch (type) {
    case "notify":
      return { type, to: person, message: "{{record}} needs your attention." };
    case "create_task":
      return { type, title: "Follow up: {{record}}", assignTo: t.people.includes("am") ? "am" : t.people.includes("owner") ? "owner" : "role", role: t.people.includes("am") || t.people.includes("owner") ? undefined : "admin", dueInDays: 1 };
    case "assign_lead_owner":
      return { type };
    case "change_lead_stage":
      return { type, stage: "contacted" };
    case "post_internal_note":
      return { type, message: "{{record}}: flagged automatically, please check." };
    case "send_client_reminder":
      return { type, message: "Hello! A gentle note from the BMU team about {{record}}. Please let us know if you need anything from us." };
    case "email":
      return { type, to: person, subject: "{{record}}", message: "Hello,\n\n{{record}} needs attention.\n\nBMU Hub" };
    case "webhook":
      return { type, url: "https://" };
    case "ai_draft":
      return { type, draft: "client_message", to: person, instruction: "" };
  }
};

const PEOPLE = ["am", "owner", "assignee", "manager", "department_head"];

/** Keeps an action valid for a newly picked trigger: people the record does not have become a role. */
function fitAction(a: AutomationAction, t: AutomationTriggerDef, freshDefault: boolean): AutomationAction {
  if (freshDefault) return actionDefaults(a.type, t);
  if ((a.type === "notify" || a.type === "email" || a.type === "ai_draft") && PEOPLE.includes(a.to) && !t.people.includes(a.to as never)) {
    return t.people[0] ? { ...a, to: t.people[0] } : { ...a, to: "role", role: "admin" };
  }
  if (a.type === "create_task" && PEOPLE.includes(a.assignTo) && !t.people.includes(a.assignTo as never)) {
    const p = (["am", "owner", "assignee"] as const).find((x) => t.people.includes(x));
    return p ? { ...a, assignTo: p } : { ...a, assignTo: "role", role: "admin" };
  }
  return a;
}

function initialDraft(initial?: AutomationRuleDetail): Draft {
  if (initial) {
    return { name: initial.name, description: initial.description ?? "", enabled: initial.enabled, trigger: initial.trigger, triggerArgs: { ...initial.triggerArgs }, conditions: initial.conditions.map((c) => ({ ...c })), actions: initial.actions.map((a) => ({ ...a })) };
  }
  const t = automationTrigger("invoice_overdue")!;
  return { name: "", description: "", enabled: true, trigger: t.key, triggerArgs: argDefaults(t), conditions: [], actions: [{ type: "notify", to: "am", message: "{{client}} is {{days}} days late on invoice {{invoice}} ({{balance}} owed)." }] };
}

const toInput = (d: Draft): AutomationRuleInput => ({ ...d, name: d.name.trim() || automationTrigger(d.trigger)!.label, description: d.description.trim() || null });

export function RuleBuilder({ initial, options, onSaved }: { initial?: AutomationRuleDetail; options: AutomationOptions; onSaved?: () => void }) {
  const router = useRouter();
  const readOnly = !options.canManage;
  const [draft, setDraft] = useState<Draft>(() => initialDraft(initial));
  const [saved, setSaved] = useState(() => JSON.stringify(initialDraft(initial)));
  const [area, setArea] = useState<AutomationArea>(() => automationTrigger(draft.trigger)!.area);
  const [busy, setBusy] = useState<"save" | "test" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [test, setTest] = useState<AutomationTestResult | null>(null);

  const trigger = automationTrigger(draft.trigger)!;
  const names = useMemo(() => Object.fromEntries(options.users.map((u) => [u.id, u.name])), [options.users]);
  const sentence = automationSentence(draft, names);
  const dirty = JSON.stringify(draft) !== saved;
  const set = (patch: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setFlash(null);
  };

  const pickTrigger = (t: AutomationTriggerDef) => {
    const leadOk = t.entity === "Lead" || t.entity === "Proposal";
    set({
      trigger: t.key,
      triggerArgs: argDefaults(t),
      conditions: draft.conditions.filter((c) => t.fields.some((f) => f.key === c.field)),
      actions: draft.actions
        .filter((a) => leadOk || !automationActionInfo[a.type].leadOnly)
        .map((a) => fitAction(a, t, !initial && !dirty && draft.actions.length === 1)),
    });
    setTest(null);
  };

  const updateAction = (i: number, a: AutomationAction) => set({ actions: draft.actions.map((x, k) => (k === i ? a : x)) });
  const moveAction = (i: number, dir: -1 | 1) => {
    const next = [...draft.actions];
    const [a] = next.splice(i, 1);
    next.splice(i + dir, 0, a);
    set({ actions: next });
  };

  const save = async () => {
    setBusy("save");
    setError(null);
    try {
      if (initial) {
        const r = await api.automations.update(initial.id, toInput(draft));
        const fresh = initialDraft(r);
        setDraft(fresh);
        setSaved(JSON.stringify(fresh));
        setFlash("Saved.");
        onSaved?.();
      } else {
        const r = await api.automations.create(toInput(draft));
        router.push(`/admin/automations/${r.id}`);
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
      setTest(initial && !dirty ? await api.automations.test(initial.id) : await api.automations.testDraft(toInput(draft)));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!initial || !window.confirm(`Delete "${initial.name}"? It stops running straight away. Its history stays in the log.`)) return;
    setBusy("delete");
    try {
      await api.automations.remove(initial.id);
      router.push("/admin/automations");
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  };

  const recipientChoices = (allowClient: boolean) => [
    ...trigger.people.map((p) => ({ value: p, label: automationRecipientLabels[p] })),
    { value: "role", label: automationRecipientLabels.role },
    { value: "users", label: automationRecipientLabels.users },
    ...(allowClient ? [{ value: "client", label: "The client's contacts" }] : []),
  ];

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_300px]">
      <fieldset disabled={readOnly} className="min-w-0">
        {/* WHEN */}
        <Block step="When" title="This happens">
          <div className="-mx-1 mb-4 flex flex-wrap gap-1">
            {AUTOMATION_AREAS.map((a) => (
              <button key={a} type="button" onClick={() => setArea(a)} className={`px-2.5 py-1 text-sm ${area === a ? "bg-charcoal text-ivory" : "text-ink-muted hover:text-ink"}`}>
                {a}
              </button>
            ))}
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {AUTOMATION_TRIGGERS.filter((t) => t.area === area && !t.workflowOnly).map((t) => {
              const on = t.key === draft.trigger;
              return (
                <button key={t.key} type="button" onClick={() => pickTrigger(t)} aria-pressed={on} className={`border p-3 text-left transition-colors ${on ? "border-charcoal bg-canvas/50 shadow-[inset_3px_0_0_#8BB72C]" : "border-border hover:border-ink"}`}>
                  <span className="block text-sm font-medium">{t.label}</span>
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
                      {a.options?.map((o) => (
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
          <p className="mt-4 text-xs text-ink-muted">{trigger.event ? "Acts on new records from the moment the rule is switched on." : "Checks open records every minute. Each record is handled once per rule."}</p>
        </Block>

        <Connector />

        {/* IF */}
        <Block step="If" title="These are true" hint="Optional. All must be true.">
          {draft.conditions.length === 0 && <p className="text-sm text-ink-muted">No conditions: the rule runs for every {trigger.entity.toLowerCase()} that matches above.</p>}
          <ul className="space-y-2">
            {draft.conditions.map((c, i) => {
              const field = trigger.fields.find((f) => f.key === c.field) ?? trigger.fields[0];
              const ops = field.type === "number" || field.type === "money" ? AUTOMATION_OPS : AUTOMATION_OPS.filter((o) => o !== "greater_than" && o !== "less_than");
              const upd = (p: Partial<AutomationCondition>) => set({ conditions: draft.conditions.map((x, k) => (k === i ? { ...x, ...p } : x)) });
              return (
                <li key={i} className="grid grid-cols-1 gap-2 border border-border p-2 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,0.9fr)_minmax(0,1.2fr)_auto] sm:items-center sm:border-0 sm:p-0">
                  {i > 0 && <span className="text-[11px] uppercase tracking-[0.1em] text-ink-muted sm:hidden">and</span>}
                  <Select aria-label="Field" value={field.key} onChange={(e) => upd({ field: e.target.value, value: "", op: "equals" })} className="w-full">
                    {trigger.fields.map((f) => (
                      <option key={f.key} value={f.key}>
                        {f.label}
                      </option>
                    ))}
                  </Select>
                  <Select aria-label="Comparison" value={c.op} onChange={(e) => upd({ op: e.target.value as AutomationCondition["op"] })} className="w-full">
                    {ops.map((o) => (
                      <option key={o} value={o}>
                        {automationOpLabels[o]}
                      </option>
                    ))}
                  </Select>
                  {c.op === "is_empty" ? (
                    <span className="hidden sm:block" />
                  ) : field.options ? (
                    <Select aria-label="Value" value={c.value ?? ""} onChange={(e) => upd({ value: e.target.value })} className="w-full">
                      <option value="">Choose…</option>
                      {field.options.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <Input aria-label="Value" type={field.type === "text" ? "text" : "number"} placeholder={field.type === "money" ? "Amount in ₹" : field.type === "number" ? "Number" : "Text"} value={c.value ?? ""} onChange={(e) => upd({ value: e.target.value })} className="py-1.5" />
                  )}
                  <button type="button" onClick={() => set({ conditions: draft.conditions.filter((_, k) => k !== i) })} className="justify-self-start px-2 py-1 text-sm text-ink-muted hover:text-ink" aria-label="Remove condition">
                    Remove
                  </button>
                </li>
              );
            })}
          </ul>
          {!readOnly && draft.conditions.length < 10 && (
            <Button type="button" variant="secondary" className="mt-3 px-3 py-1.5" onClick={() => set({ conditions: [...draft.conditions, { field: trigger.fields[0].key, op: "equals", value: "" }] })}>
              Add condition
            </Button>
          )}
        </Block>

        <Connector />

        {/* THEN */}
        <Block step="Then" title="Do this" hint="In this order.">
          <ol className="space-y-3">
            {draft.actions.map((a, i) => (
              <li key={i} className="border border-border">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-canvas/40 px-3 py-2">
                  <span className="text-sm font-medium">
                    <span className="mr-2 text-ink-muted tabular-nums">{i + 1}.</span>
                    {automationActionInfo[a.type].label}
                  </span>
                  {!readOnly && (
                    <span className="flex gap-1 text-xs">
                      <IconBtn label="Move up" disabled={i === 0} onClick={() => moveAction(i, -1)}>
                        ↑
                      </IconBtn>
                      <IconBtn label="Move down" disabled={i === draft.actions.length - 1} onClick={() => moveAction(i, 1)}>
                        ↓
                      </IconBtn>
                      <IconBtn label="Remove action" onClick={() => set({ actions: draft.actions.filter((_, k) => k !== i) })}>
                        Remove
                      </IconBtn>
                    </span>
                  )}
                </div>
                <div className="space-y-3 p-3">
                  <p className="text-xs text-ink-muted">{automationActionInfo[a.type].description}</p>
                  <ActionFields action={a} onChange={(x) => updateAction(i, x)} trigger={trigger} options={options} recipientChoices={recipientChoices} />
                </div>
              </li>
            ))}
          </ol>
          {draft.actions.length === 0 && <p className="text-sm text-ink-muted">Add at least one action.</p>}
          {!readOnly && draft.actions.length < 10 && (
            <div className="mt-3">
              <Select
                aria-label="Add an action"
                value=""
                onChange={(e) => {
                  if (!e.target.value) return;
                  set({ actions: [...draft.actions, actionDefaults(e.target.value as AutomationActionType, trigger)] });
                }}
              >
                <option value="">+ Add an action…</option>
                {AUTOMATION_ACTION_TYPES.filter((t) => !automationActionInfo[t].leadOnly || trigger.entity === "Lead" || trigger.entity === "Proposal").map((t) => (
                  <option key={t} value={t}>
                    {automationActionInfo[t].label}
                  </option>
                ))}
              </Select>
            </div>
          )}
        </Block>

        {test && <TestResults result={test} onClose={() => setTest(null)} />}
      </fieldset>

      {/* Side panel */}
      <aside className="space-y-4 self-start lg:sticky lg:top-6">
        <section className="border border-border bg-surface-raised p-4">
          <p className="text-[11px] uppercase tracking-[0.1em] text-ink-muted">In plain words</p>
          <p className="mt-2 text-sm leading-relaxed">{sentence}</p>
        </section>
        <fieldset disabled={readOnly} className="space-y-4 border border-border bg-surface-raised p-4">
          <label className="block text-sm">
            <span className="mb-1 block text-xs text-ink-muted">Rule name</span>
            <Input value={draft.name} placeholder={trigger.label} maxLength={120} onChange={(e) => set({ name: e.target.value })} />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-xs text-ink-muted">Note for the team (optional)</span>
            <textarea value={draft.description} maxLength={500} rows={2} onChange={(e) => set({ description: e.target.value })} className="w-full border border-border bg-surface-raised px-3 py-2 text-sm" />
          </label>
          <div className="flex items-center justify-between gap-3 text-sm">
            <span>
              {draft.enabled ? "Switched on" : "Switched off"}
              <span className="block text-xs text-ink-muted">{draft.enabled ? "Runs every minute" : "Will not run until switched on"}</span>
            </span>
            <Toggle on={draft.enabled} label="Switch rule on or off" onChange={readOnly ? undefined : (v) => set({ enabled: v })} />
          </div>
        </fieldset>
        {error && <p className="border border-red bg-red/10 px-3 py-2 text-sm">{error}</p>}
        {flash && !dirty && <p className="border border-green bg-green/10 px-3 py-2 text-sm">{flash}</p>}
        <div className="flex flex-col gap-2">
          {!readOnly && (
            <Button onClick={save} disabled={busy !== null || (!!initial && !dirty)}>
              {busy === "save" ? "Saving…" : initial ? (dirty ? "Save changes" : "Saved") : "Create rule"}
            </Button>
          )}
          <Button variant="secondary" onClick={runTest} disabled={busy !== null || draft.actions.length === 0}>
            {busy === "test" ? "Checking…" : "Test against current data"}
          </Button>
          <p className="text-xs text-ink-muted">Testing shows which records match right now and what would happen. Nothing is sent or changed.</p>
          {initial && !readOnly && (
            <Button variant="ghost" className="mt-2 self-start px-0 text-[#b4432c] hover:text-[#b4432c]" onClick={remove} disabled={busy !== null}>
              {busy === "delete" ? "Deleting…" : "Delete rule"}
            </Button>
          )}
          {initial && (
            <p className="text-xs text-ink-muted">
              {initial.createdBy ? `Created by ${initial.createdBy}. ` : ""}
              {initial.templateKey ? "Started from a recipe." : ""}
            </p>
          )}
        </div>
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function Block({ step, title, hint, children }: { step: string; title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="border border-border bg-surface-raised">
      <header className="flex flex-wrap items-baseline gap-3 border-b border-border px-4 py-3 sm:px-5">
        <span className="bg-charcoal px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-ivory">{step}</span>
        <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
        {hint && <span className="text-xs text-ink-muted">{hint}</span>}
      </header>
      <div className="p-4 sm:p-5">{children}</div>
    </section>
  );
}

export function Connector() {
  return (
    <div aria-hidden className="relative ml-8 h-8">
      <span className="absolute inset-y-0 left-0 w-px bg-ink-muted/50" />
      <span className="absolute bottom-0 -left-[3px] h-0 w-0 border-x-[3.5px] border-t-[5px] border-x-transparent border-t-ink-muted/60" />
    </div>
  );
}

export function IconBtn({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} disabled={disabled} className="border border-border bg-surface-raised px-2 py-0.5 text-ink-muted hover:text-ink disabled:opacity-30">
      {children}
    </button>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-xs text-ink-muted">{label}</span>
      {children}
    </label>
  );
}

export function Placeholders({ trigger, onPick }: { trigger: AutomationTriggerDef; onPick: (p: string) => void }) {
  return (
    <p className="mt-1.5 flex flex-wrap items-center gap-1 text-xs text-ink-muted">
      Insert:
      {["record", ...trigger.placeholders].map((p) => (
        <button key={p} type="button" onClick={() => onPick(`{{${p}}}`)} className="border border-border px-1.5 py-0.5 font-mono text-[11px] text-ink hover:border-ink">
          {`{{${p}}}`}
        </button>
      ))}
    </p>
  );
}

export const TextArea = ({ value, onChange, rows = 2 }: { value: string; onChange: (v: string) => void; rows?: number }) => (
  <textarea value={value} rows={rows} onChange={(e) => onChange(e.target.value)} className="w-full border border-border bg-surface-raised px-3 py-2 text-sm" />
);

export function PeoplePicker({ options, value, onChange }: { options: AutomationOptions; value: string[]; onChange: (ids: string[]) => void }) {
  const chosen = options.users.filter((u) => value.includes(u.id));
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {chosen.map((u) => (
          <span key={u.id} className="inline-flex items-center gap-1 border border-border bg-canvas/50 px-2 py-0.5 text-xs">
            {u.name}
            <button type="button" aria-label={`Remove ${u.name}`} onClick={() => onChange(value.filter((x) => x !== u.id))} className="text-ink-muted hover:text-ink">
              ×
            </button>
          </span>
        ))}
        {!chosen.length && <span className="text-xs text-ink-muted">Nobody picked yet.</span>}
      </div>
      <Select aria-label="Add a person" value="" onChange={(e) => e.target.value && onChange([...value, e.target.value])}>
        <option value="">+ Add a person…</option>
        {options.users
          .filter((u) => !value.includes(u.id))
          .map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
      </Select>
    </div>
  );
}

export function RecipientFields({ to, role, userIds, choices, options, onChange }: { to: string; role?: string; userIds?: string[]; choices: { value: string; label: string }[]; options: AutomationOptions; onChange: (p: { to?: string; role?: string; userIds?: string[] }) => void }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Who">
        <Select value={to} onChange={(e) => onChange({ to: e.target.value, role: e.target.value === "role" ? (role ?? "finance") : undefined, userIds: e.target.value === "users" ? (userIds ?? []) : undefined })} className="w-full">
          {!choices.some((c) => c.value === to) && <option value={to}>{automationRecipientLabels[to as keyof typeof automationRecipientLabels] ?? to}</option>}
          {choices.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </Select>
      </Field>
      {to === "role" && (
        <Field label="Role">
          <Select value={role ?? ""} onChange={(e) => onChange({ role: e.target.value })} className="w-full">
            {options.roles.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {to === "users" && (
        <div className="sm:col-span-2">
          <PeoplePicker options={options} value={userIds ?? []} onChange={(ids) => onChange({ userIds: ids })} />
        </div>
      )}
    </div>
  );
}

export function ActionFields({ action: a, onChange, trigger, options, recipientChoices }: { action: AutomationAction; onChange: (a: AutomationAction) => void; trigger: AutomationTriggerDef; options: AutomationOptions; recipientChoices: (allowClient: boolean) => { value: string; label: string }[] }) {
  switch (a.type) {
    case "notify":
      return (
        <>
          <RecipientFields to={a.to} role={a.role} userIds={a.userIds} choices={recipientChoices(false)} options={options} onChange={(p) => onChange({ ...a, ...p } as AutomationAction)} />
          <Field label="Message">
            <TextArea value={a.message} onChange={(message) => onChange({ ...a, message })} />
          </Field>
          <Placeholders trigger={trigger} onPick={(p) => onChange({ ...a, message: `${a.message}${a.message.endsWith(" ") || !a.message ? "" : " "}${p}` })} />
        </>
      );
    case "create_task": {
      const choices = (["am", "owner", "assignee"] as const).filter((p) => trigger.people.includes(p));
      return (
        <>
          <Field label="Task title">
            <Input value={a.title} maxLength={200} onChange={(e) => onChange({ ...a, title: e.target.value })} />
          </Field>
          <Placeholders trigger={trigger} onPick={(p) => onChange({ ...a, title: `${a.title} ${p}`.trim() })} />
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Give it to">
              <Select value={a.assignTo} onChange={(e) => onChange({ ...a, assignTo: e.target.value as typeof a.assignTo, role: e.target.value === "role" ? (a.role ?? "account_manager") : undefined, userId: e.target.value === "user" ? (a.userId ?? options.users[0]?.id) : undefined })} className="w-full">
                {[...choices, "role" as const, "user" as const].map((v) => (
                  <option key={v} value={v}>
                    {automationTaskAssigneeLabels[v]}
                  </option>
                ))}
                {!choices.includes(a.assignTo as (typeof choices)[number]) && a.assignTo !== "role" && a.assignTo !== "user" && <option value={a.assignTo}>{automationTaskAssigneeLabels[a.assignTo]}</option>}
              </Select>
            </Field>
            {a.assignTo === "role" && (
              <Field label="Role">
                <Select value={a.role ?? ""} onChange={(e) => onChange({ ...a, role: e.target.value })} className="w-full">
                  {options.roles.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            {a.assignTo === "user" && (
              <Field label="Person">
                <Select value={a.userId ?? ""} onChange={(e) => onChange({ ...a, userId: e.target.value })} className="w-full">
                  {options.users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <Field label="Due in (working days)">
              <Input type="number" min={0} max={60} value={a.dueInDays ?? 0} onChange={(e) => onChange({ ...a, dueInDays: Math.max(0, Number(e.target.value)) })} className="w-24" />
            </Field>
          </div>
          <p className="text-xs text-ink-muted">0 means by the end of today. Sundays and holidays are skipped.</p>
        </>
      );
    }
    case "assign_lead_owner":
      return <p className="text-sm">Sales Executives and Sales Managers take turns. Leads that already have an owner are left alone.</p>;
    case "change_lead_stage":
      return (
        <Field label="Move to">
          <Select value={a.stage} onChange={(e) => onChange({ ...a, stage: e.target.value as typeof a.stage })}>
            {LEAD_STAGES.filter((s) => s !== "lost").map((s) => (
              <option key={s} value={s}>
                {leadStageLabels[s]}
              </option>
            ))}
          </Select>
        </Field>
      );
    case "post_internal_note":
    case "send_client_reminder":
      return (
        <>
          <Field label={a.type === "post_internal_note" ? "Note (team only)" : "Message the client will see"}>
            <TextArea value={a.message} rows={3} onChange={(message) => onChange({ ...a, message })} />
          </Field>
          <Placeholders trigger={trigger} onPick={(p) => onChange({ ...a, message: `${a.message} ${p}`.trim() })} />
          {a.type === "send_client_reminder" && <p className="text-xs text-ink-muted">Sent from the client&apos;s account manager in their app. Keep it polite and short.</p>}
        </>
      );
    case "email":
      return (
        <>
          <RecipientFields to={a.to} role={a.role} userIds={a.userIds} choices={recipientChoices(true)} options={options} onChange={(p) => onChange({ ...a, ...p } as AutomationAction)} />
          <Field label="Subject">
            <Input value={a.subject} maxLength={200} onChange={(e) => onChange({ ...a, subject: e.target.value })} />
          </Field>
          <Field label="Email text">
            <TextArea value={a.message} rows={4} onChange={(message) => onChange({ ...a, message })} />
          </Field>
          <Placeholders trigger={trigger} onPick={(p) => onChange({ ...a, message: `${a.message} ${p}`.trim() })} />
          <p className="border-l-2 border-amber pl-3 text-xs text-ink">
            Emails go out through the email server when one is set up; until then they are saved to the{" "}
            <Link href="/admin/outbox" className="underline">
              Outbox
            </Link>{" "}
            so you can read them. An in-app alert goes out too, and people who turned automation emails off are skipped.
          </p>
        </>
      );
    case "webhook":
      return (
        <>
          <Field label="Web address">
            <Input type="url" value={a.url} placeholder="https://hooks.example.com/…" onChange={(e) => onChange({ ...a, url: e.target.value })} />
          </Field>
          <p className="text-xs text-ink-muted">We POST the record as JSON and wait up to 5 seconds. Addresses on this computer or a private network are blocked.</p>
        </>
      );
    case "ai_draft":
      return (
        <>
          <Field label="What should AI draft?">
            <Select value={a.draft} onChange={(e) => onChange({ ...a, draft: e.target.value as typeof a.draft })}>
              {AUTOMATION_AI_DRAFT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {automationAiDraftLabels[k]}
                </option>
              ))}
            </Select>
          </Field>
          <RecipientFields to={a.to} role={a.role} userIds={a.userIds} choices={recipientChoices(false)} options={options} onChange={(p) => onChange({ ...a, ...p } as AutomationAction)} />
          <Field label="Extra instruction for AI (optional)">
            <TextArea value={a.instruction ?? ""} rows={2} onChange={(instruction) => onChange({ ...a, instruction })} />
          </Field>
          <p className="border-l-2 border-green pl-3 text-xs text-ink">The draft goes to the people above as an alert to review and edit. Nothing is sent to the client automatically. Without an AI key, a ready-made template is used.</p>
        </>
      );
  }
}

export function TestResults({ result, onClose }: { result: AutomationTestResult; onClose: () => void }) {
  return (
    <section className="mt-8 border border-border bg-surface-raised">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <h2 className="text-[15px] font-semibold tracking-tight">Test against current data</h2>
          <p className="mt-0.5 text-sm">
            {result.considered === 0 ? "No records match the trigger right now." : `${result.considered} record${result.considered === 1 ? "" : "s"} match the trigger; ${result.willRun} would be acted on now.`}
          </p>
          <p className="mt-1 text-xs text-ink-muted">{result.note} Nothing was sent or changed.</p>
        </div>
        <Button variant="ghost" className="px-2 py-1" onClick={onClose}>
          Close
        </Button>
      </header>
      {result.matches.length > 0 && (
        <ul className="divide-y divide-border">
          {result.matches.map((m) => {
            const runs = m.passes && !m.alreadyDone && !m.beforeStart;
            return (
              <li key={`${m.entity}-${m.entityId}-${m.record}`} className="px-5 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  {m.link ? (
                    <Link href={m.link} className="text-sm font-medium hover:underline">
                      {m.record}
                    </Link>
                  ) : (
                    <span className="text-sm font-medium">{m.record}</span>
                  )}
                  {runs && <Badge tone="green">Would run now</Badge>}
                  {m.alreadyDone && <Badge>Already handled</Badge>}
                  {!m.alreadyDone && m.beforeStart && m.passes && <Badge tone="dark">Example only: before the rule started</Badge>}
                  {!m.passes && <Badge tone="amber">Conditions not met</Badge>}
                </div>
                {!m.passes && m.failedCondition && <p className="mt-1 text-xs text-ink-muted">Stops at: {m.failedCondition}</p>}
                {m.wouldDo.length > 0 && (
                  <ul className="mt-1.5 space-y-0.5 text-xs text-ink">
                    {m.wouldDo.map((w, i) => (
                      <li key={i}>→ {w}</li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
