"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { coreCanUseTemplates, taskStatusLabels, TASK_STATUSES, type CoreTaskFormOptions, type CoreTaskQuery, type CoreTaskRow, type TaskStatus, type TaskView } from "@bmu/shared";
import { CsvButton } from "@/components/charts";
import { TaskBoard } from "@/components/task-list";
import { Badge, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useActions, useActionShortcuts } from "@/components/actions/actions-provider";
import { BulkBar, BulkButton, useSelection } from "@/components/actions/bulk-bar";
import { ImportWizard } from "@/components/actions/import-wizard";
import { SavedViewsMenu } from "@/components/actions/saved-views-menu";
import { ActionDialog, Field, TextArea, inputCls } from "@/components/actions/action-drawer";
import { BlockedDialog } from "@/components/actions/tasks/task-dialogs";
import { TaskRowMenu } from "@/components/actions/tasks/task-menu";
import { RecurringList, TemplateWizard } from "@/components/actions/tasks/template-wizard";

type Filters = { q: string; scope: "mine" | "team"; show: "open" | "completed" | "drafts" | "archived"; ownerId: string; clientId: string; departmentId: string; status: string; from: string; to: string; tag: string };
const EMPTY: Filters = { q: "", scope: "mine", show: "open", ownerId: "", clientId: "", departmentId: "", status: "", from: "", to: "", tag: "" };
const day = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });
const statusTone = (s: string) => (s === "done" ? "green" : s === "blocked" ? "red" : s === "waiting" ? "amber" : s === "in_progress" ? "dark" : "neutral");
const LAYOUT_KEY = "bmu.tasks.layout";
const toggle = (active: boolean) => `border px-3 py-1 text-sm ${active ? "border-charcoal bg-charcoal text-ivory" : "border-border bg-surface-raised"}`;
const selectCls = "border border-border bg-surface-raised px-2 py-1.5 text-sm";

export function TasksWorkspace() {
  const { me, openNew, openReassign, notify, version, changed, canNew } = useActions();
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [q, setQ] = useState("");
  const [layout, setLayout] = useState<"board" | "list">("board");
  const [rows, setRows] = useState<CoreTaskRow[]>();
  const [error, setError] = useState<string>();
  const [opts, setOpts] = useState<CoreTaskFormOptions>();
  const [panel, setPanel] = useState<"import" | "template" | "recurring" | null>(null);
  const [bulk, setBulk] = useState<"status" | "deadline" | "archive" | "tag" | "priority" | null>(null);
  const [blocking, setBlocking] = useState<CoreTaskRow>();
  const [n, setN] = useState(0);
  const search = useRef<HTMLInputElement>(null);
  const reload = useCallback(() => setN((x) => x + 1), []);

  useEffect(() => {
    try {
      const l = localStorage.getItem(LAYOUT_KEY);
      if (l === "list" || l === "board") queueMicrotask(() => setLayout(l));
    } catch {
      /* storage blocked: keep the default */
    }
  }, []);
  useEffect(() => {
    api.coreTasks.formOptions().then(setOpts, () => undefined);
  }, []);
  useEffect(() => {
    const t = setTimeout(() => setFilters((f) => (f.q === q ? f : { ...f, q })), 250);
    return () => clearTimeout(t);
  }, [q]);

  const query = useMemo<CoreTaskQuery>(
    () => ({
      q: filters.q || undefined,
      scope: filters.scope,
      ownerId: filters.ownerId || undefined,
      clientId: filters.clientId || undefined,
      departmentId: filters.departmentId || undefined,
      status: filters.status || undefined,
      from: filters.from || undefined,
      to: filters.to || undefined,
      tag: filters.tag || undefined,
      archived: filters.show === "archived" ? "1" : undefined,
      drafts: filters.show === "drafts" ? "1" : undefined,
      completed: filters.show === "completed" ? "1" : undefined,
    }),
    [filters],
  );
  useEffect(() => {
    let live = true;
    api.coreTasks
      .query(query)
      .then((r) => {
        if (!live) return;
        setRows(r);
        setError(undefined);
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [query, version, n]);

  const ids = useMemo(() => (rows ?? []).map((r) => r.id), [rows]);
  const sel = useSelection(ids);
  const byId = useMemo(() => new Map((rows ?? []).map((r) => [r.id, r])), [rows]);
  const set = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }));
  const setLayoutSaved = (l: "board" | "list") => {
    setLayout(l);
    try {
      localStorage.setItem(LAYOUT_KEY, l);
    } catch {
      /* ignore */
    }
  };
  const addTask = () => openNew("task", {}, () => reload());
  useActionShortcuts({ n: canNew("task") ? addTask : undefined, slash: () => search.current?.focus() });

  const clients = useMemo(() => [...new Map((opts?.engagements ?? []).map((e) => [e.clientId, e.client])).entries()].sort((a, b) => a[1].localeCompare(b[1])), [opts]);
  const active = Object.entries(filters).filter(([k, v]) => v && !["q", "scope", "show"].includes(k)).length;
  const manager = !!opts?.canAssignOthers;
  const canImport = me.roles.some((r) => ["founder", "admin", "am_lead", "department_head", "account_manager"].includes(r));
  const selected = sel.ids.map((id) => byId.get(id)).filter((r): r is CoreTaskRow => !!r);

  async function move(t: TaskView, status: TaskStatus): Promise<TaskView> {
    const m = await api.coreTasks.status(t.id, status);
    notify(m.message ?? "Saved", m.undo);
    return m.task;
  }

  return (
    <>
      <PageTitle
        title="Tasks"
        subtitle="Your work and your team's: add, assign, reassign and track. Steps from department flows unlock when the one before is done."
        action={
          <div className="flex flex-wrap gap-2">
            {canNew("task") && (
              <button type="button" onClick={addTask} className="bg-charcoal px-3 py-1.5 text-sm font-medium text-ivory" data-testid="add-task">
                + Add task
              </button>
            )}
            {coreCanUseTemplates(me) && (
              <button type="button" onClick={() => setPanel("template")} className="border border-border px-3 py-1.5 text-sm">
                From template
              </button>
            )}
            {canImport && (
              <button type="button" onClick={() => setPanel("import")} className="border border-border px-3 py-1.5 text-sm">
                Import
              </button>
            )}
            {manager && (
              <button type="button" onClick={() => setPanel("recurring")} className="border border-border px-3 py-1.5 text-sm">
                Recurring
              </button>
            )}
          </div>
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input ref={search} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search tasks  /" aria-label="Search tasks" className="w-full border border-border bg-surface-raised px-3 py-1.5 text-sm sm:w-56" />
        <button type="button" className={toggle(filters.scope === "mine")} onClick={() => set({ scope: "mine" })}>
          Mine
        </button>
        <button type="button" className={toggle(filters.scope === "team")} onClick={() => set({ scope: "team" })}>
          Everything I can see
        </button>
        {/* Completed work stays findable at any age (newest first); Mine / Everything I can see still apply. */}
        <button type="button" className={toggle(filters.show === "completed")} aria-pressed={filters.show === "completed"} onClick={() => set({ show: filters.show === "completed" ? "open" : "completed" })}>
          Completed
        </button>
        <span className="hidden w-2 sm:inline" />
        <button type="button" className={toggle(layout === "board")} onClick={() => setLayoutSaved("board")}>
          Board
        </button>
        <button type="button" className={toggle(layout === "list")} onClick={() => setLayoutSaved("list")}>
          List
        </button>
        <span className="hidden w-2 sm:inline" />
        <SavedViewsMenu entity="task" filters={filters} onApply={(f) => setFilters({ ...EMPTY, ...(f as Partial<Filters>) })} />
        <CsvButton
          filename="tasks.csv"
          rows={rows ?? []}
          columns={[
            { header: "Task", value: (r) => r.title },
            { header: "Client", value: (r) => r.client?.name ?? (r.isInternal ? "Internal" : "") },
            { header: "Owner", value: (r) => r.owner?.name },
            { header: "Department", value: (r) => r.department },
            { header: "Status", value: (r) => taskStatusLabels[r.status] },
            { header: "Priority", value: (r) => r.priority },
            { header: "Deadline", value: (r) => r.deadline?.slice(0, 10) },
            { header: "Tags", value: (r) => r.tags.map((t) => t.name).join("; ") },
          ]}
        />
      </div>

      <details className="mb-4 border border-border bg-surface-raised" open={active > 0}>
        <summary className="cursor-pointer px-3 py-2 text-sm">Filters{active ? ` (${active})` : ""}</summary>
        <div className="grid gap-2 px-3 pb-3 sm:grid-cols-2 lg:grid-cols-4">
          <select className={selectCls} value={filters.show} onChange={(e) => set({ show: e.target.value as Filters["show"] })} aria-label="Show">
            <option value="open">Open and recent</option>
            <option value="completed">Completed (all time)</option>
            <option value="drafts">Drafts</option>
            <option value="archived">Archived</option>
          </select>
          <select className={selectCls} value={filters.ownerId} onChange={(e) => set({ ownerId: e.target.value, scope: e.target.value ? "team" : filters.scope })} aria-label="Owner">
            <option value="">Any owner</option>
            <option value="none">Unassigned</option>
            {opts?.people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <select className={selectCls} value={filters.clientId} onChange={(e) => set({ clientId: e.target.value })} aria-label="Client">
            <option value="">Any client</option>
            <option value="internal">Internal</option>
            {clients.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
          <select className={selectCls} value={filters.departmentId} onChange={(e) => set({ departmentId: e.target.value })} aria-label="Department">
            <option value="">Any department</option>
            {opts?.departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
          <select className={selectCls} value={filters.status} onChange={(e) => set({ status: e.target.value })} aria-label="Status">
            <option value="">Any status</option>
            <option value="overdue">Overdue</option>
            {TASK_STATUSES.filter((s) => s !== "cancelled").map((s) => (
              <option key={s} value={s}>
                {taskStatusLabels[s]}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-2 text-xs">
            Due from
            <input type="date" className={`${selectCls} flex-1`} value={filters.from} onChange={(e) => set({ from: e.target.value })} aria-label="Due from" />
          </label>
          <label className="flex items-center gap-2 text-xs">
            to
            <input type="date" className={`${selectCls} flex-1`} value={filters.to} onChange={(e) => set({ to: e.target.value })} aria-label="Due to" />
          </label>
          <input className={selectCls} value={filters.tag} onChange={(e) => set({ tag: e.target.value.trim() })} placeholder="Tag" aria-label="Tag" />
          {active > 0 && (
            <button type="button" className="text-left text-xs underline" onClick={() => setFilters((f) => ({ ...EMPTY, q: f.q, scope: f.scope }))}>
              Clear filters
            </button>
          )}
        </div>
      </details>

      {error && (
        <p role="alert" className="mb-3 border border-red bg-red/10 px-4 py-2 text-sm">
          {error}{" "}
          <button type="button" className="underline" onClick={reload}>
            Try again
          </button>
        </p>
      )}
      {!rows && !error && <p className="py-8 text-center text-sm text-ink-muted">Loading tasks…</p>}
      {rows && rows.length === 0 && (
        <div className="border border-border bg-surface-raised px-4 py-10 text-center text-sm" data-testid="tasks-empty">
          <p className="text-ink-muted">{filters.show === "archived" ? "Nothing archived." : filters.show === "drafts" ? "No drafts." : active || filters.q ? "No tasks match these filters." : "No tasks here yet."}</p>
          {canNew("task") && filters.show === "open" && (
            <button type="button" className="mt-3 bg-charcoal px-3 py-1.5 text-sm text-ivory" onClick={addTask}>
              + Add task
            </button>
          )}
        </div>
      )}

      {rows && rows.length > 0 && layout === "board" && filters.show === "open" && (
        <TaskBoard
          tasks={rows}
          onChanged={() => reload()}
          cardMenu={(t) => byId.get(t.id) && <TaskRowMenu task={byId.get(t.id)!} onChanged={reload} />}
          cardHref={(t) => `/team/tasks/${t.id}`}
          onAdd={canNew("task") ? () => addTask() : undefined}
          onBlock={(t) => {
            const row = byId.get(t.id);
            if (row) setBlocking(row);
          }}
          onMove={move}
        />
      )}

      {rows && rows.length > 0 && (layout === "list" || filters.show !== "open") && (
        <div className="border border-border">
          <div className="hidden grid-cols-[2rem_minmax(0,3fr)_minmax(0,1.5fr)_minmax(0,1.2fr)_6rem_7rem_2.5rem] gap-2 border-b border-border bg-canvas/50 px-3 py-2 text-xs text-ink-muted md:grid">
            <input type="checkbox" checked={sel.allSelected} onChange={sel.toggleAll} aria-label="Select all" />
            <span>Task</span>
            <span>Client</span>
            <span>Owner</span>
            <span>Due</span>
            <span>Status</span>
            <span />
          </div>
          <ul>
            {rows.map((t) => (
              <li key={t.id} className="grid grid-cols-[2rem_minmax(0,1fr)_2.5rem] items-start gap-2 border-b border-border px-3 py-2 text-sm last:border-b-0 md:grid-cols-[2rem_minmax(0,3fr)_minmax(0,1.5fr)_minmax(0,1.2fr)_6rem_7rem_2.5rem] md:items-center" data-task-row={t.id}>
                <input type="checkbox" checked={sel.has(t.id)} onChange={() => sel.toggle(t.id)} aria-label={`Select ${t.title}`} className="mt-1 md:mt-0" />
                <div className="min-w-0">
                  <Link href={`/team/tasks/${t.id}`} className="font-medium hover:underline">
                    {t.title}
                  </Link>
                  <p className="flex flex-wrap gap-x-2 text-xs text-ink-muted">
                    {t.subtaskCount > 0 && (
                      <span>
                        {t.subtaskCount - t.subtasksOpen}/{t.subtaskCount} subtasks
                      </span>
                    )}
                    {t.waitingOn.length > 0 && <span>Waiting on {t.waitingOn[0]}</span>}
                    {t.isDraft && <span className="text-amber">Draft{t.draftReason === "out_of_scope" ? ": beyond scope" : ""}</span>}
                    {t.archivedAt && <span>Archived: {t.archivedReason}</span>}
                    {t.tags.map((g) => (
                      <span key={g.id} className="border border-border px-1">
                        {g.name}
                      </span>
                    ))}
                  </p>
                  <p className="text-xs text-ink-muted md:hidden">
                    {[t.client?.name ?? (t.isInternal ? "Internal" : null), t.owner?.name ?? "Unassigned", t.deadline ? `Due ${day.format(new Date(t.deadline))}` : null, taskStatusLabels[t.status]].filter(Boolean).join(" · ")}
                  </p>
                </div>
                <span className="hidden truncate text-ink-muted md:block">{t.client?.name ?? (t.isInternal ? "Internal" : "—")}</span>
                <span className="hidden truncate md:block">{t.owner?.name ?? <span className="text-ink-muted">Unassigned</span>}</span>
                <span className={`hidden md:block ${t.overdue ? "font-semibold text-red" : ""}`}>{t.deadline ? day.format(new Date(t.deadline)) : "—"}</span>
                <span className="hidden md:block">
                  <Badge tone={statusTone(t.status)}>{taskStatusLabels[t.status]}</Badge>
                </span>
                <TaskRowMenu task={t} onChanged={reload} />
              </li>
            ))}
          </ul>
        </div>
      )}
      {layout === "board" && filters.show === "open" && rows && rows.length > 0 && (
        <p className="mt-2 text-xs text-ink-muted">
          To select several tasks at once, switch to{" "}
          <button type="button" className="underline" onClick={() => setLayoutSaved("list")}>
            List
          </button>
          .
        </p>
      )}

      <BulkBar count={sel.count} onClear={sel.clear} label="tasks">
        {selected.some((t) => t.can.reassign) && <BulkButton onClick={() => openReassign({ type: "task", ids: selected.filter((t) => t.can.reassign).map((t) => t.id), title: `Reassign ${selected.length} tasks`, onDone: () => sel.clear() })}>Reassign</BulkButton>}
        <BulkButton onClick={() => setBulk("status")}>Status</BulkButton>
        {manager && <BulkButton onClick={() => setBulk("deadline")}>Deadline</BulkButton>}
        {manager && <BulkButton onClick={() => setBulk("priority")}>Priority</BulkButton>}
        <BulkButton onClick={() => setBulk("tag")}>Tag</BulkButton>
        {selected.some((t) => t.can.archive) && <BulkButton onClick={() => setBulk("archive")}>Archive</BulkButton>}
      </BulkBar>

      {bulk && (
        <BulkTaskDialog
          action={bulk}
          ids={sel.ids}
          onClose={() => setBulk(null)}
          onDone={(message, undo) => {
            setBulk(null);
            sel.clear();
            notify(message, undo);
            changed();
          }}
        />
      )}
      {blocking && (
        <BlockedDialog
          task={blocking}
          onClose={() => setBlocking(undefined)}
          onDone={(m, u) => {
            setBlocking(undefined);
            notify(m, u);
            reload();
          }}
        />
      )}
      {panel === "import" && <ImportWizard entity="tasks" open onClose={() => setPanel(null)} onDone={() => changed()} />}
      {panel === "template" && (
        <TemplateWizard
          open
          onClose={() => setPanel(null)}
          onDone={(m, u) => {
            setPanel(null);
            notify(m, u);
            changed();
          }}
        />
      )}
      {panel === "recurring" && (
        <ActionDialog open title="Recurring tasks" onClose={() => setPanel(null)}>
          <p className="text-xs text-ink-muted">Each rule creates its tasks 7 days ahead, skipping Sundays and holidays.</p>
          <RecurringList onChanged={changed} />
        </ActionDialog>
      )}
    </>
  );
}

function BulkTaskDialog({ action, ids, onClose, onDone }: { action: "status" | "deadline" | "archive" | "tag" | "priority"; ids: string[]; onClose: () => void; onDone: (message: string, undo: Parameters<ReturnType<typeof useActions>["notify"]>[1]) => void }) {
  const [status, setStatus] = useState<TaskStatus>("in_progress");
  const [deadline, setDeadline] = useState("");
  const [priority, setPriority] = useState("normal");
  const [tag, setTag] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const title = { status: "Change status", deadline: "Change deadline", archive: "Archive tasks", tag: "Add a tag", priority: "Change priority" }[action];
  async function submit() {
    setError(undefined);
    if ((action === "deadline" || action === "archive") && reason.trim().length < 3) return setError("Give a short reason (at least 3 characters)");
    if (action === "deadline" && !deadline) return setError("Pick the new date");
    if (action === "tag" && !tag.trim()) return setError("Type a tag");
    setBusy(true);
    try {
      const r = await api.coreTasks.bulk({ ids, action, status: action === "status" ? status : undefined, deadline: action === "deadline" ? deadline : undefined, priority: action === "priority" ? (priority as "normal") : undefined, tag: action === "tag" ? tag.trim() : undefined, reason: reason.trim() || undefined });
      onDone(r.message, r.undo);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <ActionDialog
      open
      title={`${title} (${ids.length})`}
      onClose={onClose}
      testId="bulk-dialog"
      footer={
        <>
          <button type="button" className={`px-4 py-2 text-sm font-medium text-ivory disabled:opacity-40 ${action === "archive" ? "bg-red" : "bg-charcoal"}`} disabled={busy} onClick={submit}>
            {busy ? "Saving…" : "Apply"}
          </button>
          <button type="button" className="border border-border px-3 py-2 text-sm" onClick={onClose}>
            Cancel
          </button>
        </>
      }
    >
      {action === "status" && (
        <Field label="New status" required hint="To mark tasks blocked, do it one by one: each needs its own reason.">
          <select className={inputCls} value={status} onChange={(e) => setStatus(e.target.value as TaskStatus)} aria-label="New status">
            {(["todo", "in_progress", "waiting", "done"] as TaskStatus[]).map((s) => (
              <option key={s} value={s}>
                {taskStatusLabels[s]}
              </option>
            ))}
          </select>
        </Field>
      )}
      {action === "deadline" && (
        <Field label="New deadline" required>
          <input className={inputCls} type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} aria-label="New deadline" />
        </Field>
      )}
      {action === "priority" && (
        <Field label="Priority" required>
          <select className={inputCls} value={priority} onChange={(e) => setPriority(e.target.value)} aria-label="Priority">
            <option value="low">Low</option>
            <option value="normal">Normal</option>
            <option value="high">High</option>
            <option value="urgent">Urgent</option>
          </select>
        </Field>
      )}
      {action === "tag" && (
        <Field label="Tag" required>
          <input className={inputCls} value={tag} onChange={(e) => setTag(e.target.value)} maxLength={40} aria-label="Tag" />
        </Field>
      )}
      {(action === "deadline" || action === "archive") && (
        <Field label="Reason" required>
          <TextArea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} aria-label="Reason" />
        </Field>
      )}
      {error && (
        <p role="alert" className="text-sm text-red">
          {error}
        </p>
      )}
    </ActionDialog>
  );
}
