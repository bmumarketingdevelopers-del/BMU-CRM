"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { LeaveRow, TeamLeaveCover } from "@bmu/shared";
import { DataTable, Panel, StatRow, StatTile } from "@/components/dash";
import { hrs, sheetLabel, sheetTone } from "@/components/timesheet-week";
import { Badge, Button, Input, LoadState, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { CorrectionsToDecide } from "@/components/attendance/corrections";
import { useLoad } from "@/lib/use-load";

const day = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });
const stageLabel = (l: LeaveRow) => (l.status !== "pending" ? l.status : l.stage === "hr" ? `Waiting for HR${l.managerDecidedBy ? ` (manager OK: ${l.managerDecidedBy.name})` : ""}` : "Waiting for manager");

/** Everything waiting on me: leave from my team (manager, then HR for long leave) and submitted timesheets. */
export function PeopleApprovals() {
  const leave = useLoad(() => api.adminOrg.leave());
  const sheets = useLoad(() => api.teamFlows.timesheets.approvals("submitted"));
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [coverFor, setCoverFor] = useState<string>();

  const waiting = (leave.data ?? []).filter((l) => l.canDecide);
  const recent = (leave.data ?? []).filter((l) => !l.canDecide).slice(0, 15);
  const toDecide = (sheets.data ?? []).filter((s) => s.canDecide);

  async function decide(l: LeaveRow, decision: "approve" | "reject") {
    setBusy(l.id);
    setError(undefined);
    setNotice(undefined);
    setCoverFor(undefined);
    try {
      const row = await api.adminOrg.decideLeave(l.id, { decision, note: notes[l.id] || undefined });
      setNotice(
        decision === "reject"
          ? `Leave for ${l.user.name} rejected.`
          : row.status === "pending"
            ? `Approved by you. ${l.workingDays} working days is over 3, so HR now makes the final call.`
            : `Leave for ${l.user.name} approved.${row.tasksDuringLeave ? ` They have ${row.tasksDuringLeave} task(s) due while away.` : ""}`,
      );
      if (decision === "approve" && row.status === "approved" && row.tasksDuringLeave) setCoverFor(l.id);
      leave.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <>
      <PageTitle title="Approvals" subtitle="Leave, attendance corrections and timesheets from your team that need your decision" />
      <StatRow cols={3}>
        <StatTile label="Leave to decide" value={waiting.length} tone={waiting.length ? "warn" : "good"} />
        <StatTile label="Timesheets to approve" value={toDecide.length} tone={toDecide.length ? "warn" : "good"} />
        <StatTile label="Long leave rule" value="> 3 days" hint="manager first, then HR" />
      </StatRow>
      {error && <p className="mt-4 border border-red bg-red/10 px-4 py-2 text-sm">{error}</p>}
      {notice && (
        <p className="mt-4 border border-green bg-green/10 px-4 py-2 text-sm">
          {notice}{" "}
          {coverFor && (
            <Link className="font-medium underline" href={`/team/leave/${coverFor}/cover`}>
              Pick cover now
            </Link>
          )}
        </p>
      )}

      <div className="mt-6 grid gap-6 [&>*]:min-w-0">
        <Panel title="Leave waiting for you" flush>
          <LoadState loading={leave.loading && !leave.data} error={leave.error} />
          {leave.data && waiting.length === 0 && <p className="px-5 py-4 text-sm text-ink-muted">Nothing waiting. You will get a notification when someone on your team applies.</p>}
          <ul className="divide-y divide-border">
            {waiting.map((l) => (
              <li key={l.id} className="grid gap-2 px-5 py-3 text-sm md:grid-cols-[1fr_auto] md:items-center" data-testid="leave-approval">
                <div className="min-w-0">
                  <p className="font-medium">
                    {l.user.name} · {l.type} · {day(l.from)}
                    {l.to !== l.from ? ` – ${day(l.to)}` : ""} ({l.workingDays} working day{l.workingDays === 1 ? "" : "s"})
                  </p>
                  <p className="text-xs text-ink-muted">
                    {stageLabel(l)}
                    {l.reason ? ` · “${l.reason}”` : ""}
                  </p>
                  {!!l.tasksDuringLeave && (
                    <p className="mt-1 text-xs">
                      <Badge tone="amber">Cover needed</Badge> {l.tasksDuringLeave} open task(s) due while away.{" "}
                      <Link className="underline" href={`/team/leave/${l.id}/cover`}>
                        Pick cover now
                      </Link>
                    </p>
                  )}
                  {!!l.tasksDuringLeave && <LeaveTasks leaveId={l.id} />}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Input className="w-48" placeholder="Note (optional)" value={notes[l.id] ?? ""} onChange={(e) => setNotes({ ...notes, [l.id]: e.target.value })} aria-label={`Note for ${l.user.name}`} />
                  <Button disabled={busy === l.id} onClick={() => decide(l, "approve")}>
                    Approve
                  </Button>
                  <Button variant="secondary" disabled={busy === l.id} onClick={() => decide(l, "reject")}>
                    Reject
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel title="Timesheets waiting for you" flush>
          <LoadState loading={sheets.loading && !sheets.data} error={sheets.error} />
          {sheets.data && (
            <DataTable
              rows={toDecide}
              rowKey={(s) => s.id}
              rowHref={(s) => `/team/timesheets/review/${s.id}`}
              empty="No timesheets waiting."
              columns={[
                { key: "who", header: "Person", cell: (s) => s.user.name },
                { key: "week", header: "Week of", cell: (s) => day(`${s.weekStart}T12:00:00Z`) },
                { key: "hrs", header: "Hours", cell: (s) => hrs(s.totalMinutes), align: "right" },
                { key: "st", header: "Status", cell: (s) => <Badge tone={sheetTone(s.status)}>{sheetLabel[s.status]}</Badge> },
              ]}
            />
          )}
        </Panel>

        {recent.length > 0 && (
          <Panel title="Recent leave on your team" flush>
            <DataTable
              rows={recent}
              rowKey={(l) => l.id}
              columns={[
                { key: "who", header: "Person", cell: (l) => l.user.name },
                { key: "when", header: "Dates", cell: (l) => `${day(l.from)}${l.to !== l.from ? ` – ${day(l.to)}` : ""}` },
                { key: "type", header: "Type", cell: (l) => l.type },
                { key: "st", header: "Status", cell: (l) => <Badge tone={l.status === "approved" ? "green" : l.status === "rejected" ? "red" : "amber"}>{stageLabel(l)}</Badge> },
                { key: "by", header: "Decided by", cell: (l) => l.decidedBy?.name ?? "—" },
              ]}
            />
          </Panel>
        )}
        {/* v30: attendance corrections from my team (shown only when something waits for me). */}
        <CorrectionsToDecide compact />
      </div>
    </>
  );
}

/** v11 people: the open tasks due during the leave, shown on the approval so the decision includes the cover. */
function LeaveTasks({ leaveId }: { leaveId: string }) {
  const [c, setC] = useState<TeamLeaveCover>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    api.teamFlows.leave
      .cover(leaveId)
      .then((x) => live && setC(x))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [leaveId]);
  if (error) return <p className="mt-1 text-xs text-ink-muted">Could not load the tasks: {error}</p>;
  if (!c) return <p className="mt-1 text-xs text-ink-muted">Loading the tasks due while away…</p>;
  if (!c.tasks.length) return null;
  return (
    <ul className="mt-1 space-y-0.5 border-l-2 border-amber pl-2 text-xs" data-testid="leave-tasks">
      {c.tasks.slice(0, 6).map((t) => (
        <li key={t.id} className="truncate">
          {t.href ? (
            <Link className="hover:underline" href={t.href}>
              {t.title}
            </Link>
          ) : (
            t.title
          )}
          <span className="text-ink-muted">
            {t.client ? ` · ${t.client}` : ""}
            {t.deadline ? ` · due ${day(t.deadline)}` : ""}
          </span>
        </li>
      ))}
      {c.tasks.length > 6 && <li className="text-ink-muted">and {c.tasks.length - 6} more</li>}
    </ul>
  );
}
