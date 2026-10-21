"use client";

// v37 manual hand-off: the Client Manager sends a project's deliverables to the Department Heads with the requirements;
// each Department Head picks people from their own department for the making steps and a QC reviewer (or themselves)
// for QC. The Client Manager sees every deliverable's department, head, status and people here and on Work hand-off.
import Link from "next/link";
import { useState } from "react";
import { handoffStatusLabels, type HandoffDeliverable, type HandoffPerson, type HandoffStatus, type ProjectHandoffView } from "@bmu/shared";
import { Panel } from "@/components/dash";
import { Badge, Button, LoadState, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

const TONE: Record<HandoffStatus, "neutral" | "amber" | "green"> = { not_sent: "neutral", waiting: "amber", assigned: "green" };
const day = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" });

/** "Design: Harisha · QC: Tushara · Client review: Neha" */
function Team({ d }: { d: HandoffDeliverable }) {
  return (
    <p className="mt-1 text-xs text-ink-muted" data-testid="handoff-team">
      {d.steps.map((s, i) => (
        <span key={s.taskId}>
          {i ? " · " : ""}
          {s.name}: {s.owner ? <span className="text-ink">{s.owner.name}</span> : <span className="text-[#b4432c]">not picked</span>}
        </span>
      ))}
    </p>
  );
}

function personLabel(p: HandoffPerson) {
  return `${p.name}${p.why ? ` (${p.why})` : ""} · ${p.openTasks} open task${p.openTasks === 1 ? "" : "s"}${p.onLeaveToday ? " · on leave today" : ""}`;
}

/** Department Head: pick a person for every step (their department for making, a QC reviewer or themselves for QC). */
export function AssignTeam({ d, onDone }: { d: HandoffDeliverable; onDone: () => void }) {
  const opts = useLoad(() => api.handoff.options(d.id), { live: false });
  const [picks, setPicks] = useState<Record<string, string>>(() => Object.fromEntries(d.steps.filter((s) => s.owner).map((s) => [s.taskId, s.owner!.id])));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();
  if (!opts.data) return <LoadState loading={opts.loading} error={opts.error} />;
  const editable = d.steps.filter((s) => (s.kind === "work" || s.kind === "qc") && !["done", "cancelled"].includes(s.status));
  const save = async () => {
    const steps = editable.filter((s) => picks[s.taskId]).map((s) => ({ taskId: s.taskId, ownerId: picks[s.taskId] }));
    if (!steps.length) return setMsg({ ok: false, text: "Pick a person for at least one step." });
    setBusy(true);
    setMsg(undefined);
    try {
      const v = await api.handoff.assign(d.id, { steps });
      setMsg({ ok: true, text: v.status === "assigned" ? "Team assigned. Everyone was told." : "Saved. Some steps still need a person." });
      onDone();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-3 space-y-2 border border-border bg-canvas/30 p-3 text-sm" data-testid="handoff-assign">
      {d.steps.map((s) => (
        <div key={s.taskId} className="grid items-center gap-2 sm:grid-cols-[10rem_1fr]">
          <span className="text-xs font-medium">
            {s.name}
            {s.deadline && <span className="block font-normal text-ink-muted">due {day.format(new Date(s.deadline))}</span>}
          </span>
          {s.kind === "client_review" ? (
            <span className="text-xs text-ink-muted">Client Manager{s.owner ? `: ${s.owner.name}` : ""}</span>
          ) : ["done", "cancelled"].includes(s.status) ? (
            <span className="text-xs text-ink-muted">{s.owner?.name ?? "—"} (finished)</span>
          ) : (
            <Select value={picks[s.taskId] ?? ""} onChange={(e) => setPicks({ ...picks, [s.taskId]: e.target.value })} aria-label={`Person for ${s.name}`} data-testid={`handoff-pick-${s.kind}`}>
              <option value="">{s.kind === "qc" ? "Pick the QC person" : "Pick someone from your department"}</option>
              {(s.kind === "qc" ? opts.data!.qc : opts.data!.makers).map((p) => (
                <option key={p.id} value={p.id}>
                  {personLabel(p)}
                </option>
              ))}
            </Select>
          )}
        </div>
      ))}
      {!opts.data.qc.some((p) => p.why === "QC reviewer") && editable.some((s) => s.kind === "qc") && <p className="text-xs text-ink-muted">No QC reviewers yet: you can do QC yourself, or ask an admin to add a QC person.</p>}
      <div className="flex items-center gap-3">
        <Button disabled={busy} onClick={save} data-testid="handoff-assign-save">
          {busy ? "Saving…" : "Save the team"}
        </Button>
        {msg && <span className={`text-xs ${msg.ok ? "text-green" : "text-red"}`}>{msg.text}</span>}
      </div>
    </div>
  );
}

function Row({ d, showProject, onChanged }: { d: HandoffDeliverable; showProject?: boolean; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="py-3" data-testid="handoff-row">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 text-sm">
          <Link href={`/team/deliverables/${d.id}`} className="font-medium hover:underline">
            {d.title}
          </Link>
          <span className="ml-2 text-xs capitalize text-ink-muted">{d.type}</span>
          {showProject && (
            <p className="text-xs text-ink-muted">
              <Link href={`/team/projects/${d.project.id}`} className="underline">
                {d.project.client} · {d.project.service}
              </Link>
              {d.project.cm ? ` · CM ${d.project.cm.name}` : ""}
            </p>
          )}
          <p className="text-xs text-ink-muted">
            {d.department ? d.department.name : "No department"}
            {d.head ? ` · Head: ${d.head.name}` : ""}
            {d.sentAt ? ` · sent ${day.format(new Date(d.sentAt))}${d.sentBy ? ` by ${d.sentBy.name}` : ""}` : ""}
            {d.dueAt ? ` · due ${day.format(new Date(d.dueAt))}` : ""}
          </p>
          {d.note && <p className="mt-1 whitespace-pre-line border-l-2 border-border pl-2 text-xs">{d.note}</p>}
          <Team d={d} />
        </div>
        <span className="flex items-center gap-2">
          <Badge tone={TONE[d.status]}>{handoffStatusLabels[d.status]}</Badge>
          {d.can.assign && (
            <Button variant="secondary" onClick={() => setOpen(!open)} data-testid="handoff-open-assign">
              {open ? "Close" : d.status === "assigned" ? "Change team" : "Pick team"}
            </Button>
          )}
        </span>
      </div>
      {open && d.can.assign && (
        <AssignTeam
          d={d}
          onDone={() => {
            setOpen(false);
            onChanged();
          }}
        />
      )}
    </li>
  );
}

/** Project page: the Client Manager sends deliverables to Department Heads and follows who is on each step. */
export function ProjectHandoffPanel({ engagementId }: { engagementId: string }) {
  const view = useLoad(() => api.handoff.project(engagementId), { live: ["Deliverable", "Task"] });
  const [fresh, setFresh] = useState<ProjectHandoffView>();
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [dept, setDept] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();
  const v = fresh ?? view.data;
  if (!v) return view.error ? null : <LoadState loading={view.loading} error={view.error} />;
  if (!v.deliverables.length) return null;
  const sendable = v.deliverables.filter((d) => d.can.send);
  const chosen = sendable.filter((d) => picked[d.id] ?? d.status === "not_sent");
  const send = async () => {
    const items = chosen.map((d) => ({ deliverableId: d.id, departmentId: dept[d.id] ?? d.department?.id ?? "" }));
    if (!items.length) return setMsg({ ok: false, text: "Tick at least one deliverable." });
    if (items.some((i) => !i.departmentId)) return setMsg({ ok: false, text: "Pick a department for every ticked deliverable." });
    setBusy(true);
    setMsg(undefined);
    try {
      setFresh(await api.handoff.send(engagementId, { items, note: note.trim() || undefined }));
      setPicked({});
      setNote("");
      setMsg({ ok: true, text: "Sent. The Department Heads were told and will pick their team." });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const reload = () => {
    setFresh(undefined);
    view.reload();
  };
  const groups = [...new Map(v.deliverables.map((d) => [d.department?.id ?? "-", d.department?.name ?? "No department"])).entries()];
  return (
    <Panel
      className="mt-6"
      title="Department hand-off"
      subtitle="Send the work to each Department Head with the requirements; they pick their team. Production starts once every step has a person."
    >
      {v.canSend && sendable.length > 0 && (
        <div className="mb-4 space-y-3 border border-border bg-canvas/30 p-3 text-sm" data-testid="handoff-send">
          <p className="text-xs font-medium">Send to Department Heads</p>
          <ul className="space-y-2">
            {sendable.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-2">
                <input type="checkbox" checked={picked[d.id] ?? d.status === "not_sent"} onChange={(e) => setPicked({ ...picked, [d.id]: e.target.checked })} aria-label={`Send ${d.title}`} />
                <span className="min-w-40 flex-1">{d.title}</span>
                <Select value={dept[d.id] ?? d.department?.id ?? ""} onChange={(e) => setDept({ ...dept, [d.id]: e.target.value })} aria-label={`Department for ${d.title}`} data-testid="handoff-dept">
                  <option value="">Pick a department</option>
                  {v.departments.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                      {x.head ? ` (head: ${x.head.name})` : ""}
                    </option>
                  ))}
                </Select>
                {d.status === "waiting" && <span className="text-xs text-ink-muted">already sent; send again to remind or move it</span>}
              </li>
            ))}
          </ul>
          <textarea
            className="h-24 w-full border border-border bg-surface-raised p-2"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Requirements and instructions for the department: goal, key message, must-haves, references. The client's files are on the project."
            aria-label="Requirements for the department"
            maxLength={2000}
          />
          <div className="flex items-center gap-3">
            <Button disabled={busy} onClick={send} data-testid="handoff-send-button">
              {busy ? "Sending…" : `Send ${chosen.length || ""} to Department Heads`}
            </Button>
            {msg && <span className={`text-xs ${msg.ok ? "text-green" : "text-red"}`}>{msg.text}</span>}
          </div>
        </div>
      )}
      {groups.map(([id, name]) => (
        <div key={id} className="mb-3">
          <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-ink-muted">{name}</h3>
          <ul className="divide-y divide-border">
            {v.deliverables
              .filter((d) => (d.department?.id ?? "-") === id)
              .map((d) => (
                <Row key={d.id} d={d} onChanged={reload} />
              ))}
          </ul>
        </div>
      ))}
    </Panel>
  );
}

/** Work hand-off page: what this Department Head must assign; what this Client Manager has not sent or is waiting for. */
export function HandoffInboxView() {
  const inbox = useLoad(() => api.handoff.inbox(), { live: ["Deliverable", "Task"] });
  if (!inbox.data) return <LoadState loading={inbox.loading} error={inbox.error} />;
  const v = inbox.data;
  const empty = (text: string) => <p className="py-6 text-center text-sm text-ink-muted">{text}</p>;
  return (
    <div className="grid gap-6">
      {v.isHead && (
        <Panel title="New work to assign" subtitle="Sent to you by Client Managers. Pick people from your department for each step, and a QC reviewer (or yourself) for QC.">
          {v.toAssign.length ? (
            <ul className="divide-y divide-border" data-testid="handoff-to-assign">
              {v.toAssign.map((d) => (
                <Row key={d.id} d={d} showProject onChanged={inbox.reload} />
              ))}
            </ul>
          ) : (
            empty("Nothing waiting for you.")
          )}
        </Panel>
      )}
      {v.isSender && (
        <>
          <Panel title="Waiting for Department Heads" subtitle="Sent, and the Department Head has not picked everyone yet. They are reminded after a working day.">
            {v.waitingForHeads.length ? (
              <ul className="divide-y divide-border" data-testid="handoff-waiting">
                {v.waitingForHeads.map((d) => (
                  <Row key={d.id} d={d} showProject onChanged={inbox.reload} />
                ))}
              </ul>
            ) : (
              empty("Nothing waiting.")
            )}
          </Panel>
          <Panel title="Not sent yet" subtitle="Approved plans whose work you have not sent to a department. Open the project to send it.">
            {v.notSent.length ? (
              <ul className="divide-y divide-border" data-testid="handoff-not-sent">
                {v.notSent.map((d) => (
                  <Row key={d.id} d={d} showProject onChanged={inbox.reload} />
                ))}
              </ul>
            ) : (
              empty("Everything has been sent.")
            )}
          </Panel>
        </>
      )}
      {!v.isHead && !v.isSender && empty("Work hand-off is for Client Managers and Department Heads.")}
    </div>
  );
}

/** Manager workspace: one line with what needs doing on Work hand-off (hidden when nothing does). */
export function HandoffSummary() {
  const inbox = useLoad(() => api.handoff.inbox(), { live: ["Deliverable", "Task"] });
  const v = inbox.data;
  if (!v) return null;
  const bits = [
    v.isHead && v.toAssign.length ? `${v.toAssign.length} to assign to your team` : null,
    v.isSender && v.notSent.length ? `${v.notSent.length} not sent to a department yet` : null,
    v.isSender && v.waitingForHeads.length ? `${v.waitingForHeads.length} waiting for Department Heads` : null,
  ].filter(Boolean);
  if (!bits.length) return null;
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-2 border border-amber bg-amber/10 px-4 py-2 text-sm" data-testid="handoff-summary">
      <span>
        <strong>Work hand-off:</strong> {bits.join(" · ")}
      </span>
      <Link href="/team/handoff" className="underline">
        Open Work hand-off
      </Link>
    </div>
  );
}
