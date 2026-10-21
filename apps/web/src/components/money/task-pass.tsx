"use client";
// v23 pass a task: hand one of your own open tasks to a colleague in your department. It moves when they accept;
// handovers waiting for you (accept / decline) and the ones you offered (withdraw) are listed here too.
import { useEffect, useState } from "react";
import type { PassCandidate, PassRequestRow, TaskPassView } from "@bmu/shared";
import { Badge, Button, Select } from "@/components/ui";
import { Panel } from "@/components/dash";
import { TextArea } from "@/components/actions/action-drawer";
import { api } from "@/lib/api";
import { day, Field, Note } from "./kit";

const statusLabel: Record<string, string> = { todo: "To do", in_progress: "In progress", blocked: "Blocked", waiting: "Waiting" };

/** The "Pass a task" form. `onDone` reloads the page (the heatmap and the lists). */
export function PassTaskPanel({ data, onClose, onDone }: { data: TaskPassView; onClose: () => void; onDone: (message: string) => void }) {
  const free = data.tasks.filter((t) => !t.pending);
  const [taskId, setTaskId] = useState(free[0]?.id ?? "");
  const [people, setPeople] = useState<PassCandidate[] | null>(null);
  const [toUserId, setToUserId] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const task = data.tasks.find((t) => t.id === taskId);

  const pickTask = (id: string) => {
    setTaskId(id);
    setPeople(null);
    setToUserId("");
    setError(undefined);
  };
  useEffect(() => {
    if (!taskId) return;
    let live = true;
    api.capacity.passCandidates(taskId).then((r) => live && setPeople(r)).catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [taskId]);

  const send = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const r = await api.capacity.pass({ taskId, toUserId, note });
      onDone(`Sent to ${r.to}. The task moves to them when they accept.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const picked = people?.find((p) => p.userId === toUserId);

  return (
    <Panel
      title="Pass a task to a colleague"
      subtitle={`Anyone in ${data.department ?? "your department"}. The task moves to them only when they accept; your Department Head is told.`}
      action={<Button variant="ghost" onClick={onClose}>Close</Button>}
    >
      {!data.department ? (
        <p className="text-sm text-ink-muted">You aren&apos;t in a department yet. Ask HR to add you to one.</p>
      ) : !data.tasks.length ? (
        <p className="text-sm text-ink-muted">You have no open tasks to pass.</p>
      ) : (
        <div className="space-y-3" data-testid="pass-form">
          <Field label="Your task">
            <Select value={taskId} onChange={(e) => pickTask(e.target.value)} data-testid="pass-task-select">
              {data.tasks.map((t) => (
                <option key={t.id} value={t.id} disabled={!!t.pending}>
                  {t.title}
                  {t.client ? ` · ${t.client}` : ""} · {t.deadline ? `due ${day(t.deadline)}` : "no deadline"} · ~{t.hours}h
                  {t.pending ? ` (waiting for ${t.pending.to})` : ""}
                </option>
              ))}
            </Select>
          </Field>
          {task && (
            <p className="text-xs text-ink-muted">
              {statusLabel[task.status] ?? task.status} · the deadline stays the same
              {people?.[0] ? ` · counts in the week of ${day(people[0].weekStart)}` : ""}
            </p>
          )}
          <div>
            <span className="mb-1 block text-xs font-medium text-ink-muted">Pass it to</span>
            {!people && !error && <p className="text-sm text-ink-muted">Loading your colleagues…</p>}
            {people && !people.length && <p className="text-sm text-ink-muted">Nobody else is in your department yet.</p>}
            {people && people.length > 0 && (
              <ul className="divide-y divide-border border border-border text-sm" data-testid="pass-candidates">
                {people.map((p) => (
                  <li key={p.userId}>
                    <label className={`flex items-center gap-3 px-3 py-2 ${p.blocked ? "opacity-60" : "cursor-pointer"}`}>
                      <input type="radio" name="pass-to" value={p.userId} checked={toUserId === p.userId} disabled={!!p.blocked} onChange={() => setToUserId(p.userId)} />
                      <span className="flex-1">
                        <span className="font-medium">{p.name}</span>
                        {p.specialty && <span className="text-ink-muted"> · {p.specialty.replaceAll("_", " ")}</span>}
                        <span className="block text-xs text-ink-muted">{p.blocked ?? `${Math.max(0, p.freeHours)}h free of ${p.availableHours}h that week`}</span>
                      </span>
                      {p.blocked ? <Badge tone="red">Can&apos;t take it</Badge> : p.warning ? <Badge tone="amber">Busy</Badge> : <Badge tone="green">Has time</Badge>}
                    </label>
                  </li>
                ))}
              </ul>
            )}
            {picked?.warning && <p className="mt-1 text-xs text-[#9a6b00]">{picked.warning}. They can still accept.</p>}
          </div>
          <Field label="Handover note" hint="What is done, what is left, where the files are.">
            <TextArea value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} data-testid="pass-note" />
          </Field>
          <Note error={error} />
          <Button onClick={send} disabled={busy || !taskId || !toUserId || note.trim().length < 3} data-testid="pass-send">
            {busy ? "Sending…" : picked ? `Send to ${picked.name}` : "Send"}
          </Button>
        </div>
      )}
    </Panel>
  );
}

/** Handovers waiting for you (accept / decline) and the ones you offered (withdraw). */
export function PassRequests({ data, onDone, onError }: { data: TaskPassView; onDone: (message: string) => void; onError: (message: string) => void }) {
  const [busy, setBusy] = useState<string>();
  if (!data.received.length && !data.sent.length) return null;
  const act = async (r: PassRequestRow, what: "accept" | "decline" | "withdraw") => {
    let note: string | undefined;
    if (what === "decline") {
      const why = window.prompt(`Why can't you take "${r.task}"? ${r.from} will see this.`);
      if (why === null) return;
      note = why;
    }
    setBusy(r.id);
    try {
      if (what === "withdraw") await api.actions.approvals.cancel(r.id);
      else await api.actions.approvals.decide(r.id, { decision: what === "accept" ? "approve" : "reject", note });
      onDone(what === "accept" ? `"${r.task}" is yours now.` : what === "decline" ? `Declined; ${r.from} has been told.` : "Withdrawn.");
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <>
      {data.received.length > 0 && (
        <Panel title="Tasks offered to you" subtitle="A colleague wants to pass you their task. It becomes yours when you accept." flush>
          <ul className="divide-y divide-border text-sm" data-testid="pass-received">
            {data.received.map((r) => (
              <li key={r.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <a href={`/team/tasks/${r.taskId}`} className="font-medium underline">{r.task}</a>
                  <span className="block text-xs text-ink-muted">From {r.from} · {r.deadline ? `due ${day(r.deadline)}` : "no deadline"}</span>
                  {r.note && <p className="mt-1 text-xs">Handover: {r.note}</p>}
                </div>
                <div className="flex gap-2">
                  <Button onClick={() => act(r, "accept")} disabled={busy === r.id} data-testid="pass-accept">Accept</Button>
                  <Button variant="secondary" onClick={() => act(r, "decline")} disabled={busy === r.id} data-testid="pass-decline">Decline</Button>
                </div>
              </li>
            ))}
          </ul>
        </Panel>
      )}
      {data.sent.length > 0 && (
        <Panel title="Tasks you offered" subtitle="Waiting for your colleague. They stay yours until accepted." flush>
          <ul className="divide-y divide-border text-sm" data-testid="pass-sent">
            {data.sent.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <span className="min-w-0">
                  <span className="font-medium">{r.task}</span>
                  <span className="block text-xs text-ink-muted">Waiting for {r.to} · offered {day(r.createdAt)}</span>
                </span>
                <Button variant="ghost" onClick={() => act(r, "withdraw")} disabled={busy === r.id}>Withdraw</Button>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </>
  );
}
