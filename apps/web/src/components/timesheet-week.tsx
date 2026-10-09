"use client";

import { useState } from "react";
import Link from "next/link";
import { TEAM_TIME_CATEGORIES, TEAM_TIME_CATEGORY_LABELS, type TeamTimeCategory, type TeamTimesheet } from "@bmu/shared";
import { Panel, StatRow, StatTile } from "@/components/dash";
import { Badge, Button, Input, Select } from "@/components/ui";
import { api } from "@/lib/api";

export const hrs = (min: number) => `${Math.round((min / 60) * 10) / 10}h`;
const dayLabel = (d: string) => new Date(`${d}T12:00:00+05:30`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
const todayIst = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
export const sheetTone = (s: TeamTimesheet["status"]) => (s === "approved" ? "green" : s === "returned" ? "red" : s === "submitted" ? "amber" : "neutral");
export const sheetLabel: Record<TeamTimesheet["status"], string> = { draft: "Not submitted", submitted: "Waiting for approval", approved: "Approved", returned: "Returned for changes" };

/** One person's week: days, entries from task logs plus manual time, submit, and the manager's decision. */
export function TimesheetWeek({ sheet, onChange }: { sheet: TeamTimesheet; onChange: (s: TeamTimesheet) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [comment, setComment] = useState("");
  const [entry, setEntry] = useState({ date: todayIst() >= sheet.weekStart && todayIst() <= sheet.weekEnd ? todayIst() : sheet.weekStart, hours: "1", category: "internal" as Exclude<TeamTimeCategory, "task">, note: "", engagementId: "" });
  const workingTarget = sheet.days.filter((d) => d.workingDay).length * 8 * 60;

  async function run(fn: () => Promise<TeamTimesheet>) {
    setBusy(true);
    setError(undefined);
    try {
      onChange(await fn());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-6 [&>*]:min-w-0">
      <StatRow cols={4}>
        <StatTile label="Total this week" value={hrs(sheet.totalMinutes)} hint={`about ${hrs(workingTarget)} in a full week`} tone={sheet.totalMinutes >= workingTarget * 0.9 ? "good" : "default"} />
        <StatTile label="On client tasks" value={hrs(sheet.byCategory.find((c) => c.category === "task")?.minutes ?? 0)} hint="from time logged on tasks" />
        <StatTile label="Internal & admin" value={hrs(sheet.byCategory.filter((c) => c.category !== "task").reduce((s, c) => s + c.minutes, 0))} hint="added by hand" />
        <StatTile label="Status" value={<Badge tone={sheetTone(sheet.status)}>{sheetLabel[sheet.status]}</Badge>} hint={sheet.decidedBy ? `by ${sheet.decidedBy}` : sheet.submittedAt ? "sent to your manager" : undefined} />
      </StatRow>

      {sheet.status === "returned" && sheet.comment && <p className="border border-red bg-red/10 px-4 py-2 text-sm">Returned by {sheet.decidedBy}: “{sheet.comment}”. Fix it and submit again.</p>}
      {sheet.status === "approved" && sheet.comment && <p className="border border-green bg-green/10 px-4 py-2 text-sm">{sheet.decidedBy}: “{sheet.comment}”</p>}

      <Panel title="Days" flush>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[11px] uppercase tracking-[0.1em] text-ink-muted">
                <th className="px-4 py-2 font-medium">Day</th>
                <th className="px-4 py-2 font-medium">Client tasks</th>
                <th className="px-4 py-2 font-medium">Other</th>
                <th className="px-4 py-2 font-medium">Total</th>
              </tr>
            </thead>
            <tbody>
              {sheet.days.map((d) => (
                <tr key={d.date} className={`border-b border-border ${d.workingDay ? "" : "text-ink-muted"}`}>
                  <td className="px-4 py-2">
                    {dayLabel(d.date)} {!d.workingDay && <span className="text-xs">(day off)</span>}
                  </td>
                  <td className="px-4 py-2 tabular-nums">{d.taskMinutes ? hrs(d.taskMinutes) : "—"}</td>
                  <td className="px-4 py-2 tabular-nums">{d.otherMinutes ? hrs(d.otherMinutes) : "—"}</td>
                  <td className="px-4 py-2 font-medium tabular-nums">{d.taskMinutes + d.otherMinutes ? hrs(d.taskMinutes + d.otherMinutes) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title="Entries" subtitle="Task time comes from “log time” on your tasks. Add meetings, admin and internal work here." flush>
        {sheet.entries.length === 0 ? (
          <p className="px-5 py-4 text-sm text-ink-muted">No time logged this week yet.</p>
        ) : (
          <ul className="divide-y divide-border">
            {sheet.entries.map((e) => (
              <li key={e.id} className="flex items-start justify-between gap-3 px-5 py-2.5 text-sm">
                <div className="min-w-0">
                  <p className="truncate">
                    {e.task ? e.task.title : TEAM_TIME_CATEGORY_LABELS[e.category]}
                    {e.note && !e.task && <span className="text-ink-muted"> · {e.note}</span>}
                  </p>
                  <p className="text-xs text-ink-muted">
                    {dayLabel(e.date)} · {TEAM_TIME_CATEGORY_LABELS[e.category]}
                    {e.client ? ` · ${e.client}` : ""} · {e.source === "task_log" ? "logged on task" : "added by hand"}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <span className="tabular-nums">{hrs(e.minutes)}</span>
                  {sheet.canEdit && e.source === "manual" && (
                    <button className="text-xs text-ink-muted underline hover:text-ink" disabled={busy} onClick={() => run(() => api.teamFlows.timesheets.removeEntry(e.id))}>
                      Remove
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {sheet.canEdit && (
        <Panel title="Add time" subtitle="For work that is not on a task: meetings, admin, training, internal projects. Pick a client for client calls; once approved, those hours count in that client's profitability.">
          <form
            className="grid gap-3 sm:grid-cols-[150px_100px_160px_1fr] lg:grid-cols-[150px_100px_160px_200px_1fr_auto]"
            onSubmit={(e) => {
              e.preventDefault();
              const minutes = Math.round(Number(entry.hours) * 60);
              run(() => api.teamFlows.timesheets.addEntry({ date: entry.date, minutes, category: entry.category, note: entry.note || undefined, engagementId: entry.engagementId || undefined }));
            }}
          >
            <Input type="date" value={entry.date} min={sheet.weekStart} max={sheet.weekEnd < todayIst() ? sheet.weekEnd : todayIst()} onChange={(e) => setEntry({ ...entry, date: e.target.value })} aria-label="Date" required />
            <Input type="number" step="0.25" min="0.25" max="16" value={entry.hours} onChange={(e) => setEntry({ ...entry, hours: e.target.value })} aria-label="Hours" required />
            <Select value={entry.category} onChange={(e) => setEntry({ ...entry, category: e.target.value as typeof entry.category })} aria-label="Kind of work">
              {TEAM_TIME_CATEGORIES.filter((c) => c !== "task").map((c) => (
                <option key={c} value={c}>
                  {TEAM_TIME_CATEGORY_LABELS[c]}
                </option>
              ))}
            </Select>
            <Select value={entry.engagementId} onChange={(e) => setEntry({ ...entry, engagementId: e.target.value })} aria-label="Client">
              <option value="">No client (internal)</option>
              {(sheet.clientOptions ?? []).map((o) => (
                <option key={o.engagementId} value={o.engagementId}>
                  {o.label}
                </option>
              ))}
            </Select>
            <Input value={entry.note} onChange={(e) => setEntry({ ...entry, note: e.target.value })} placeholder="What was it? (optional)" aria-label="Note" />
            <Button type="submit" variant="secondary" disabled={busy}>
              Add
            </Button>
          </form>
        </Panel>
      )}

      {error && <p className="border border-red bg-red/10 px-4 py-2 text-sm">{error}</p>}

      {sheet.canSubmit && (
        <div className="flex flex-wrap items-center gap-3">
          <Button disabled={busy} onClick={() => run(() => api.teamFlows.timesheets.submit(sheet.weekStart))}>
            Submit week for approval
          </Button>
          <span className="text-sm text-ink-muted">Your manager approves it. You can&apos;t change the week while it is waiting.</span>
        </div>
      )}

      {sheet.canDecide && sheet.id && (
        <Panel title="Your decision" subtitle="Approved hours feed client profitability. Return it with a note if something is missing.">
          <div className="grid gap-3">
            <Input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Comment (needed when you return it)" aria-label="Comment" />
            <div className="flex gap-2">
              <Button disabled={busy} onClick={() => run(() => api.teamFlows.timesheets.decide(sheet.id!, { decision: "approve", comment: comment || undefined }))}>
                Approve
              </Button>
              <Button variant="secondary" disabled={busy} onClick={() => run(() => api.teamFlows.timesheets.decide(sheet.id!, { decision: "return", comment }))}>
                Return with comment
              </Button>
            </div>
          </div>
        </Panel>
      )}
      <p className="text-xs text-ink-muted">
        Need to log time on a task? Open <Link href="/team/tasks" className="underline">Tasks</Link> and use “+30m”.
      </p>
    </div>
  );
}
