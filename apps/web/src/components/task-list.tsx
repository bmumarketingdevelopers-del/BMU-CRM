"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { taskStatusLabels, type TaskStatus, type TaskView, type UpdateTask } from "@bmu/shared";
import { Badge, Button, Input } from "@/components/ui";
import { api } from "@/lib/api";

const day = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });
const statusTone = (s: string) => (s === "done" ? "green" : s === "blocked" ? "red" : s === "waiting" ? "amber" : s === "in_progress" ? "dark" : "neutral");

export const taskHref = (t: TaskView) => (t.deliverable ? `/team/deliverables/${t.deliverable.id}` : t.engagementId ? `/team/projects/${t.engagementId}` : undefined);

/**
 * One task with its quick actions. Used by My Day, the task list/board and deliverable pages.
 * v11 options: `menu` (the ⋯ RowMenu), `href` (link the title to the task page), `onBlock` (open the Blocked details
 * dialog instead of the one-line reason), `onStatus` (save status changes through the task actions API).
 */
export function TaskCard({ t, compact = false, onChanged, menu, href: hrefOverride, onBlock, onStatus }: { t: TaskView; compact?: boolean; onChanged: (t: TaskView) => void; menu?: ReactNode; href?: string; onBlock?: () => void; onStatus?: (status: TaskStatus) => Promise<TaskView> }) {
  const [blocking, setBlocking] = useState(false);
  const [logging, setLogging] = useState(false);
  const [hours, setHours] = useState("1");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const manual = t.kind === "work" || t.kind === "planning";
  const href = hrefOverride ?? taskHref(t);

  async function update(input: UpdateTask) {
    setBusy(true);
    setError(undefined);
    try {
      onChanged(onStatus && input.status && !input.logMinutes && input.status !== "blocked" ? await onStatus(input.status) : await api.tasks.update(t.id, input));
      setBlocking(false);
      setLogging(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`border border-l-2 border-border bg-surface-raised px-4 py-3 text-sm transition-colors hover:bg-canvas/30 ${t.overdue ? "border-l-red" : t.status === "blocked" ? "border-l-amber" : "border-l-border"}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          {href ? (
            <Link href={href} className="font-medium hover:underline">
              {t.title}
            </Link>
          ) : (
            <span className="font-medium">{t.title}</span>
          )}
          {!compact && t.client && <p className="text-xs text-ink-muted">{t.client.name}</p>}
        </div>
        <span className="flex shrink-0 items-start gap-1">
          <Badge tone={statusTone(t.status)}>{t.kind === "qc" && t.status === "todo" ? "QC" : t.kind === "client_review" && t.status === "in_progress" ? "With client" : taskStatusLabels[t.status]}</Badge>
          {menu}
        </span>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-ink-muted">
        {t.owner && <span>{t.owner.name}</span>}
        {t.deadline && <span className={t.overdue ? "font-semibold text-red" : ""}>Due {day.format(new Date(t.deadline))}{t.overdue ? " (late)" : ""}</span>}
        {t.timeLoggedMin > 0 && <span>{Math.round((t.timeLoggedMin / 60) * 10) / 10}h logged</span>}
        {!t.ready && !["done", "cancelled"].includes(t.status) && <span>Waiting on previous step</span>}
      </div>
      {t.status === "blocked" && t.blockedReason && <p className="mt-1 text-xs text-red">Blocked: {t.blockedReason}</p>}
      {error && <p className="mt-1 text-xs text-red">{error}</p>}

      {manual && !["done", "cancelled"].includes(t.status) && !blocking && (
        <div className="mt-2 flex flex-wrap gap-1">
          {(t.status === "todo" || t.status === "blocked" || t.status === "waiting") && t.ready && (
            <Button variant="secondary" className="px-2 py-1 text-xs" disabled={busy} onClick={() => update({ status: "in_progress" })}>
              {t.status === "todo" ? "Start" : "Resume"}
            </Button>
          )}
          {t.status === "in_progress" && (
            <Button className="px-2 py-1 text-xs" disabled={busy} onClick={() => update({ status: "done" })}>
              Mark done
            </Button>
          )}
          {t.status !== "blocked" && (
            <Button variant="ghost" className="px-2 py-1 text-xs" disabled={busy} onClick={() => (onBlock ? onBlock() : setBlocking(true))}>
              Blocked
            </Button>
          )}
          <Button variant="ghost" className="px-2 py-1 text-xs" disabled={busy} onClick={() => update({ logMinutes: 30 })}>
            +30 min
          </Button>
          <Button variant="ghost" className="px-2 py-1 text-xs" disabled={busy} onClick={() => setLogging(true)}>
            Log time
          </Button>
        </div>
      )}
      {t.kind === "qc" && t.status === "todo" && t.ready && href && (
        <Link href={href} className="mt-2 inline-block bg-green px-2 py-1 text-xs font-semibold text-charcoal">
          Open QC checklist
        </Link>
      )}
      {logging && (
        <form
          className="mt-2 flex flex-wrap items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            const minutes = Math.round(Number(hours) * 60);
            if (!minutes || minutes < 1) return setError("Enter the time spent, e.g. 1.5 hours");
            update({ logMinutes: minutes });
          }}
        >
          <Input className="w-24 py-1 text-xs" type="number" step="0.25" min="0.25" max="12" value={hours} onChange={(e) => setHours(e.target.value)} aria-label="Hours spent" autoFocus />
          <span className="text-xs text-ink-muted">hours</span>
          <Button type="submit" className="px-2 py-1 text-xs" disabled={busy}>
            Log
          </Button>
          <Button type="button" variant="ghost" className="px-2 py-1 text-xs" onClick={() => setLogging(false)}>
            Cancel
          </Button>
        </form>
      )}
      {blocking && (
        <form
          className="mt-2 flex gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            update({ status: "blocked", blockedReason: reason });
          }}
        >
          <Input className="py-1 text-xs" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why? (required)" minLength={3} required autoFocus />
          <Button type="submit" className="px-2 py-1 text-xs" disabled={busy}>
            Save
          </Button>
          <Button type="button" variant="ghost" className="px-2 py-1 text-xs" onClick={() => setBlocking(false)}>
            Cancel
          </Button>
        </form>
      )}
    </div>
  );
}

export function TaskList({ tasks, compact = false, onChanged }: { tasks: TaskView[]; compact?: boolean; onChanged?: () => void }) {
  const [rows, setRows] = useState(tasks);
  const [source, setSource] = useState(tasks);
  if (source !== tasks) {
    setSource(tasks);
    setRows(tasks);
  }
  if (rows.length === 0) return <p className="py-6 text-center text-sm text-ink-muted">Nothing here.</p>;
  return (
    <div className="grid gap-2">
      {rows.map((t) => (
        <TaskCard
          key={t.id}
          t={t}
          compact={compact}
          onChanged={(u) => {
            setRows((r) => r.map((x) => (x.id === u.id ? u : x)));
            onChanged?.();
          }}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Board with drag and drop

export const TASK_BOARD_COLUMNS: { title: string; statuses: TaskStatus[]; target: TaskStatus }[] = [
  { title: "To do", statuses: ["todo"], target: "todo" },
  { title: "In progress", statuses: ["in_progress", "in_qc"], target: "in_progress" },
  { title: "Blocked or waiting", statuses: ["blocked", "waiting"], target: "blocked" },
  { title: "Done", statuses: ["done"], target: "done" },
];

/** Work and planning tasks can be dragged; QC and client review steps move on their own. */
const draggableTask = (t: TaskView) => (t.kind === "work" || t.kind === "planning") && !["done", "cancelled"].includes(t.status);

/**
 * Task board: drag a card between To do / In progress / Blocked / Done. Moving to Blocked asks for the reason.
 * The move shows at once and rolls back with the server's message if a rule says no (e.g. waiting on a previous step).
 * The buttons on each card still work for keyboard users.
 */
export function TaskBoard({
  tasks,
  onChanged,
  cardMenu,
  cardHref,
  onAdd,
  onBlock,
  onMove,
}: {
  tasks: TaskView[];
  onChanged: (t: TaskView) => void;
  /** v11: ⋯ menu per card, title link, "+ Add" per column, Blocked details dialog, status saves through task actions. */
  cardMenu?: (t: TaskView) => ReactNode;
  cardHref?: (t: TaskView) => string;
  onAdd?: (column: TaskStatus) => void;
  onBlock?: (t: TaskView) => void;
  onMove?: (t: TaskView, status: TaskStatus) => Promise<TaskView>;
}) {
  const [moved, setMoved] = useState<Record<string, TaskView>>({});
  const [dragging, setDragging] = useState<string>();
  const [over, setOver] = useState<TaskStatus>();
  const [error, setError] = useState<string>();
  const rows = tasks.map((t) => moved[t.id] ?? t);

  async function move(t: TaskView, status: TaskStatus) {
    setError(undefined);
    let blockedReason: string | undefined;
    if (status === "blocked" && onBlock) return onBlock(t);
    if (status === "blocked") {
      blockedReason = window.prompt(`Why is "${t.title}" blocked? (at least 3 characters)`)?.trim() || undefined;
      if (!blockedReason) return;
    }
    setMoved((m) => ({ ...m, [t.id]: { ...t, status, blockedReason: blockedReason ?? null } }));
    try {
      const saved = onMove && status !== "blocked" ? await onMove(t, status) : await api.tasks.update(t.id, { status, blockedReason });
      setMoved((m) => {
        const rest = { ...m };
        delete rest[t.id];
        return rest;
      });
      onChanged(saved);
    } catch (e) {
      setMoved((m) => {
        const rest = { ...m };
        delete rest[t.id];
        return rest;
      });
      setError(`${t.title}: ${(e as Error).message}`);
    }
  }

  return (
    <>
      {error && (
        <p role="alert" className="mb-4 flex items-start justify-between gap-3 border border-red bg-red/10 px-4 py-2 text-sm">
          <span>{error}</span>
          <button type="button" className="text-ink-muted hover:text-ink" onClick={() => setError(undefined)} aria-label="Dismiss">
            ✕
          </button>
        </p>
      )}
      <p className="mb-3 text-xs text-ink-muted">Drag your work tasks between columns. QC and client review steps move on their own when the checklist or the client decides.</p>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {TASK_BOARD_COLUMNS.map((c) => {
          const items = rows.filter((t) => c.statuses.includes(t.status));
          const from = rows.find((t) => t.id === dragging);
          const target = over === c.target && from && !c.statuses.includes(from.status);
          return (
            <section
              key={c.title}
              aria-label={`${c.title} column`}
              onDragOver={(e) => {
                if (!dragging) return;
                e.preventDefault();
                if (over !== c.target) setOver(c.target);
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(undefined);
              }}
              onDrop={(e) => {
                e.preventDefault();
                setOver(undefined);
                const id = e.dataTransfer.getData("text/plain") || dragging;
                setDragging(undefined);
                const t = rows.find((x) => x.id === id);
                if (t && !c.statuses.includes(t.status)) move(t, c.target);
              }}
              className={`bg-canvas/60 p-2 transition-colors ${target ? "bg-green/10 outline-1 outline-dashed outline-green" : ""}`}
            >
              <h2 className="mb-2 flex items-center justify-between px-1 text-sm font-semibold">
                <span>
                  {c.title} <span className="font-normal text-ink-muted">{items.length}</span>
                </span>
                {onAdd && (c.target === "todo" || c.target === "in_progress") && (
                  <button type="button" onClick={() => onAdd(c.target)} className="px-1 text-xs font-normal text-ink-muted hover:text-ink" aria-label={`Add a task to ${c.title}`}>
                    + Add
                  </button>
                )}
              </h2>
              <div className="grid min-h-16 content-start gap-2">
                {items.map((t) => (
                  <div
                    key={t.id}
                    draggable={draggableTask(t)}
                    onDragStart={(e) => {
                      e.dataTransfer.setData("text/plain", t.id);
                      e.dataTransfer.effectAllowed = "move";
                      setDragging(t.id);
                    }}
                    onDragEnd={() => {
                      setDragging(undefined);
                      setOver(undefined);
                    }}
                    data-task={t.id}
                    className={`${draggableTask(t) ? "cursor-grab active:cursor-grabbing" : ""} ${dragging === t.id ? "opacity-50" : ""}`}
                  >
                    <TaskCard t={t} onChanged={onChanged} menu={cardMenu?.(t)} href={cardHref?.(t)} onStatus={onMove ? (s) => onMove(t, s) : undefined} />
                  </div>
                ))}
                {items.length === 0 && <p className="py-4 text-center text-xs text-ink-muted">{dragging ? "Drop here" : "Nothing here"}</p>}
              </div>
            </section>
          );
        })}
      </div>
    </>
  );
}
