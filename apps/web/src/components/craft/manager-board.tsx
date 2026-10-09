"use client";
// v10 craft: the manager's assignment board. Drag a task onto a team member (or use the select / keyboard
// fallback), bulk reassign, adjust deadline and priority, and add ad-hoc tasks.
import { useMemo, useState } from "react";
import Link from "next/link";
import { CRAFT_PRIORITIES, craftPriorityLabels, craftSpecialtyLabel, type CraftBoardTask, type CraftManagerView, type CraftMember, type CraftPriority } from "@bmu/shared";
import { Empty, Meter, Panel } from "@/components/dash";
import { Badge, Button, Input, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { ErrorLine, dueLabel, useAction } from "./craft-bits";
import { useActionsMaybe } from "@/components/actions/actions-provider";

type Due = "all" | "overdue" | "week" | "next" | "none";
const istDay = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);
const priorityTone = (p: CraftPriority) => (p === "urgent" ? "red" : p === "high" ? "amber" : "neutral");
const loadTone = (m: CraftMember) => (m.loadPct > 100 ? "bad" : m.loadPct >= 80 ? "warn" : "default");

function dueMatch(t: CraftBoardTask, due: Due) {
  if (due === "all") return true;
  if (due === "none") return !t.deadline;
  if (!t.deadline) return false;
  const days = (new Date(t.deadline).getTime() - Date.now()) / 86_400_000;
  if (due === "overdue") return t.overdue;
  if (due === "week") return days >= 0 && days < 7;
  return days >= 7 && days < 14;
}

export function AssignmentBoard({ v, onChanged }: { v: CraftManagerView; onChanged: () => void }) {
  const [client, setClient] = useState("");
  const [service, setService] = useState("");
  const [specialty, setSpecialty] = useState("");
  const [due, setDue] = useState<Due>("all");
  const [show, setShow] = useState<"unassigned" | "all">("unassigned");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkTo, setBulkTo] = useState("");
  const [dragging, setDragging] = useState<string>();
  const [over, setOver] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [done, setDone] = useState<string>();
  const { busy, error, run } = useAction();

  const tasks = useMemo(
    () =>
      v.board.filter(
        (t) =>
          (show === "all" || !t.owner) &&
          (!client || t.client?.id === client) &&
          (!service || t.service?.id === service) &&
          (!specialty || t.specialty === specialty) &&
          dueMatch(t, due),
      ),
    [v.board, show, client, service, specialty, due],
  );
  const unassigned = v.board.filter((t) => !t.owner).length;
  const byId = new Map(v.board.map((t) => [t.id, t]));
  const memberName = (id: string) => v.members.find((m) => m.id === id)?.name ?? "them";

  async function assign(taskId: string, ownerId: string) {
    const t = byId.get(taskId);
    const r = await run(taskId, () => api.craftManager.assign(taskId, { ownerId }));
    if (r) {
      setDone(`${t?.title ?? "Task"} → ${memberName(ownerId)}. They have been notified.`);
      onChanged();
    }
  }

  return (
    <Panel
      title="Assign work"
      subtitle={`Open tasks for ${v.scopeLabel.toLowerCase()}. Drag a task onto a person, or pick someone from the list. ${unassigned ? `${unassigned} without an owner.` : "Everything has an owner."}`}
      action={
        <Button className="px-3 py-1.5 text-xs" onClick={() => setAdding((a) => !a)} data-new-task>
          {adding ? "Close" : "+ New task"}
        </Button>
      }
    >
      {adding && (
        <AdhocTask
          v={v}
          onDone={(msg) => {
            setAdding(false);
            setDone(msg);
            onChanged();
          }}
        />
      )}

      <div className="mb-4 flex flex-wrap items-center gap-2" data-board-filters>
        <div className="flex border border-border text-xs">
          {(["unassigned", "all"] as const).map((k) => (
            <button key={k} onClick={() => setShow(k)} className={`px-3 py-1.5 ${show === k ? "bg-charcoal text-ivory" : "text-ink-muted hover:text-ink"}`}>
              {k === "unassigned" ? `Unassigned (${unassigned})` : `All open (${v.board.length})`}
            </button>
          ))}
        </div>
        <Select aria-label="Filter by client" value={client} onChange={(e) => setClient(e.target.value)}>
          <option value="">All clients</option>
          {v.filters.clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        <Select aria-label="Filter by service" value={service} onChange={(e) => setService(e.target.value)}>
          <option value="">All services</option>
          {v.filters.services.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
        <Select aria-label="Filter by specialty" value={specialty} onChange={(e) => setSpecialty(e.target.value)}>
          <option value="">Any specialty</option>
          {v.filters.specialties.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </Select>
        <Select aria-label="Filter by due date" value={due} onChange={(e) => setDue(e.target.value as Due)}>
          <option value="all">Any due date</option>
          <option value="overdue">Overdue</option>
          <option value="week">Due in 7 days</option>
          <option value="next">Due in 7–14 days</option>
          <option value="none">No due date</option>
        </Select>
      </div>

      {selected.size > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 border border-ink bg-canvas/50 px-3 py-2 text-sm" data-bulk>
          <span className="font-medium">{selected.size} selected</span>
          <Select aria-label="Reassign selected to" value={bulkTo} onChange={(e) => setBulkTo(e.target.value)}>
            <option value="">Assign to…</option>
            {v.members.map((m) => (
              <option key={m.id} value={m.id} disabled={m.onLeaveToday}>
                {m.name} · {m.specialtyLabel} · {m.loadPct}%{m.onLeaveToday ? " · on leave" : ""}
              </option>
            ))}
          </Select>
          <Button
            className="px-3 py-1.5 text-xs"
            disabled={!bulkTo || !!busy}
            onClick={async () => {
              const r = await run("bulk", () => api.craftManager.bulkAssign({ taskIds: [...selected], ownerId: bulkTo }));
              if (r) {
                setDone(`${r.assigned} task${r.assigned === 1 ? "" : "s"} → ${memberName(bulkTo)}.`);
                setSelected(new Set());
                setBulkTo("");
                onChanged();
              }
            }}
          >
            {busy === "bulk" ? "Assigning…" : "Assign selected"}
          </Button>
          <button className="text-xs text-ink-muted underline" onClick={() => setSelected(new Set())}>
            Clear
          </button>
        </div>
      )}
      {done && (
        <p className="mb-3 border-l-2 border-green bg-green/10 px-3 py-2 text-sm" role="status" data-assign-done>
          {done}
        </p>
      )}
      <ErrorLine error={error} />

      <div className="grid gap-4 lg:grid-cols-[1.5fr_1fr] [&>*]:min-w-0">
        <div>
          {tasks.length ? (
            <ul className="space-y-2" data-board>
              {tasks.slice(0, 60).map((t) => (
                <TaskCard
                  key={t.id}
                  t={t}
                  v={v}
                  busy={busy === t.id}
                  checked={selected.has(t.id)}
                  onCheck={(on) => setSelected((s) => (on ? new Set(s).add(t.id) : new Set([...s].filter((x) => x !== t.id))))}
                  onAssign={(ownerId) => assign(t.id, ownerId)}
                  onDragStart={() => setDragging(t.id)}
                  onDragEnd={() => (setDragging(undefined), setOver(undefined))}
                  onChanged={onChanged}
                />
              ))}
              {tasks.length > 60 && <li className="text-xs text-ink-muted">Showing 60 of {tasks.length}. Narrow the filters to see the rest.</li>}
            </ul>
          ) : (
            <Empty>{show === "unassigned" ? "Every task has an owner. Switch to “All open” to reassign work." : "No tasks match these filters."}</Empty>
          )}
        </div>

        <div className="lg:sticky lg:top-4 lg:self-start">
          <p className="mb-2 text-[11px] uppercase tracking-[0.1em] text-ink-muted">Team · load this week {dragging ? "· drop on a person" : ""}</p>
          <ul className="grid gap-2" data-members>
            {v.members.map((m) => {
              const t = dragging ? byId.get(dragging) : undefined;
              const blocked = !!t && (t.cannotAssignTo.includes(m.id) || t.owner?.id === m.id);
              const best = !!t && t.suggestion?.userId === m.id;
              return (
                <li
                  key={m.id}
                  data-member={m.id}
                  data-member-name={m.name}
                  onDragOver={(e) => {
                    if (!dragging || blocked) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    setOver(m.id);
                  }}
                  onDragLeave={() => setOver((o) => (o === m.id ? undefined : o))}
                  onDrop={(e) => {
                    e.preventDefault();
                    const id = e.dataTransfer.getData("text/plain") || dragging;
                    setOver(undefined);
                    setDragging(undefined);
                    if (id && !blocked) void assign(id, m.id);
                  }}
                  className={`border bg-surface-raised p-3 transition ${over === m.id ? "border-ink bg-canvas" : best ? "border-green" : "border-border"} ${blocked ? "opacity-40" : ""}`}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <Link href={m.href} className="truncate text-sm font-medium hover:underline">
                      {m.name}
                    </Link>
                    <span className="shrink-0 text-xs tabular-nums text-ink-muted">
                      {m.hoursThisWeek}h / {m.capacityHours}h
                    </span>
                  </div>
                  <p className="mb-1.5 flex flex-wrap items-center gap-1.5 text-xs text-ink-muted">
                    {m.specialtyLabel}
                    {m.onLeaveToday && <Badge tone="amber">On leave today</Badge>}
                    {!m.onLeaveToday && m.leaveDaysThisWeek > 0 && <span>· {m.leaveDaysThisWeek}d leave this week</span>}
                    {best && <Badge tone="green">Best fit</Badge>}
                  </p>
                  <Meter value={Math.min(m.loadPct, 150)} tone={loadTone(m)} label={`${m.name} load`} />
                  <p className="mt-1 text-[11px] text-ink-muted">
                    {m.open} open · {m.dueThisWeek} due this week{m.overdue ? ` · ${m.overdue} overdue` : ""}
                  </p>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </Panel>
  );
}

function TaskCard({
  t,
  v,
  busy,
  checked,
  onCheck,
  onAssign,
  onDragStart,
  onDragEnd,
  onChanged,
}: {
  t: CraftBoardTask;
  v: CraftManagerView;
  busy: boolean;
  checked: boolean;
  onCheck: (on: boolean) => void;
  onAssign: (ownerId: string) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const actions = useActionsMaybe();
  const [deadline, setDeadline] = useState(t.deadline ? istDay(new Date(t.deadline)) : "");
  const [priority, setPriority] = useState<CraftPriority>(t.priority);
  const { busy: saving, error, run } = useAction();
  const spec = t.specialty ? craftSpecialtyLabel(t.specialty) : null;
  return (
    <li
      draggable={!busy}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", t.id);
        e.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      data-task={t.id}
      data-task-title={t.title}
      className={`cursor-grab border bg-surface-raised p-3 active:cursor-grabbing ${t.owner ? "border-border" : "border-l-2 border-l-charcoal border-y-border border-r-border"} ${busy ? "opacity-50" : ""}`}
    >
      <div className="flex items-start gap-2.5">
        <input type="checkbox" className="mt-1" aria-label={`Select ${t.title}`} checked={checked} onChange={(e) => onCheck(e.target.checked)} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3">
            <Link href={t.href} className="text-sm font-medium hover:underline" draggable={false}>
              {t.title}
            </Link>
            <span className={`shrink-0 text-xs ${t.overdue ? "font-medium text-red" : "text-ink-muted"}`}>{dueLabel(t.deadline, t.overdue)}</span>
          </div>
          <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-ink-muted">
            {t.client ? t.client.name : "Internal"}
            {t.service && <span>· {t.service.name}</span>}
            {spec && <Badge tone="dark">{spec}</Badge>}
            {t.priority !== "normal" && <Badge tone={priorityTone(t.priority)}>{craftPriorityLabels[t.priority]}</Badge>}
            {t.kind === "qc" && <Badge>QC</Badge>}
            {t.kind === "client_review" && <Badge>Client review</Badge>}
            {t.status === "blocked" && <Badge tone="red">Blocked</Badge>}
          </p>
          {t.waitingOn.length > 0 && <p className="mt-1 text-[11px] text-ink-muted">Waiting on: {t.waitingOn.join(", ")}</p>}
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
            <span className="text-ink-muted">{t.owner ? `With ${t.owner.name}` : "No owner"}</span>
            {t.suggestion ? (
              <button
                className="border border-green px-2 py-0.5 hover:bg-green/10"
                title={t.suggestion.reason}
                disabled={busy}
                onClick={() => onAssign(t.suggestion!.userId)}
                data-suggest={t.suggestion.userId}
              >
                Suggest: {t.suggestion.name}
              </button>
            ) : (
              spec && !t.owner && <span className="text-ink-muted">No {spec.toLowerCase()} free today</span>
            )}
            <Select
              aria-label={`Assign ${t.title} to`}
              className="py-0.5 text-xs"
              value=""
              disabled={busy}
              onChange={(e) => e.target.value && onAssign(e.target.value)}
              data-assign-select
            >
              <option value="">{t.owner ? "Reassign to…" : "Assign to…"}</option>
              {v.members
                .filter((m) => m.id !== t.owner?.id && !t.cannotAssignTo.includes(m.id))
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} · {m.specialtyLabel} · {m.loadPct}%{m.onLeaveToday ? " · on leave" : ""}
                  </option>
                ))}
            </Select>
            {actions && (
              <button className="text-ink-muted underline-offset-2 hover:text-ink hover:underline" disabled={busy} onClick={() => actions.openReassign({ type: t.kind === "qc" ? "qc" : "task", ids: [t.id], title: `${t.owner ? "Reassign" : "Assign"} “${t.title}”`, onDone: onChanged })}>
                {t.owner ? "Reassign…" : "Assign…"}
              </button>
            )}
            <button className="text-ink-muted underline-offset-2 hover:text-ink hover:underline" onClick={() => setEditing((e) => !e)}>
              {editing ? "Close" : "Deadline & priority"}
            </button>
          </div>
          {editing && (
            <form
              className="mt-2 flex flex-wrap items-end gap-2"
              onSubmit={async (e) => {
                e.preventDefault();
                const r = await run("save", () => api.craftManager.updateTask(t.id, { deadline: deadline || null, priority }));
                if (r) {
                  setEditing(false);
                  onChanged();
                }
              }}
            >
              <label className="text-xs">
                <span className="block text-ink-muted">Due</span>
                <Input type="date" className="py-1 text-xs" value={deadline} onChange={(e) => setDeadline(e.target.value)} aria-label="Due date" />
              </label>
              <label className="text-xs">
                <span className="block text-ink-muted">Priority</span>
                <Select className="py-1 text-xs" value={priority} onChange={(e) => setPriority(e.target.value as CraftPriority)} aria-label="Priority">
                  {CRAFT_PRIORITIES.map((p) => (
                    <option key={p} value={p}>
                      {craftPriorityLabels[p]}
                    </option>
                  ))}
                </Select>
              </label>
              <Button type="submit" className="px-3 py-1 text-xs" disabled={!!saving}>
                {saving ? "Saving…" : "Save"}
              </Button>
            </form>
          )}
          <ErrorLine error={error} />
        </div>
      </div>
    </li>
  );
}

/** Ad-hoc task: something that came up on a call and is not part of a flow. */
function AdhocTask({ v, onDone }: { v: CraftManagerView; onDone: (msg: string) => void }) {
  const [title, setTitle] = useState("");
  const [engagementId, setEngagementId] = useState(v.engagements[0]?.id ?? "");
  const [deliverableId, setDeliverableId] = useState("");
  const [specialty, setSpecialty] = useState("");
  const [ownerId, setOwnerId] = useState("");
  const [deadline, setDeadline] = useState("");
  const [priority, setPriority] = useState<CraftPriority>("normal");
  const { busy, error, run } = useAction();
  const dels = v.deliverables.filter((d) => d.engagementId === engagementId);
  const people = specialty ? [...v.members].sort((a, b) => Number(b.specialty === specialty) - Number(a.specialty === specialty)) : v.members;
  return (
    <form
      className="mb-5 grid gap-3 border border-border bg-canvas/40 p-4 md:grid-cols-6"
      data-adhoc
      onSubmit={async (e) => {
        e.preventDefault();
        const r = await run("create", () =>
          api.craftManager.createTask({
            title,
            engagementId: engagementId || undefined,
            deliverableId: deliverableId || undefined,
            specialty: specialty || undefined,
            ownerId: ownerId || null,
            deadline: deadline || null,
            priority,
          }),
        );
        if (r) onDone(`Created “${r.title}”${r.owner ? ` for ${r.owner.name}` : ""}.`);
      }}
    >
      <label className="text-xs md:col-span-6">
        <span className="mb-1 block text-ink-muted">Task</span>
        <Input required minLength={3} maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Resize the Diwali banner for WhatsApp" aria-label="Task title" />
      </label>
      <label className="text-xs md:col-span-2">
        <span className="mb-1 block text-ink-muted">Client work</span>
        <Select className="w-full" value={engagementId} onChange={(e) => (setEngagementId(e.target.value), setDeliverableId(""))} aria-label="Engagement">
          {v.scope !== "own_clients" && <option value="">Internal (no client)</option>}
          {v.engagements.map((e) => (
            <option key={e.id} value={e.id}>
              {e.label}
            </option>
          ))}
        </Select>
      </label>
      <label className="text-xs md:col-span-2">
        <span className="mb-1 block text-ink-muted">Deliverable (optional)</span>
        <Select className="w-full" value={deliverableId} onChange={(e) => setDeliverableId(e.target.value)} aria-label="Deliverable" disabled={!dels.length}>
          <option value="">None</option>
          {dels.map((d) => (
            <option key={d.id} value={d.id}>
              {d.title}
            </option>
          ))}
        </Select>
      </label>
      <label className="text-xs md:col-span-2">
        <span className="mb-1 block text-ink-muted">Specialty</span>
        <Select className="w-full" value={specialty} onChange={(e) => setSpecialty(e.target.value)} aria-label="Specialty">
          <option value="">Anyone</option>
          {v.filters.specialties.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </Select>
      </label>
      <label className="text-xs md:col-span-2">
        <span className="mb-1 block text-ink-muted">Assignee</span>
        <Select className="w-full" value={ownerId} onChange={(e) => setOwnerId(e.target.value)} aria-label="Assignee">
          <option value="">Leave unassigned</option>
          {people.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name} · {m.specialtyLabel} · {m.loadPct}%{m.onLeaveToday ? " · on leave" : ""}
            </option>
          ))}
        </Select>
      </label>
      <label className="text-xs md:col-span-2">
        <span className="mb-1 block text-ink-muted">Due</span>
        <Input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} aria-label="Due date" />
      </label>
      <label className="text-xs">
        <span className="mb-1 block text-ink-muted">Priority</span>
        <Select className="w-full" value={priority} onChange={(e) => setPriority(e.target.value as CraftPriority)} aria-label="Priority">
          {CRAFT_PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {craftPriorityLabels[p]}
            </option>
          ))}
        </Select>
      </label>
      <div className="flex items-end">
        <Button type="submit" className="w-full" disabled={!!busy}>
          {busy ? "Adding…" : "Add task"}
        </Button>
      </div>
      <div className="md:col-span-6">
        <ErrorLine error={error} />
      </div>
    </form>
  );
}
