"use client";

/**
 * TaskDrawer: add a task from anywhere (+ New, board column, task list, calendar day, Client 360, project and
 * deliverable pages, "Create task" on a message) or edit one. Required: title, client engagement or Internal,
 * department, assignee (with load % and leave), deadline, priority. Everything else sits under "More details".
 *
 * Prefill keys: engagementId, deliverableId, parentId, deadline (YYYY-MM-DD), title, description, ownerId,
 * departmentId, internal ("1"), source ("message:<id>" | "comment:<id>"). Pass taskId to edit instead.
 */
import { useEffect, useMemo, useState } from "react";
import { CORE_TASK_PRIORITIES, coreCanOverride, coreCanRecur, coreRepeatRuleLabels, type CoreCandidates, type CoreTaskDetail, type CoreTaskFormOptions } from "@bmu/shared";
import { api } from "@/lib/api";
import { DuplicateWarning } from "../duplicate-warning";
import { ActionDrawer, Field, TextArea, inputCls, useDraftAutosave, type SaveMode } from "../action-drawer";
import { useActions } from "../actions-provider";
import type { NewDrawerProps } from "../new-registry";
import { PersonPicker } from "../person-picker";

type Values = {
  title: string;
  internal: boolean;
  engagementId: string;
  departmentId: string;
  ownerId: string;
  deadline: string;
  priority: string;
  description: string;
  brief: string;
  references: string;
  checklist: string;
  subtasks: string;
  estimateHours: string;
  deliverableId: string;
  watcherIds: string[];
  dependsOn: { id: string; title: string }[];
  preProduction: boolean;
  outOfScope: boolean;
  addOnRequestId: string;
  repeat: string;
  repeatEnd: string;
  overrideLeave: boolean;
};

const lines = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);
const todayPlus = (n: number) => new Date(Date.now() + n * 86_400_000 + 330 * 60_000).toISOString().slice(0, 10);

function initial(prefill: NewDrawerProps["prefill"] = {}): Values {
  return {
    title: prefill.title ?? "",
    internal: prefill.internal === "1",
    engagementId: prefill.engagementId ?? "",
    departmentId: prefill.departmentId ?? "",
    ownerId: prefill.ownerId ?? "",
    deadline: prefill.deadline ?? "",
    priority: "normal",
    description: prefill.description ?? "",
    brief: "",
    references: "",
    checklist: "",
    subtasks: "",
    estimateHours: "",
    deliverableId: prefill.deliverableId ?? "",
    watcherIds: [],
    dependsOn: [],
    preProduction: false,
    outOfScope: false,
    addOnRequestId: "",
    repeat: "",
    repeatEnd: "",
    overrideLeave: false,
  };
}

export function TaskDrawer(props: NewDrawerProps & { taskId?: string }) {
  return props.taskId ? <EditTaskDrawer {...props} taskId={props.taskId} /> : <CreateTaskDrawer {...props} />;
}

function CreateTaskDrawer({ open, onClose, prefill, onSaved }: NewDrawerProps) {
  const { me } = useActions();
  const [v, setV] = useState<Values>(() => initial(prefill));
  const [opts, setOpts] = useState<CoreTaskFormOptions>();
  const [optsError, setOptsError] = useState<string>();
  const [cands, setCands] = useState<CoreCandidates>();
  const [errors, setErrors] = useState<Partial<Record<keyof Values, string>>>({});
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [depQ, setDepQ] = useState("");
  const [depHits, setDepHits] = useState<{ id: string; title: string }[]>([]);
  const [parentTitle, setParentTitle] = useState<string>();
  const set = <K extends keyof Values>(k: K, val: Values[K]) => setV((x) => ({ ...x, [k]: val }));
  const draftKey = `new${prefill?.engagementId ? `:${prefill.engagementId}` : ""}${prefill?.parentId ? `:${prefill.parentId}` : ""}`;
  const draft = useDraftAutosave({ entity: "task", key: draftKey, values: v as unknown as Record<string, unknown>, enabled: open, onRestore: (d) => setV({ ...initial(prefill), ...(d as unknown as Values) }) });

  useEffect(() => {
    let live = true;
    api.coreTasks
      .formOptions(prefill?.engagementId)
      .then((o) => {
        if (!live) return;
        setOpts(o);
        const forClient = prefill?.clientId ? o.engagements.filter((e) => e.clientId === prefill.clientId) : [];
        setV((x) => ({
          ...x,
          ownerId: x.ownerId || (o.canAssignOthers ? "" : o.me.id),
          departmentId: x.departmentId || o.me.departmentId || "",
          engagementId: x.engagementId || (forClient.length === 1 ? forClient[0].id : ""),
          internal: x.internal || (!x.engagementId && !o.engagements.length),
        }));
      })
      .catch((e: Error) => live && setOptsError(e.message));
    if (prefill?.parentId)
      api.coreTasks
        .get(prefill.parentId)
        .then((p) => {
          if (!live) return;
          setParentTitle(p.title);
          setV((x) => ({ ...x, internal: p.isInternal, engagementId: p.engagementId ?? "", departmentId: x.departmentId || p.departmentId || "", deadline: x.deadline || (p.deadline ? p.deadline.slice(0, 10) : ""), deliverableId: p.deliverable?.id ?? "" }));
        })
        .catch(() => {});
    return () => {
      live = false;
    };
  }, [prefill?.engagementId, prefill?.parentId, prefill?.clientId]);

  // Candidates for the assignee picker: refresh when department / deadline / estimate change.
  useEffect(() => {
    if (!opts?.canAssignOthers) return;
    let live = true;
    const t = setTimeout(() => {
      api.actions.reassign
        .candidates("task", [], { departmentId: v.departmentId || undefined, deadline: v.deadline || undefined, estimateHours: v.estimateHours || undefined })
        .then((c) => live && setCands(c))
        .catch(() => {});
    }, 150);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [opts?.canAssignOthers, v.departmentId, v.deadline, v.estimateHours]);

  useEffect(() => {
    if (depQ.trim().length < 2) return;
    let live = true;
    const t = setTimeout(() => {
      api.coreTasks
        .query({ q: depQ.trim(), scope: "team" })
        .then((r) => live && setDepHits(r.slice(0, 8).map((x) => ({ id: x.id, title: x.title }))))
        .catch(() => {});
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [depQ]);

  // v11 people: a client in a client pod defaults the assignee to the pod member in the chosen department.
  const podPick = useMemo(() => {
    const members = opts?.engagements.find((e) => e.id === v.engagementId)?.podMemberIds ?? [];
    return members.find((id) => opts?.people.find((p) => p.id === id)?.departmentId === v.departmentId) ?? null;
  }, [opts, v.engagementId, v.departmentId]);
  const ownerId = v.ownerId || (opts?.canAssignOthers && podPick) || "";

  const eng = opts?.engagements.find((e) => e.id === v.engagementId);
  const deliverables = (opts?.deliverables ?? []).filter((d) => d.engagementId === v.engagementId);
  const addOns = (opts?.addOnRequests ?? []).filter((a) => a.engagementId === v.engagementId);
  const peopleInDept = useMemo(() => (cands?.candidates ?? []).sort((a, b) => Number(b.suggested) - Number(a.suggested)), [cands]);
  const chosen = cands?.candidates.find((c) => c.id === ownerId);
  const canRecur = coreCanRecur(me) && !prefill?.parentId;
  const needsPrePro = !!eng && !eng.productionOpen;

  function validate(mode: SaveMode) {
    const e: Partial<Record<keyof Values, string>> = {};
    if (v.title.trim().length < 3) e.title = "Give the task a title (at least 3 characters)";
    if (mode !== "draft") {
      if (!v.internal && !v.engagementId) e.engagementId = "Pick the client engagement, or mark it Internal";
      if (!v.departmentId) e.departmentId = "Pick a department";
      if (!ownerId) e.ownerId = "Pick who will do it";
      if (!v.deadline) e.deadline = "Pick a deadline";
      if (needsPrePro && !v.preProduction) e.preProduction = `${eng?.client} is at ${eng?.gate}: tick Pre-production for planning or onboarding work`;
      if (v.repeat && !v.repeatEnd) e.repeatEnd = "Pick when the repeats end";
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function save(mode: SaveMode) {
    setError(undefined);
    if (!validate(mode)) return;
    setSaving(true);
    try {
      const src = prefill?.source?.split(":");
      const r = await api.coreTasks.create({
        title: v.title.trim(),
        internal: v.internal,
        engagementId: v.internal ? null : v.engagementId || null,
        departmentId: v.departmentId,
        ownerId,
        deadline: v.deadline,
        priority: v.priority as (typeof CORE_TASK_PRIORITIES)[number],
        description: v.description.trim() || undefined,
        brief: v.brief.trim() || undefined,
        references: lines(v.references),
        checklist: lines(v.checklist).map((label, i) => ({ id: `c${i + 1}`, label, done: false })),
        subtasks: lines(v.subtasks).map((title) => ({ title })),
        dependsOn: v.dependsOn.map((d) => d.id),
        estimateHours: v.estimateHours ? Number(v.estimateHours) : undefined,
        deliverableId: v.deliverableId || null,
        watcherIds: v.watcherIds,
        parentId: prefill?.parentId ?? null,
        preProduction: v.preProduction,
        outOfScope: v.outOfScope,
        addOnRequestId: v.addOnRequestId || null,
        draft: mode === "draft",
        overrideLeave: v.overrideLeave || undefined,
        source: src && (src[0] === "message" || src[0] === "comment") ? { type: src[0], id: src[1] } : undefined,
        repeat: v.repeat && mode !== "draft" ? { rule: v.repeat as "daily", end: v.repeatEnd } : undefined,
      });
      draft.clear();
      onSaved(r.task.id, r.message ?? "Task added", r.undo);
      if (mode === "another") {
        setV((x) => ({ ...initial(prefill), engagementId: x.engagementId, internal: x.internal, departmentId: x.departmentId, deadline: x.deadline, ownerId: opts?.canAssignOthers ? "" : x.ownerId }));
        setErrors({});
      } else onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const more = (
    <>
      <Field label="Description">
        <TextArea value={v.description} onChange={(e) => set("description", e.target.value)} aria-label="Description" />
      </Field>
      <Field label="Brief">
        <TextArea value={v.brief} onChange={(e) => set("brief", e.target.value)} aria-label="Brief" />
      </Field>
      <Field label="References and attachment links" hint="One link or note per line.">
        <TextArea value={v.references} onChange={(e) => set("references", e.target.value)} aria-label="References" />
      </Field>
      <Field label="Checklist" hint="One item per line.">
        <TextArea value={v.checklist} onChange={(e) => set("checklist", e.target.value)} aria-label="Checklist" />
      </Field>
      {!prefill?.parentId && (
        <Field label="Subtasks" hint="One per line. They go to the same person unless reassigned later.">
          <TextArea value={v.subtasks} onChange={(e) => set("subtasks", e.target.value)} aria-label="Subtasks" />
        </Field>
      )}
      <Field label="Waits on (dependencies)" hint="This task shows Waiting until these are done.">
        <div className="grid gap-1.5">
          {v.dependsOn.map((d) => (
            <span key={d.id} className="flex items-center justify-between border border-border px-2 py-1 text-xs">
              {d.title}
              <button type="button" onClick={() => set("dependsOn", v.dependsOn.filter((x) => x.id !== d.id))} aria-label={`Remove ${d.title}`}>
                ✕
              </button>
            </span>
          ))}
          <input className={inputCls} value={depQ} onChange={(e) => setDepQ(e.target.value)} placeholder="Search tasks to wait on" aria-label="Search tasks to wait on" />
          {depQ.trim().length >= 2 &&
            depHits
              .filter((h) => !v.dependsOn.some((d) => d.id === h.id))
              .map((h) => (
                <button key={h.id} type="button" className="text-left text-xs underline" onClick={() => { set("dependsOn", [...v.dependsOn, h]); setDepQ(""); }}>
                  + {h.title}
                </button>
              ))}
        </div>
      </Field>
      <Field label="Estimate (hours)" hint="Used for capacity. Without it a task counts as 4 hours.">
        <input className={`${inputCls} w-32`} type="number" min={0.25} step={0.25} value={v.estimateHours} onChange={(e) => set("estimateHours", e.target.value)} aria-label="Estimate in hours" />
      </Field>
      {!v.internal && deliverables.length > 0 && (
        <Field label="Linked deliverable">
          <select className={inputCls} value={v.deliverableId} onChange={(e) => set("deliverableId", e.target.value)} aria-label="Linked deliverable">
            <option value="">None</option>
            {deliverables.map((d) => (
              <option key={d.id} value={d.id}>
                {d.title}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label="Watchers" hint="They get updates on status changes.">
        <select
          className={inputCls}
          multiple
          value={v.watcherIds}
          onChange={(e) => set("watcherIds", [...e.target.selectedOptions].map((o) => o.value))}
          aria-label="Watchers"
          size={Math.min(5, Math.max(2, opts?.people.length ?? 2))}
        >
          {(opts?.people ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </Field>
      {!v.internal && v.engagementId && (
        <div className="grid gap-2 border border-border p-3">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={v.outOfScope} onChange={(e) => set("outOfScope", e.target.checked)} /> Adds client work beyond the agreed scope
          </label>
          {v.outOfScope && (
            <Field label="Approved add-on request" hint="Without one, the task is saved as a draft and the client manager is asked to raise an add-on.">
              <select className={inputCls} value={v.addOnRequestId} onChange={(e) => set("addOnRequestId", e.target.value)} aria-label="Approved add-on request">
                <option value="">None yet</option>
                {addOns.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.description}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </div>
      )}
      {canRecur && (
        <div className="grid gap-2 border border-border p-3">
          <Field label="Repeat">
            <select className={inputCls} value={v.repeat} onChange={(e) => set("repeat", e.target.value)} aria-label="Repeat">
              <option value="">Does not repeat</option>
              {Object.entries(coreRepeatRuleLabels).map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
          {v.repeat && (
            <Field label="Repeat until" required error={errors.repeatEnd} hint="Copies are created 7 days ahead, skipping Sundays and holidays. The deadline above is the first one.">
              <input className={`${inputCls} w-48`} type="date" min={v.deadline || todayPlus(0)} value={v.repeatEnd} onChange={(e) => set("repeatEnd", e.target.value)} aria-label="Repeat until" />
            </Field>
          )}
        </div>
      )}
    </>
  );

  return (
    <ActionDrawer
      open={open}
      title={prefill?.parentId ? "New subtask" : "New task"}
      subtitle={parentTitle ? `Under “${parentTitle}”` : prefill?.source ? "From a message" : "Required fields first; the rest is under More details."}
      onClose={onClose}
      onSubmit={save}
      saving={saving}
      error={error ?? optsError}
      allowAnother
      allowDraft
      more={more}
      banner={draft.banner}
      footerNote={draft.savedAt ? `Draft autosaved ${new Date(draft.savedAt).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" })}` : undefined}
      testId="task-drawer"
    >
      <Field label="Title" required error={errors.title} htmlFor="task-title">
        <input id="task-title" className={inputCls} value={v.title} onChange={(e) => set("title", e.target.value)} onBlur={() => v.title && v.title.trim().length < 3 && setErrors((x) => ({ ...x, title: "At least 3 characters" }))} maxLength={200} />
      </Field>
      <DuplicateWarning
        value={v.title}
        noun="open task"
        search={(q) =>
          api.coreTasks
            .query({ q, scope: "team" })
            .then((r) => r.filter((t) => (!v.engagementId || t.engagementId === v.engagementId) && t.title.toLowerCase().includes(q.toLowerCase())).map((t) => ({ id: t.id, label: t.title, sub: [t.client?.name, t.owner?.name].filter(Boolean).join(" · "), href: `/team/tasks/${t.id}` })))
        }
      />
      {!prefill?.parentId && (
        <Field label="Client" required error={errors.engagementId}>
          <div className="grid gap-2">
            <div className="flex gap-4 text-sm">
              <label className="flex items-center gap-1.5">
                <input type="radio" name="task-kind" checked={!v.internal} onChange={() => set("internal", false)} /> Client work
              </label>
              <label className="flex items-center gap-1.5">
                <input type="radio" name="task-kind" checked={v.internal} onChange={() => set("internal", true)} /> Internal (training, admin, pitch)
              </label>
            </div>
            {!v.internal && (
              <select className={inputCls} value={v.engagementId} onChange={(e) => setV((x) => ({ ...x, engagementId: e.target.value, deliverableId: "", addOnRequestId: "", preProduction: false }))} aria-label="Client engagement">
                <option value="">{opts ? (opts.engagements.length ? "Pick the client and service…" : "No client engagements you can add to") : "Loading…"}</option>
                {opts?.engagements.filter((e) => !prefill?.clientId || e.clientId === prefill.clientId || e.id === v.engagementId).map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.client} · {e.service} ({e.gate})
                  </option>
                ))}
              </select>
            )}
            {needsPrePro && (
              <label className="flex items-start gap-2 text-xs">
                <input type="checkbox" checked={v.preProduction} onChange={(e) => set("preProduction", e.target.checked)} className="mt-0.5" />
                <span>
                  Pre-production (planning or onboarding work). {eng?.client} is at {eng?.gate}; other client tasks open at Gate 3.
                  {errors.preProduction && <span className="block text-red">{errors.preProduction}</span>}
                </span>
              </label>
            )}
          </div>
        </Field>
      )}
      <Field label="Department" required error={errors.departmentId}>
        <select className={inputCls} value={v.departmentId} onChange={(e) => set("departmentId", e.target.value)} aria-label="Department">
          <option value="">Pick a department…</option>
          {opts?.departments.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Deadline" required error={errors.deadline}>
          <input className={inputCls} type="date" value={v.deadline} min={todayPlus(-30)} onChange={(e) => set("deadline", e.target.value)} aria-label="Deadline" />
        </Field>
        <Field label="Priority" required>
          <select className={inputCls} value={v.priority} onChange={(e) => set("priority", e.target.value)} aria-label="Priority">
            {CORE_TASK_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {p[0].toUpperCase() + p.slice(1)}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Assignee" required error={errors.ownerId} hint={opts && !opts.canAssignOthers ? "You can add tasks for yourself. Ask your department head to assign work to others." : chosen ? `${chosen.name}: ${chosen.loadPct}% → ${chosen.loadAfterPct}% this week${chosen.onLeave ? `, ${chosen.leaveNote}` : ""}` : "Load % is this week's work against capacity, after adding this task."}>
        {opts && !opts.canAssignOthers ? (
          <p className="border border-border bg-canvas/40 px-3 py-2 text-sm">{opts.me.name} (you)</p>
        ) : cands ? (
          <PersonPicker candidates={peopleInDept} value={ownerId} onChange={(id) => set("ownerId", id)} />
        ) : (
          <p className="text-sm text-ink-muted">Loading people…</p>
        )}
      </Field>
      {chosen?.onLeave && coreCanOverride(me) && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={v.overrideLeave} onChange={(e) => set("overrideLeave", e.target.checked)} /> Override leave (Department Head)
        </label>
      )}
    </ActionDrawer>
  );
}

function EditTaskDrawer({ open, onClose, onSaved, taskId }: NewDrawerProps & { taskId: string }) {
  const [t, setT] = useState<CoreTaskDetail>();
  const [opts, setOpts] = useState<CoreTaskFormOptions>();
  const [loadError, setLoadError] = useState<string>();
  const [v, setV] = useState({ title: "", description: "", brief: "", references: "", checklist: [] as { id: string; label: string; done: boolean }[], newItem: "", estimateHours: "", priority: "normal", departmentId: "", deliverableId: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    Promise.all([api.coreTasks.get(taskId), api.coreTasks.formOptions()])
      .then(([task, o]) => {
        if (!live) return;
        setT(task);
        setOpts(o);
        setV({ title: task.title, description: task.description ?? "", brief: task.brief ?? "", references: task.references.join("\n"), checklist: task.checklist, newItem: "", estimateHours: task.estimateHours ? String(task.estimateHours) : "", priority: task.priority, departmentId: task.departmentId ?? "", deliverableId: task.deliverable?.id ?? "" });
      })
      .catch((e: Error) => live && setLoadError(e.message));
    return () => {
      live = false;
    };
  }, [taskId]);
  const manager = !!t?.can.reassign || !!t?.can.archive || t?.can.deadline === "change";
  async function save() {
    if (!t) return;
    setError(undefined);
    if (v.title.trim().length < 3) return setError("Give the task a title (at least 3 characters)");
    setSaving(true);
    try {
      const body = manager
        ? { title: v.title.trim(), description: v.description, brief: v.brief, references: lines(v.references), checklist: v.checklist, estimateHours: v.estimateHours ? Number(v.estimateHours) : null, priority: v.priority as "normal", departmentId: v.departmentId || undefined, deliverableId: v.deliverableId || null }
        : { description: v.description, brief: v.brief, references: lines(v.references), checklist: v.checklist, estimateHours: v.estimateHours ? Number(v.estimateHours) : null };
      const r = await api.coreTasks.edit(t.id, body);
      onSaved(t.id, r.message ?? "Saved", r.undo);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  const deliverables = (opts?.deliverables ?? []).filter((d) => d.engagementId === t?.engagementId);
  return (
    <ActionDrawer open={open} title="Edit task" subtitle={t ? [t.client?.name ?? (t.isInternal ? "Internal" : null), t.owner?.name].filter(Boolean).join(" · ") : undefined} onClose={onClose} onSubmit={t ? save : undefined} saving={saving} error={error ?? loadError} testId="task-edit-drawer">
      {!t && !loadError && <p className="text-sm text-ink-muted">Loading…</p>}
      {t && (
        <>
          <Field label="Title" required>
            <input className={inputCls} value={v.title} disabled={!manager} onChange={(e) => setV({ ...v, title: e.target.value })} aria-label="Title" />
          </Field>
          {manager && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Priority">
                <select className={inputCls} value={v.priority} onChange={(e) => setV({ ...v, priority: e.target.value })} aria-label="Priority">
                  {CORE_TASK_PRIORITIES.map((p) => (
                    <option key={p} value={p}>
                      {p[0].toUpperCase() + p.slice(1)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Department">
                <select className={inputCls} value={v.departmentId} onChange={(e) => setV({ ...v, departmentId: e.target.value })} aria-label="Department">
                  {opts?.departments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          )}
          <Field label="Description">
            <TextArea value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} aria-label="Description" />
          </Field>
          <Field label="Brief">
            <TextArea value={v.brief} onChange={(e) => setV({ ...v, brief: e.target.value })} aria-label="Brief" />
          </Field>
          <Field label="References and attachment links" hint="One per line.">
            <TextArea value={v.references} onChange={(e) => setV({ ...v, references: e.target.value })} aria-label="References" />
          </Field>
          <Field label="Checklist">
            <div className="grid gap-1">
              {v.checklist.map((c) => (
                <label key={c.id} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={c.done} onChange={(e) => setV({ ...v, checklist: v.checklist.map((x) => (x.id === c.id ? { ...x, done: e.target.checked } : x)) })} />
                  <span className="flex-1">{c.label}</span>
                  <button type="button" className="text-xs text-ink-muted" onClick={() => setV({ ...v, checklist: v.checklist.filter((x) => x.id !== c.id) })} aria-label={`Remove ${c.label}`}>
                    ✕
                  </button>
                </label>
              ))}
              <span className="flex gap-2">
                <input className={inputCls} value={v.newItem} onChange={(e) => setV({ ...v, newItem: e.target.value })} placeholder="Add an item" aria-label="New checklist item" />
                <button type="button" className="border border-border px-3 text-sm" onClick={() => v.newItem.trim() && setV({ ...v, newItem: "", checklist: [...v.checklist, { id: `c${Date.now()}`, label: v.newItem.trim(), done: false }] })}>
                  Add
                </button>
              </span>
            </div>
          </Field>
          <Field label="Estimate (hours)">
            <input className={`${inputCls} w-32`} type="number" min={0.25} step={0.25} value={v.estimateHours} onChange={(e) => setV({ ...v, estimateHours: e.target.value })} aria-label="Estimate in hours" />
          </Field>
          {manager && deliverables.length > 0 && (
            <Field label="Linked deliverable">
              <select className={inputCls} value={v.deliverableId} onChange={(e) => setV({ ...v, deliverableId: e.target.value })} aria-label="Linked deliverable">
                <option value="">None</option>
                {deliverables.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.title}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <p className="text-xs text-ink-muted">Owner and deadline change through Reassign and Change deadline, so the reason is recorded.</p>
        </>
      )}
    </ActionDrawer>
  );
}
