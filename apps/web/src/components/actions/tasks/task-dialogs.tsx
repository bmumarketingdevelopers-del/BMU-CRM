"use client";

/**
 * Small task dialogs used by the task row menu, board, detail page and Manager workspace:
 *   BlockedDialog   - mark Blocked with reason, waiting for, responsible person, expected date.
 *   DeadlineDialog  - change the deadline with a reason (producers send a request to their Department Head instead).
 *   ReasonDialog    - one reason prompt (archive, "Can't take this").
 *   DuplicateDialog - copy a task N times, with or without subtasks.
 * Each calls onDone(message, undo) after saving; the caller shows the toast.
 */
import { useEffect, useState } from "react";
import type { CoreTaskFormOptions, CoreTaskMutation, CoreTaskRow, CoreUndo } from "@bmu/shared";
import { api } from "@/lib/api";
import { ActionDialog, Field, TextArea, inputCls } from "../action-drawer";

const todayIst = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
type Done = (message: string, undo: CoreUndo | null, m?: CoreTaskMutation) => void;

function Footer({ busy, label, onSubmit, onClose, danger = false }: { busy: boolean; label: string; onSubmit: () => void; onClose: () => void; danger?: boolean }) {
  return (
    <>
      <button type="button" className={`px-4 py-2 text-sm font-medium disabled:opacity-40 ${danger ? "bg-red text-ivory" : "bg-charcoal text-ivory"}`} disabled={busy} onClick={onSubmit}>
        {busy ? "Saving…" : label}
      </button>
      <button type="button" className="border border-border px-3 py-2 text-sm" onClick={onClose}>
        Cancel
      </button>
    </>
  );
}

function useRun() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(true);
    setError(undefined);
    try {
      return await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, setError, run };
}

const Err = ({ error }: { error?: string }) =>
  error ? (
    <p role="alert" className="text-sm text-red">
      {error}
    </p>
  ) : null;

export function BlockedDialog({ task, onClose, onDone }: { task: Pick<CoreTaskRow, "id" | "title">; onClose: () => void; onDone: Done }) {
  const [reason, setReason] = useState("");
  const [waitingFor, setWaitingFor] = useState("");
  const [responsibleId, setResponsibleId] = useState("");
  const [expectedAt, setExpectedAt] = useState(todayIst());
  const [opts, setOpts] = useState<CoreTaskFormOptions>();
  const { busy, error, setError, run } = useRun();
  useEffect(() => {
    api.coreTasks.formOptions().then(setOpts, () => setOpts(undefined));
  }, []);
  async function submit() {
    if (reason.trim().length < 3) return setError("Say why it is blocked (at least 3 characters)");
    if (waitingFor.trim().length < 2) return setError("Say what you are waiting for");
    const m = await run(() => api.coreTasks.status(task.id, "blocked", { reason: reason.trim(), waitingFor: waitingFor.trim(), responsibleId: responsibleId || null, responsibleName: responsibleId ? undefined : "The client", expectedAt }));
    if (m) onDone(m.message ?? "Marked blocked", m.undo, m);
  }
  return (
    <ActionDialog open title="Mark as blocked" onClose={onClose} testId="blocked-dialog" footer={<Footer busy={busy} label="Mark blocked" onSubmit={submit} onClose={onClose} />}>
      <p className="text-ink-muted">{task.title}</p>
      <Field label="Why is it blocked" required>
        <TextArea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} aria-label="Why is it blocked" />
      </Field>
      <Field label="Waiting for" required hint="e.g. client logo files, brief sign-off">
        <input className={inputCls} value={waitingFor} onChange={(e) => setWaitingFor(e.target.value)} maxLength={200} aria-label="Waiting for" />
      </Field>
      <Field label="Who can unblock it">
        <select className={inputCls} value={responsibleId} onChange={(e) => setResponsibleId(e.target.value)} aria-label="Who can unblock it">
          <option value="">The client</option>
          {opts?.people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Expected by" required>
        <input className={inputCls} type="date" value={expectedAt} min={todayIst()} onChange={(e) => setExpectedAt(e.target.value)} aria-label="Expected by" />
      </Field>
      <Err error={error} />
    </ActionDialog>
  );
}

export function DeadlineDialog({ task, mode, onClose, onDone }: { task: Pick<CoreTaskRow, "id" | "title" | "deadline">; mode: "change" | "request"; onClose: () => void; onDone: Done }) {
  const [date, setDate] = useState(task.deadline ? new Date(new Date(task.deadline).getTime() + 5.5 * 3600_000).toISOString().slice(0, 10) : todayIst());
  const [reason, setReason] = useState("");
  const { busy, error, setError, run } = useRun();
  async function submit() {
    if (reason.trim().length < 3) return setError("Give a short reason (at least 3 characters)");
    const m = await run(() => api.coreTasks.deadline(task.id, date, reason.trim()));
    if (m) onDone(m.message ?? "Deadline changed", m.undo, m);
  }
  return (
    <ActionDialog open title={mode === "request" ? "Ask for a new deadline" : "Change deadline"} onClose={onClose} testId="deadline-dialog" footer={<Footer busy={busy} label={mode === "request" ? "Send request" : "Change deadline"} onSubmit={submit} onClose={onClose} />}>
      <p className="text-ink-muted">{task.title}</p>
      {mode === "request" && <p className="text-xs">Your Department Head decides. You keep the current deadline until they approve.</p>}
      <Field label="New deadline" required>
        <input className={inputCls} type="date" value={date} min={todayIst()} onChange={(e) => setDate(e.target.value)} aria-label="New deadline" />
      </Field>
      <Field label="Reason" required>
        <TextArea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} aria-label="Reason" />
      </Field>
      <Err error={error} />
    </ActionDialog>
  );
}

export function ReasonDialog({ title, intro, label = "Reason", submitLabel, danger, onClose, onSubmit }: { title: string; intro?: string; label?: string; submitLabel: string; danger?: boolean; onClose: () => void; onSubmit: (reason: string) => Promise<void> }) {
  const [reason, setReason] = useState("");
  const { busy, error, setError, run } = useRun();
  async function submit() {
    if (reason.trim().length < 3) return setError("Give a short reason (at least 3 characters)");
    await run(() => onSubmit(reason.trim()));
  }
  return (
    <ActionDialog open title={title} onClose={onClose} testId="reason-dialog" footer={<Footer busy={busy} label={submitLabel} danger={danger} onSubmit={submit} onClose={onClose} />}>
      {intro && <p className="text-ink-muted">{intro}</p>}
      <Field label={label} required>
        <TextArea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} aria-label={label} autoFocus />
      </Field>
      <Err error={error} />
    </ActionDialog>
  );
}

export function DuplicateDialog({ task, onClose, onDone }: { task: Pick<CoreTaskRow, "id" | "title" | "subtaskCount">; onClose: () => void; onDone: (message: string, undo: CoreUndo | null, ids: string[]) => void }) {
  const [count, setCount] = useState("1");
  const [withSubtasks, setWithSubtasks] = useState(true);
  const { busy, error, run } = useRun();
  async function submit() {
    const n = Math.min(20, Math.max(1, Number(count) || 1));
    const r = await run(() => api.coreTasks.duplicate(task.id, { count: n, withSubtasks }));
    if (r) onDone(n === 1 ? "Copy created" : `${n} copies created`, r.undo, r.ids);
  }
  return (
    <ActionDialog open title="Duplicate task" onClose={onClose} testId="duplicate-dialog" footer={<Footer busy={busy} label="Duplicate" onSubmit={submit} onClose={onClose} />}>
      <p className="text-ink-muted">{task.title}</p>
      <Field label="How many copies">
        <input className={inputCls} type="number" min={1} max={20} value={count} onChange={(e) => setCount(e.target.value)} aria-label="How many copies" />
      </Field>
      {task.subtaskCount > 0 && (
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={withSubtasks} onChange={(e) => setWithSubtasks(e.target.checked)} /> Copy its {task.subtaskCount} subtask{task.subtaskCount === 1 ? "" : "s"} too
        </label>
      )}
      <p className="text-xs text-ink-muted">Copies start as To do with the same owner, deadline and checklist (unticked).</p>
      <Err error={error} />
    </ActionDialog>
  );
}
