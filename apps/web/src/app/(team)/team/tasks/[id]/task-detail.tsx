"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { taskStatusLabels, type CoreTaskDetail, type CoreTaskFormOptions, type CoreTaskRow, type TaskStatus } from "@bmu/shared";
import { Badge } from "@/components/ui";
import { api } from "@/lib/api";
import { useActions, useActionShortcuts } from "@/components/actions/actions-provider";
import { HistoryTab } from "@/components/actions/history-tab";
import { RowMenu } from "@/components/actions/row-menu";
import { taskMenuItems, useTaskActionDialogs } from "@/components/actions/tasks/task-menu";
import { SENT_FILE_MAX, SentFileList } from "@/components/sent-files";

const day = new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "Asia/Kolkata" });
const statusTone = (s: string) => (s === "done" ? "green" : s === "blocked" ? "red" : s === "waiting" ? "amber" : s === "in_progress" ? "dark" : "neutral");
const btn = "border border-border bg-surface-raised px-3 py-1.5 text-sm hover:border-ink disabled:opacity-40";
const primary = "bg-charcoal px-3 py-1.5 text-sm font-medium text-ivory disabled:opacity-40";

export function TaskDetailView({ id }: { id: string }) {
  const { openNew, notify, version } = useActions();
  const [task, setTask] = useState<CoreTaskDetail>();
  const [error, setError] = useState<string>();
  const [tab, setTab] = useState<"details" | "history">("details");
  const [busy, setBusy] = useState(false);
  const [n, setN] = useState(0);
  const reload = useCallback(() => setN((x) => x + 1), []);
  const { actions, dialogs } = useTaskActionDialogs(task, reload);

  useEffect(() => {
    let live = true;
    api.coreTasks
      .get(id)
      .then((t) => {
        if (!live) return;
        setTask(t);
        setError(undefined);
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [id, version, n]);

  // ?tab=history opens History; ?reassign=1 opens the reassign dialog once the task has loaded.
  const [opened, setOpened] = useState(false);
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get("tab") === "history") queueMicrotask(() => setTab("history"));
    if (task && !opened && p.get("reassign") === "1" && actions) {
      queueMicrotask(() => setOpened(true));
      actions.reassign();
    }
  }, [task, opened, actions]);

  useActionShortcuts({ e: () => actions?.edit(), r: () => actions?.reassign(), d: () => actions?.deadline() });

  async function setStatus(status: TaskStatus) {
    if (!task) return;
    setBusy(true);
    try {
      const m = await api.coreTasks.status(task.id, status);
      setTask(m.task);
      notify(m.message ?? "Saved", m.undo);
    } catch (e) {
      notify((e as Error).message, null, "error");
    } finally {
      setBusy(false);
    }
  }

  if (error)
    return (
      <div className="py-10 text-center text-sm">
        <p role="alert" className="text-red">
          {error}
        </p>
        <Link href="/team/tasks" className="mt-3 inline-block underline">
          Back to tasks
        </Link>
      </div>
    );
  if (!task || !actions) return <p className="py-10 text-center text-sm text-ink-muted">Loading task…</p>;

  const t = task;
  const open = !["done", "cancelled"].includes(t.status) && !t.archivedAt && !t.isDraft;
  const manual = t.kind === "work" || t.kind === "planning";
  const items = taskMenuItems(t, actions).filter((i) => !["edit", "reassign", "deadline"].includes(i.key));

  return (
    <div data-testid="task-detail">
      <Link href="/team/tasks" className="text-xs text-ink-muted hover:underline">
        ← Tasks
      </Link>
      <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="font-display text-2xl md:text-3xl">{t.title}</h1>
          <p className="mt-1 text-sm text-ink-muted">
            {t.engagement ? (
              <>
                <Link href={`/team/projects/${t.engagement.id}`} className="hover:underline">
                  {t.engagement.client} · {t.engagement.service}
                </Link>{" "}
                · Gate {t.engagement.gate}
              </>
            ) : t.isInternal ? (
              "Internal"
            ) : null}
            {t.deliverable && (
              <>
                {" "}
                ·{" "}
                <Link href={`/team/deliverables/${t.deliverable.id}`} className="hover:underline">
                  {t.deliverable.title}
                </Link>
              </>
            )}
            {t.parent && (
              <>
                {" "}
                · Subtask of{" "}
                <Link href={`/team/tasks/${t.parent.id}`} className="hover:underline">
                  {t.parent.title}
                </Link>
              </>
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={statusTone(t.status)}>{t.archivedAt ? "Archived" : t.isDraft ? "Draft" : taskStatusLabels[t.status]}</Badge>
          {t.priority !== "normal" && <Badge tone={t.priority === "urgent" ? "red" : t.priority === "high" ? "amber" : "neutral"}>{t.priority}</Badge>}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {open && manual && t.can.status && (t.status === "todo" || t.status === "blocked" || t.status === "waiting") && (
          <button type="button" className={primary} disabled={busy || !t.ready} title={t.ready ? undefined : `Waiting on ${t.waitingOn.join(", ")}`} onClick={() => setStatus("in_progress")}>
            {t.status === "todo" ? "Start" : "Resume"}
          </button>
        )}
        {open && manual && t.can.status && t.status === "in_progress" && (
          <button type="button" className={primary} disabled={busy || !!t.can.blocked.status} title={t.can.blocked.status} onClick={() => setStatus("done")}>
            Mark done
          </button>
        )}
        {open && manual && t.can.status && t.status !== "blocked" && (
          <button type="button" className={btn} onClick={actions.blocked}>
            Blocked
          </button>
        )}
        {t.can.edit && !t.archivedAt && (
          <button type="button" className={btn} onClick={actions.edit} title="Edit (E)">
            Edit
          </button>
        )}
        {t.can.reassign && (
          <button type="button" className={btn} onClick={actions.reassign} title="Reassign (R)" disabled={!!t.can.blocked.reassign}>
            {t.owner ? "Reassign" : "Assign"}
          </button>
        )}
        {t.can.deadline && (
          <button type="button" className={btn} onClick={actions.deadline} title="Deadline (D)">
            {t.can.deadline === "request" ? "Ask for a new deadline" : "Change deadline"}
          </button>
        )}
        {t.can.handback && (
          <button type="button" className={btn} onClick={actions.handback}>
            Can&apos;t take this
          </button>
        )}
        <RowMenu label="More actions for this task" items={items} />
      </div>
      {t.can.blocked.status && open && <p className="mt-2 text-xs text-ink-muted">{t.can.blocked.status}</p>}

      {t.isDraft && <DraftBox task={t} onDone={reload} />}
      {t.archivedAt && (
        <p className="mt-4 border border-border bg-canvas px-4 py-3 text-sm">
          Archived{t.archivedReason ? `: ${t.archivedReason}` : ""}.{" "}
          {t.can.restore && (
            <button type="button" className="underline" onClick={actions.restore}>
              Restore
            </button>
          )}
        </p>
      )}
      {t.blocked && (
        <div className="mt-4 border border-red bg-red/5 px-4 py-3 text-sm" data-testid="blocked-box">
          <p className="font-semibold">Blocked{t.blocked.since ? ` since ${day.format(new Date(t.blocked.since))}` : ""}</p>
          {t.blocked.reason && <p>{t.blocked.reason}</p>}
          <p className="text-xs text-ink-muted">
            {t.blocked.waitingFor && `Waiting for ${t.blocked.waitingFor}`}
            {t.blocked.responsible && ` · ${t.blocked.responsible} can unblock it`}
            {t.blocked.expectedAt && ` · expected ${day.format(new Date(t.blocked.expectedAt))}`}
          </p>
        </div>
      )}
      {t.pendingApprovals.length > 0 && (
        <div className="mt-4 border border-amber bg-amber/10 px-4 py-3 text-sm">
          {t.pendingApprovals.map((a) => (
            <p key={a.id}>Waiting for approval: {a.summary}</p>
          ))}
        </div>
      )}

      <div className="mt-6 flex gap-4 border-b border-border text-sm" role="tablist">
        {(["details", "history"] as const).map((k) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`-mb-px border-b-2 px-1 pb-2 ${tab === k ? "border-charcoal font-semibold" : "border-transparent text-ink-muted"}`}>
            {k === "details" ? "Details" : "History"}
          </button>
        ))}
      </div>

      {tab === "history" ? (
        <div className="mt-4">
          <HistoryTab entity="Task" id={t.id} assignments={t.assignments} />
        </div>
      ) : (
        <div className="mt-4 grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <div className="min-w-0 space-y-6">
            {(t.description || t.brief) && (
              <section>
                {t.description && <p className="whitespace-pre-wrap text-sm">{t.description}</p>}
                {t.brief && (
                  <div className="mt-3">
                    <h2 className="text-sm font-semibold">Brief</h2>
                    <p className="whitespace-pre-wrap text-sm">{t.brief}</p>
                  </div>
                )}
              </section>
            )}
            {t.references.length > 0 && (
              <section>
                <h2 className="text-sm font-semibold">References</h2>
                <ul className="mt-1 space-y-0.5 text-sm">
                  {t.references.map((r) => (
                    <li key={r} className="truncate">
                      {/^https?:\/\//.test(r) ? (
                        <a href={r} target="_blank" rel="noreferrer" className="underline">
                          {r}
                        </a>
                      ) : (
                        r
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <TaskFiles task={t} onSaved={setTask} notify={notify} />
            <Checklist task={t} onSaved={setTask} />
            <Subtasks task={t} onAdd={() => openNew("task", { parentId: t.id, engagementId: t.engagementId ?? undefined, internal: t.isInternal ? "1" : undefined }, reload)} />
            <Dependencies task={t} onSaved={setTask} />
          </div>
          <aside className="space-y-5 text-sm">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
              <dt className="text-ink-muted">Owner</dt>
              <dd>{t.owner?.name ?? "Unassigned"}</dd>
              <dt className="text-ink-muted">Deadline</dt>
              <dd className={t.overdue ? "font-semibold text-red" : ""}>{t.deadline ? `${day.format(new Date(t.deadline))}${t.overdue ? " (late)" : ""}` : "None"}</dd>
              <dt className="text-ink-muted">Department</dt>
              <dd>{t.department ?? "—"}</dd>
              {t.estimateHours != null && (
                <>
                  <dt className="text-ink-muted">Estimate</dt>
                  <dd>{t.estimateHours}h</dd>
                </>
              )}
              <dt className="text-ink-muted">Logged</dt>
              <dd>{Math.round((t.timeLoggedMin / 60) * 10) / 10}h</dd>
              <dt className="text-ink-muted">Added</dt>
              <dd>
                {day.format(new Date(t.createdAt))}
                {t.createdBy ? ` by ${t.createdBy}` : ""}
              </dd>
            </dl>
            <Watchers task={t} />
            <Tags task={t} onSaved={reload} />
          </aside>
        </div>
      )}
      {dialogs}
    </div>
  );
}

function DraftBox({ task, onDone }: { task: CoreTaskDetail; onDone: () => void }) {
  const { notify } = useActions();
  const [opts, setOpts] = useState<CoreTaskFormOptions>();
  const [pick, setPick] = useState("");
  useEffect(() => {
    if (task.engagementId) api.coreTasks.formOptions(task.engagementId).then(setOpts, () => undefined);
  }, [task.engagementId]);
  const addOns = (opts?.addOnRequests ?? []).filter((a) => a.engagementId === task.engagementId);
  async function activate() {
    try {
      const m = await api.coreTasks.activate(task.id, pick);
      notify(m.message ?? "Activated", m.undo);
      onDone();
    } catch (e) {
      notify((e as Error).message, null, "error");
    }
  }
  return (
    <div className="mt-4 border border-amber bg-amber/10 px-4 py-3 text-sm" data-testid="draft-box">
      <p className="font-semibold">Draft{task.draftReason === "out_of_scope" ? ": adds work beyond the agreed scope" : ""}</p>
      <p className="text-xs">{task.draftReason === "out_of_scope" ? "It becomes a real task once the client approves an add-on request for it." : "Finish the details and activate it."}</p>
      {task.draftReason === "out_of_scope" && task.can.edit && (
        <div className="mt-2 flex flex-wrap gap-2">
          <select className="border border-border bg-surface-raised px-2 py-1 text-sm" value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Approved add-on request">
            <option value="">{addOns.length ? "Pick the approved add-on…" : "No approved add-on yet"}</option>
            {addOns.map((a) => (
              <option key={a.id} value={a.id}>
                {a.description}
              </option>
            ))}
          </select>
          <button type="button" className={primary} disabled={!pick} onClick={activate}>
            Activate
          </button>
        </div>
      )}
    </div>
  );
}

/** v38: files sent on the task. The owner, creator and watchers are told, and find them in Files ("Task"). */
function TaskFiles({ task, onSaved, notify }: { task: CoreTaskDetail; onSaved: (t: CoreTaskDetail) => void; notify: (m: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const picker = useRef<HTMLInputElement>(null);
  async function send(list: FileList | null) {
    if (!list?.length) return;
    setBusy(true);
    setError(undefined);
    try {
      for (const f of Array.from(list).slice(0, 10)) {
        if (f.size > SENT_FILE_MAX) throw new Error(`${f.name} is larger than 200 MB`);
        const r = await api.coreTasks.attachFile(task.id, f);
        onSaved(r.task);
        notify(r.message);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      if (picker.current) picker.current.value = "";
    }
  }
  const files = task.files ?? [];
  return (
    <section>
      <h2 className="flex items-center justify-between text-sm font-semibold">
        <span>Files{files.length ? ` (${files.length})` : ""}</span>
        <label className="cursor-pointer text-xs font-normal underline">
          {busy ? "Sending…" : "📎 Send a file"}
          <input ref={picker} type="file" multiple className="sr-only" disabled={busy} onChange={(e) => send(e.target.files)} aria-label="Send a file on this task" />
        </label>
      </h2>
      {files.length ? <SentFileList files={files} /> : <p className="mt-1 text-xs text-ink-muted">No files yet. Files sent here reach the owner, the creator and watchers, also in their Files.</p>}
      {error && <p className="mt-1 text-sm text-red">{error}</p>}
    </section>
  );
}

function Checklist({ task, onSaved }: { task: CoreTaskDetail; onSaved: (t: CoreTaskDetail) => void }) {
  const { notify } = useActions();
  const [label, setLabel] = useState("");
  async function save(checklist: CoreTaskDetail["checklist"]) {
    try {
      onSaved((await api.coreTasks.edit(task.id, { checklist })).task);
    } catch (e) {
      notify((e as Error).message, null, "error");
    }
  }
  if (!task.checklist.length && !task.can.edit) return null;
  const done = task.checklist.filter((c) => c.done).length;
  return (
    <section>
      <h2 className="text-sm font-semibold">
        Checklist{" "}
        {task.checklist.length > 0 && (
          <span className="font-normal text-ink-muted">
            {done}/{task.checklist.length}
          </span>
        )}
      </h2>
      <ul className="mt-1 space-y-1">
        {task.checklist.map((c) => (
          <li key={c.id}>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={c.done} disabled={!task.can.edit || !!task.archivedAt} onChange={() => save(task.checklist.map((x) => (x.id === c.id ? { ...x, done: !x.done } : x)))} />
              <span className={c.done ? "text-ink-muted line-through" : ""}>{c.label}</span>
            </label>
          </li>
        ))}
      </ul>
      {task.can.edit && !task.archivedAt && (
        <form
          className="mt-2 flex gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            if (!label.trim()) return;
            save([...task.checklist, { id: Math.random().toString(36).slice(2, 10), label: label.trim(), done: false }]);
            setLabel("");
          }}
        >
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Add a checklist item" maxLength={200} className="min-w-0 flex-1 border border-border bg-surface-raised px-2 py-1 text-sm" aria-label="New checklist item" />
          <button type="submit" className={btn} disabled={!label.trim()}>
            Add
          </button>
        </form>
      )}
    </section>
  );
}

function Subtasks({ task, onAdd }: { task: CoreTaskDetail; onAdd: () => void }) {
  if (!task.subtasks.length && !task.can.addSubtask) return null;
  return (
    <section>
      <h2 className="flex items-center justify-between text-sm font-semibold">
        <span>
          Subtasks{" "}
          {task.subtasks.length > 0 && (
            <span className="font-normal text-ink-muted">
              {task.subtasks.length - task.subtasksOpen}/{task.subtasks.length} done
            </span>
          )}
        </span>
        {task.can.addSubtask && (
          <button type="button" className="text-xs font-normal text-ink-muted hover:text-ink" onClick={onAdd}>
            + Add subtask
          </button>
        )}
      </h2>
      {task.subtasks.length === 0 ? (
        <p className="mt-1 text-xs text-ink-muted">No subtasks. Split the work so the parent is done only when every piece is.</p>
      ) : (
        <ul className="mt-1 divide-y divide-border border border-border">
          {task.subtasks.map((s) => (
            <SubRow key={s.id} s={s} />
          ))}
        </ul>
      )}
    </section>
  );
}

function SubRow({ s }: { s: CoreTaskRow }) {
  return (
    <li className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
      <Link href={`/team/tasks/${s.id}`} className="min-w-0 truncate hover:underline">
        {s.title}
      </Link>
      <span className="flex shrink-0 items-center gap-2 text-xs text-ink-muted">
        {s.owner?.name ?? "Unassigned"}
        <Badge tone={statusTone(s.status)}>{taskStatusLabels[s.status]}</Badge>
      </span>
    </li>
  );
}

function Dependencies({ task, onSaved }: { task: CoreTaskDetail; onSaved: (t: CoreTaskDetail) => void }) {
  const { notify } = useActions();
  const [q, setQ] = useState("");
  const [found, setFound] = useState<CoreTaskRow[]>([]);
  const canEdit = task.can.edit && !task.archivedAt;
  useEffect(() => {
    if (q.trim().length < 2) return;
    let live = true;
    const t = setTimeout(() => {
      api.coreTasks
        .query({ q: q.trim(), scope: "team" })
        .then((r) => live && setFound(r.filter((x) => x.id !== task.id && !task.dependencies.some((d) => d.id === x.id)).slice(0, 6)))
        .catch(() => live && setFound([]));
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, task.id, task.dependencies]);
  async function run(fn: () => Promise<{ task: CoreTaskDetail; message?: string }>) {
    try {
      const m = await fn();
      onSaved(m.task);
      setQ("");
      setFound([]);
    } catch (e) {
      notify((e as Error).message, null, "error");
    }
  }
  const shown = useMemo(() => (q.trim().length >= 2 ? found : []), [q, found]);
  if (!task.dependencies.length && !task.dependents.length && !canEdit) return null;
  return (
    <section>
      <h2 className="text-sm font-semibold">Waits on</h2>
      {task.dependencies.length === 0 && <p className="mt-1 text-xs text-ink-muted">Nothing. It can start any time.</p>}
      <ul className="mt-1 space-y-1">
        {task.dependencies.map((d) => (
          <li key={d.id} className="flex items-center justify-between gap-2 text-sm">
            <Link href={`/team/tasks/${d.id}`} className="min-w-0 truncate hover:underline">
              {d.title}
            </Link>
            <span className="flex shrink-0 items-center gap-2">
              <Badge tone={statusTone(d.status)}>{taskStatusLabels[d.status]}</Badge>
              {canEdit && (
                <button type="button" className="text-xs text-ink-muted hover:text-red" aria-label={`Remove ${d.title}`} onClick={() => run(() => api.coreTasks.removeDependency(task.id, d.id))}>
                  ✕
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
      {canEdit && (
        <div className="relative mt-2">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Add a task it waits on…" className="w-full border border-border bg-surface-raised px-2 py-1 text-sm" aria-label="Find a task it waits on" />
          {shown.length > 0 && (
            <ul className="absolute inset-x-0 top-full z-20 border border-border bg-surface shadow-lg">
              {shown.map((f) => (
                <li key={f.id}>
                  <button type="button" className="block w-full truncate px-2 py-1.5 text-left text-sm hover:bg-canvas" onClick={() => run(() => api.coreTasks.addDependency(task.id, f.id))}>
                    {f.title}
                    {f.client && <span className="text-xs text-ink-muted"> · {f.client.name}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {task.dependents.length > 0 && (
        <>
          <h2 className="mt-4 text-sm font-semibold">Blocks</h2>
          <ul className="mt-1 space-y-1 text-sm">
            {task.dependents.map((d) => (
              <li key={d.id}>
                <Link href={`/team/tasks/${d.id}`} className="hover:underline">
                  {d.title}
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function Watchers({ task }: { task: CoreTaskDetail }) {
  const { me, notify } = useActions();
  const [people, setPeople] = useState(task.watchers);
  const watching = people.some((p) => p.id === me.id);
  async function toggleWatch() {
    try {
      const r = watching ? await api.actions.watchers.unwatch("task", task.id) : await api.actions.watchers.watch("task", task.id);
      setPeople(r.people);
      notify(r.watching ? "You'll be told when it changes" : "Stopped watching");
    } catch (e) {
      notify((e as Error).message, null, "error");
    }
  }
  return (
    <section>
      <h2 className="flex items-center justify-between font-semibold">
        Watchers
        <button type="button" className="text-xs font-normal underline" onClick={toggleWatch}>
          {watching ? "Stop watching" : "Watch"}
        </button>
      </h2>
      <p className="text-xs text-ink-muted">{people.length ? people.map((p) => p.name).join(", ") : "Nobody else. Watch to hear about every change."}</p>
    </section>
  );
}

function Tags({ task, onSaved }: { task: CoreTaskDetail; onSaved: () => void }) {
  const { notify } = useActions();
  const [name, setName] = useState("");
  async function save(tagIds: string[], names: string[] = []) {
    try {
      await api.actions.tags.set("task", task.id, { tagIds, names });
      setName("");
      onSaved();
    } catch (e) {
      notify((e as Error).message, null, "error");
    }
  }
  return (
    <section>
      <h2 className="font-semibold">Tags</h2>
      <div className="mt-1 flex flex-wrap gap-1">
        {task.tags.length === 0 && <span className="text-xs text-ink-muted">No tags</span>}
        {task.tags.map((g) => (
          <span key={g.id} className="flex items-center gap-1 border border-border px-1.5 py-0.5 text-xs">
            {g.name}
            {task.can.edit && (
              <button
                type="button"
                aria-label={`Remove tag ${g.name}`}
                className="text-ink-muted hover:text-red"
                onClick={() =>
                  save(
                    task.tags.filter((x) => x.id !== g.id).map((x) => x.id),
                    [],
                  )
                }
              >
                ✕
              </button>
            )}
          </span>
        ))}
      </div>
      {task.can.edit && (
        <form
          className="mt-2 flex gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim())
              save(
                task.tags.map((x) => x.id),
                [name.trim()],
              );
          }}
        >
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Add a tag" maxLength={40} className="min-w-0 flex-1 border border-border bg-surface-raised px-2 py-1 text-xs" aria-label="New tag" />
          <button type="submit" className="border border-border px-2 text-xs" disabled={!name.trim()}>
            Add
          </button>
        </form>
      )}
    </section>
  );
}
