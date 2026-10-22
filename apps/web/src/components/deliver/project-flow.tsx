"use client";

// v40/v41 project flow on the project page, one card per department:
// 1. Client Manager: send the requirements (note + documents) to one or more Department Heads.
// 2. Department Head: give the finish date; the Client Manager shares it with the client.
// 3. Department Head: give tasks to the team (what, who, hours, deadline), including the plan's steps. Only these
//    hours fill each person's 45h week on Workload.
// 4. Department Head: share each big finished part with the client (demo link or files); the client approves it or
//    asks for changes (a task for the head).
import Link from "next/link";
import { useState } from "react";
import { estimateStatusLabels, milestoneStatusLabels, type EstimateInboxRow, type MilestoneFile, type ProjectEstimateRow, type ProjectFlowView, type ProjectTaskRow, type SentFile } from "@bmu/shared";
import { Panel } from "@/components/dash";
import { PendingFiles, SendFileControls } from "@/components/sent-files";
import { Badge, Button, Input, LoadState, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

const day = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" });
const fmt = (iso: string) => day.format(new Date(iso.length === 10 ? `${iso}T00:00:00+05:30` : iso));
const estTone = { waiting: "amber", estimated: "neutral", shared: "green" } as const;
const msTone = { shared: "amber", approved: "green", changes_requested: "red" } as const;
const today = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const statusLabel: Record<string, string> = { todo: "To do", in_progress: "In progress", blocked: "Blocked", waiting: "Waiting", in_qc: "In QC", done: "Done" };
const h3 = "text-xs font-semibold uppercase tracking-[0.12em] text-ink-muted";

type Run = (fn: () => Promise<ProjectFlowView>, ok?: string) => Promise<boolean>;
type Person = ProjectFlowView["teams"][number]["people"][number];

export function MilestoneFiles({ files }: { files: MilestoneFile[] }) {
  return (
    <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs">
      {files.map((f) => (
        <li key={f.id}>
          <a href={f.url} target="_blank" rel="noreferrer noopener" className="underline">
            {f.kind === "link" ? "🔗" : "📎"} {f.name}
          </a>
        </li>
      ))}
    </ul>
  );
}

const personLabel = (p: Person) => `${p.name} · ${p.openHours}h open${p.onLeaveToday ? " · on leave today" : ""}`;

// ------------------------------------------------------------------------------------------------ 1. send

/** Client Manager: send the requirements to Department Heads. */
function SendToHeads({ v, run }: { v: ProjectFlowView; run: Run }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [docs, setDocs] = useState<SentFile[]>([]);
  const [open, setOpen] = useState(v.estimates.length === 0);
  if (!open)
    return (
      <Button variant="secondary" onClick={() => setOpen(true)} data-testid="flow-send-open">
        Send to more departments
      </Button>
    );
  const send = () =>
    run(async () => {
      const r = await api.projectFlow.requestEstimates(v.engagementId, { departmentIds: picked, note: note.trim() || undefined, fileIds: docs.map((d) => d.id) });
      setPicked([]);
      setNote("");
      setDocs([]);
      setOpen(false);
      return r;
    }, "Sent. The Department Heads were told and will give their finish date.");
  return (
    <div className="space-y-2 border border-border bg-canvas/30 p-3 text-sm" data-testid="estimate-request">
      <p className="font-medium">1 · Send the requirements to Department Heads</p>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {v.departments.map((d) => (
          <label key={d.id} className="flex items-center gap-1.5">
            <input type="checkbox" checked={picked.includes(d.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, d.id] : picked.filter((x) => x !== d.id))} aria-label={`Send to ${d.name}`} />
            {d.name}
            {d.head ? <span className="text-xs text-ink-muted">({d.head.name})</span> : null}
          </label>
        ))}
      </div>
      <textarea className="h-20 w-full border border-border bg-surface-raised p-2" value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} placeholder="What the client needs: scope, pages or deliverables, any deadline they mentioned." aria-label="What the client needs" />
      <PendingFiles files={docs} onRemove={(id) => setDocs((x) => x.filter((f) => f.id !== id))} />
      <SendFileControls label="📎 Attach requirement documents" limit={20 - docs.length} upload={(f) => api.projectFlow.stageBriefFile(v.engagementId, f)} addLink={(url) => api.projectFlow.stageBriefLink(v.engagementId, { url })} onAdded={(f) => setDocs((x) => [...x, f])} />
      <div className="flex gap-2">
        <Button disabled={!picked.length} onClick={send} data-testid="estimate-request-send">
          Send to {picked.length || ""} Department Head{picked.length === 1 ? "" : "s"}
        </Button>
        {v.estimates.length > 0 && (
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ 2. date

function GiveDate({ row, run }: { row: ProjectEstimateRow; run: Run }) {
  const [date, setDate] = useState(row.finishBy ?? "");
  const [note, setNote] = useState(row.headNote ?? "");
  const [open, setOpen] = useState(!row.finishBy);
  if (!open)
    return (
      <button type="button" className="text-xs underline" onClick={() => setOpen(true)} data-testid="estimate-open">
        Change date
      </button>
    );
  return (
    <div className="mt-1 grid gap-2 sm:grid-cols-[11rem_1fr_auto]" data-testid="estimate-form">
      <Input type="date" min={today()} value={date} onChange={(e) => setDate(e.target.value)} aria-label="Finish date" />
      <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} placeholder="Note for the Client Manager (what the date covers)" aria-label="Note" />
      <Button disabled={!date} onClick={async () => (await run(() => api.projectFlow.submitEstimate(row.id, { finishBy: date, note: note.trim() || undefined }), "Date sent to the Client Manager.")) && setOpen(false)} data-testid="estimate-save">
        Give date
      </Button>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ 3. tasks

/** Department Head: give an open task (e.g. a plan step) a person and hours. */
function AssignRow({ t, people, run }: { t: ProjectTaskRow; people: Person[]; run: Run }) {
  const [owner, setOwner] = useState(t.owner?.id ?? "");
  const [hours, setHours] = useState(t.hours ? String(t.hours) : "");
  return (
    <span className="mt-1 flex flex-wrap items-center gap-2">
      <Select value={owner} onChange={(e) => setOwner(e.target.value)} aria-label={`Person for ${t.title}`} data-testid="task-assign-person">
        <option value="">Pick someone</option>
        {people.map((p) => (
          <option key={p.id} value={p.id}>
            {personLabel(p)}
          </option>
        ))}
      </Select>
      <input type="number" min={0.5} max={500} step={0.5} className="w-20 border border-border bg-surface px-2 py-1.5 text-sm" value={hours} onChange={(e) => setHours(e.target.value)} placeholder="Hours" aria-label={`Hours for ${t.title}`} data-testid="task-assign-hours" />
      <Button variant="secondary" disabled={!owner || !Number(hours)} onClick={() => run(() => api.projectFlow.assignTask(t.id, { ownerId: owner, hours: Number(hours) }), "Saved. The person was told.")} data-testid="task-assign-save">
        Save
      </Button>
    </span>
  );
}

function AddTask({ engagementId, departmentId, people, run }: { engagementId: string; departmentId: string; people: Person[]; run: Run }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ title: "", ownerId: "", hours: "", deadline: "", note: "" });
  if (!open)
    return (
      <Button variant="secondary" onClick={() => setOpen(true)} data-testid="task-add-open">
        + Add task
      </Button>
    );
  const save = async () => {
    const ok = await run(() => api.projectFlow.addTask(engagementId, { departmentId, title: f.title.trim(), ownerId: f.ownerId, hours: Number(f.hours), deadline: f.deadline, note: f.note.trim() || undefined }), "Task added. The person was told.");
    if (ok) {
      setF({ title: "", ownerId: "", hours: "", deadline: "", note: "" });
      setOpen(false);
    }
  };
  return (
    <div className="mt-2 grid gap-2 border border-border bg-canvas/30 p-3 text-sm sm:grid-cols-2" data-testid="task-add">
      <Input className="sm:col-span-2" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} maxLength={200} placeholder="What to do, e.g. Build the login page" aria-label="What to do" />
      <Select value={f.ownerId} onChange={(e) => setF({ ...f, ownerId: e.target.value })} aria-label="Who">
        <option value="">Who does it</option>
        {people.map((p) => (
          <option key={p.id} value={p.id}>
            {personLabel(p)}
          </option>
        ))}
      </Select>
      <div className="grid grid-cols-2 gap-2">
        <input type="number" min={0.5} max={500} step={0.5} className="border border-border bg-surface px-2 py-1.5 text-sm" value={f.hours} onChange={(e) => setF({ ...f, hours: e.target.value })} placeholder="Hours" aria-label="Hours" />
        <Input type="date" min={today()} value={f.deadline} onChange={(e) => setF({ ...f, deadline: e.target.value })} aria-label="Deadline" />
      </div>
      <Input className="sm:col-span-2" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} maxLength={2000} placeholder="Details (optional)" aria-label="Details" />
      <div className="flex gap-2 sm:col-span-2">
        <Button disabled={!f.title.trim() || !f.ownerId || !Number(f.hours) || !f.deadline} onClick={save} data-testid="task-add-save">
          Add task
        </Button>
        <Button variant="secondary" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ 4. finished parts

function ShareMilestone({ engagementId, departmentId, run }: { engagementId: string; departmentId: string; run: Run }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [files, setFiles] = useState<SentFile[]>([]);
  if (!open)
    return (
      <Button variant="secondary" onClick={() => setOpen(true)} data-testid="milestone-open">
        Share a finished part
      </Button>
    );
  const share = async () => {
    const ok = await run(() => api.projectFlow.shareMilestone(engagementId, { departmentId, title: title.trim(), note: note.trim() || undefined, fileIds: files.map((f) => f.id) }), "Shared with the client.");
    if (ok) {
      setTitle("");
      setNote("");
      setFiles([]);
      setOpen(false);
    }
  };
  return (
    <div className="mt-2 space-y-2 border border-border bg-canvas/30 p-3 text-sm" data-testid="milestone-share">
      <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={160} placeholder="What is done, e.g. Login page, Product design, First draft of the video" aria-label="What is done" />
      <textarea className="h-16 w-full border border-border bg-surface-raised p-2" value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} placeholder="What the client should look at or try" aria-label="Note for the client" />
      <PendingFiles files={files} onRemove={(id) => setFiles((x) => x.filter((f) => f.id !== id))} />
      <SendFileControls label="📎 Add demo files" limit={20 - files.length} upload={(f) => api.projectFlow.stageFile(engagementId, f)} addLink={(url) => api.projectFlow.stageLink(engagementId, { url })} onAdded={(f) => setFiles((x) => [...x, f])} />
      <div className="flex gap-2">
        <Button disabled={title.trim().length < 3 || !files.length} onClick={share} data-testid="milestone-share-send">
          Share with the client
        </Button>
        <Button variant="secondary" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ department card

function DepartmentCard({ v, dept, run }: { v: ProjectFlowView; dept: { id: string; name: string }; run: Run }) {
  const est = v.estimates.find((e) => e.department.id === dept.id);
  const tasks = v.tasks.filter((t) => t.departmentId === dept.id);
  const parts = v.milestones.filter((m) => m.department?.id === dept.id);
  const people = v.teams.find((t) => t.departmentId === dept.id)?.people ?? [];
  const isHead = people.length > 0;
  const head = est?.head ?? v.departments.find((d) => d.id === dept.id)?.head ?? null;
  const open = tasks.filter((t) => t.status !== "done");
  const openHours = Math.round(open.reduce((s, t) => s + (t.hours ?? 0), 0) * 10) / 10;
  return (
    <section className="border border-border p-4" data-testid="flow-department">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-semibold">
          {dept.name}
          {head && <span className="ml-2 text-xs font-normal text-ink-muted">Head: {head.name}</span>}
        </h3>
        {est && <Badge tone={estTone[est.status]}>{est.status === "waiting" ? "Waiting for the date" : estimateStatusLabels[est.status]}</Badge>}
      </div>

      {est && (est.requestNote || est.docs.length > 0) && (
        <div className="mt-2 text-sm">
          <p className={h3}>Requirements{est.requestedBy ? ` · from ${est.requestedBy}` : ""}</p>
          {est.requestNote && <p className="mt-1 whitespace-pre-line">{est.requestNote}</p>}
          <MilestoneFiles files={est.docs} />
        </div>
      )}

      {est && (
        <div className="mt-3 text-sm">
          <p className={h3}>Finish date</p>
          {est.finishBy ? (
            <p className="mt-1">
              <strong>{fmt(est.finishBy)}</strong>
              {est.headNote && <span className="text-ink-muted"> · {est.headNote}</span>}
              {est.sharedAt && <span className="text-xs text-ink-muted"> · shared with the client {fmt(est.sharedAt)}</span>}
            </p>
          ) : (
            <p className="mt-1 text-ink-muted">{est.can.estimate ? "Read the requirements, talk to your team, then give the date." : "Waiting for the Department Head."}</p>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-3">
            {est.can.estimate && <GiveDate row={est} run={run} />}
            {est.can.share && est.status === "estimated" && (
              <Button variant="secondary" onClick={() => run(() => api.projectFlow.shareEstimates(v.engagementId, [est.id]), "Shared with the client.")} data-testid="estimate-share">
                Share with client
              </Button>
            )}
          </div>
        </div>
      )}

      <div className="mt-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className={h3}>
            Tasks{open.length ? ` · ${open.length} open · ${openHours}h` : ""}
          </p>
          {isHead && <AddTask engagementId={v.engagementId} departmentId={dept.id} people={people} run={run} />}
        </div>
        {tasks.length ? (
          <ul className="mt-1 divide-y divide-border text-sm" data-testid="flow-tasks">
            {tasks.map((t) => (
              <li key={t.id} className="py-2">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <Link href={`/team/tasks/${t.id}`} className="min-w-0 hover:underline">
                    {t.title}
                  </Link>
                  <span className="text-xs text-ink-muted">
                    {[t.owner?.name ?? "no one yet", t.hours ? `${t.hours}h` : "no hours", t.deadline ? `due ${fmt(t.deadline)}` : null, statusLabel[t.status] ?? t.status].filter(Boolean).join(" · ")}
                  </span>
                </div>
                {isHead && t.status !== "done" && (!t.owner || !t.hours) && <AssignRow t={t} people={people} run={run} />}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-sm text-ink-muted">{isHead ? "No tasks yet. Add one for each piece of work: who does it, hours and deadline." : "No tasks yet."}</p>
        )}
      </div>

      <div className="mt-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className={h3}>Finished parts shared with the client</p>
          {v.can.shareFor.some((d) => d.id === dept.id) && <ShareMilestone engagementId={v.engagementId} departmentId={dept.id} run={run} />}
        </div>
        {parts.length ? (
          <ul className="mt-1 divide-y divide-border text-sm" data-testid="milestones">
            {parts.map((m) => (
              <li key={m.id} className="py-2">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <span className="font-medium">{m.title}</span>
                    <span className="text-xs text-ink-muted"> · {fmt(m.sharedAt)}</span>
                    {m.note && <p className="text-xs text-ink-muted">{m.note}</p>}
                    <MilestoneFiles files={m.files} />
                    {m.clientComment && <p className="mt-1 border-l-2 border-border pl-2 text-xs">Client: {m.clientComment}</p>}
                    {m.changeTaskId && (
                      <Link href={`/team/tasks/${m.changeTaskId}`} className="text-xs underline">
                        Open the changes task
                      </Link>
                    )}
                  </div>
                  <Badge tone={msTone[m.status]}>{milestoneStatusLabels[m.status]}</Badge>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-sm text-ink-muted">When a big part is done (login page, product design, first video draft), share it here for the client to approve.</p>
        )}
      </div>
    </section>
  );
}

// ------------------------------------------------------------------------------------------------ panel

/** Project page: everything between the Client Manager, the Department Heads and the client, by department. */
export function ProjectFlowPanel({ engagementId }: { engagementId: string }) {
  const view = useLoad(() => api.projectFlow.get(engagementId), { live: ["Engagement", "Task"] });
  const [fresh, setFresh] = useState<ProjectFlowView>();
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();
  const v = fresh ?? view.data;
  if (!v) return view.error ? null : <LoadState loading={view.loading} error={view.error} />;
  const run: Run = async (fn, ok) => {
    setMsg(undefined);
    try {
      setFresh(await fn());
      if (ok) setMsg({ ok: true, text: ok });
      return true;
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
      return false;
    }
  };
  // Departments on this project: asked for a date, or with tasks here.
  const ids = [...new Set([...v.estimates.map((e) => e.department.id), ...v.tasks.map((t) => t.departmentId).filter((x): x is string => !!x)])];
  const name = (id: string) => v.estimates.find((e) => e.department.id === id)?.department.name ?? v.departments.find((d) => d.id === id)?.name ?? "Department";
  const unshared = v.estimates.filter((e) => e.status === "estimated" && e.can.share);
  return (
    <Panel className="mt-6" title="Departments & progress" subtitle="Send the requirements to Department Heads → they give the finish date → share it with the client → heads give tasks to their team → heads share each big finished part for the client to approve.">
      <div className="space-y-4">
        {v.can.request && <SendToHeads v={v} run={run} />}
        {msg && <p className={`text-sm ${msg.ok ? "text-green" : "text-red"}`}>{msg.text}</p>}
        {unshared.length > 1 && (
          <Button onClick={() => run(() => api.projectFlow.shareEstimates(v.engagementId, unshared.map((e) => e.id)), "Dates shared with the client.")}>Share all {unshared.length} dates with the client</Button>
        )}
        {ids.length ? (
          ids.map((id) => <DepartmentCard key={id} v={v} dept={{ id, name: name(id) }} run={run} />)
        ) : (
          <p className="text-sm text-ink-muted">{v.can.request ? "Pick the departments above and send them the requirements." : "No department has been asked yet."}</p>
        )}
      </div>
    </Panel>
  );
}

/** Dashboard / Work page: projects where a Department Head still has to give a finish date. */
export function EstimateInbox() {
  const rows = useLoad(() => api.projectFlow.inbox(), { live: ["Engagement"] });
  if (!rows.data || !rows.data.length) return null;
  return (
    <Panel title="New projects: give your finish date" subtitle="Client Managers sent you requirements. Read them, talk to your team, then give the date and add tasks on the project page.">
      <ul className="divide-y divide-border" data-testid="estimate-inbox">
        {rows.data.map((r: EstimateInboxRow) => (
          <li key={r.id} className="flex flex-wrap items-start justify-between gap-2 py-3 text-sm">
            <div className="min-w-0">
              <Link href={`/team/projects/${r.project.id}`} className="font-medium hover:underline">
                {r.project.client} · {r.project.service}
              </Link>
              <p className="text-xs text-ink-muted">
                {r.department.name}
                {r.requestedBy ? ` · from ${r.requestedBy}` : ""} · {fmt(r.requestedAt)}
              </p>
              {r.requestNote && <p className="mt-1 border-l-2 border-border pl-2 text-xs">{r.requestNote}</p>}
              <MilestoneFiles files={r.docs} />
            </div>
            <Link href={`/team/projects/${r.project.id}`} className="text-sm underline">
              Open project
            </Link>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
