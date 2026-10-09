"use client";

import Link from "next/link";
import { useState } from "react";
import { LEAVE_ALLOWANCE, type AttendanceBoardRow, type AttendanceCell, type AttendanceToday, type AttendanceView, type LeaveRow } from "@bmu/shared";
import { DataTable, Empty, Meter, Panel, StatRow, StatTile, Tabs, type Column } from "@/components/dash";
import { Badge, Button, LoadState, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { DAY_NAMES, ErrorNote, fmtDate, fmtShort, fmtTime, weekday } from "../_admin-org/kit";

type Tab = "today" | "month" | "late" | "leave" | "balances";

const TODAY_LABEL: Record<AttendanceToday, { text: string; tone: "neutral" | "green" | "amber" | "red" | "dark" }> = {
  checked_in: { text: "Checked in", tone: "green" },
  checked_out: { text: "Checked out", tone: "dark" },
  absent: { text: "Not checked in", tone: "amber" },
  on_leave: { text: "On leave", tone: "neutral" },
  holiday: { text: "Holiday", tone: "neutral" },
  day_off: { text: "Day off", tone: "neutral" },
  not_yet: { text: "Not in yet", tone: "neutral" },
};

const CELL: Record<AttendanceCell, { cls: string; label: string; mark?: string }> = {
  present: { cls: "bg-charcoal", label: "Present" },
  late: { cls: "bg-amber", label: "Late check-in" },
  leave: { cls: "bg-green", label: "On leave" },
  absent: { cls: "border border-red bg-red/15", label: "Absent" },
  holiday: { cls: "bg-canvas", label: "Holiday", mark: "H" },
  weekend: { cls: "bg-canvas", label: "Weekly off" },
  future: { cls: "border border-border", label: "Not yet" },
  none: { cls: "", label: "Not tracked yet" },
};

const shiftMonth = (m: string, n: number) => {
  const [y, mo] = m.split("-").map(Number);
  const d = new Date(Date.UTC(y, mo - 1 + n, 1));
  return d.toISOString().slice(0, 7);
};
const monthName = (m: string) => new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${m}-01T00:00:00Z`));

export default function AttendancePage() {
  const [month, setMonth] = useState<string>();
  const [view, setView] = useState<AttendanceView>();
  const [busy, setBusy] = useState(false);
  const first = useLoad(() => api.adminOrg.attendance());
  const leave = useLoad(() => api.adminOrg.leave());
  const [tab, setTab] = useState<Tab>("today");
  const [error, setError] = useState<string>();
  const data = view ?? first.data;

  async function goMonth(m: string) {
    setBusy(true);
    setError(undefined);
    try {
      setView(await api.adminOrg.attendance(m));
      setMonth(m);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function decide(l: LeaveRow, decision: "approve" | "reject") {
    const note = decision === "reject" ? window.prompt(`Reason for declining ${l.user.name}'s leave (they will see this)`) : undefined;
    if (decision === "reject" && note === null) return;
    setError(undefined);
    try {
      await api.adminOrg.decideLeave(l.id, { decision, note: note || undefined });
      leave.reload();
      setView(await api.adminOrg.attendance(month));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const pending = leave.data?.filter((l) => l.status === "pending") ?? [];

  return (
    <>
      <PageTitle title="Attendance & Leave" subtitle="Who is in today, the month at a glance, late check-ins, and leave requests to approve." />
      <ErrorNote>{error}</ErrorNote>
      <LoadState loading={!data && first.loading} error={first.error} />
      {data && (
        <div className="space-y-6">
          <TodayStats data={data} pending={pending.length} onPending={() => setTab("leave")} />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="overflow-x-auto">
              <Tabs
                value={tab}
                onChange={setTab}
                options={[
                  { value: "today", label: "Today" },
                  { value: "month", label: "Month" },
                  { value: "late", label: `Late (${data.late.length})` },
                  { value: "leave", label: `Leave requests${pending.length ? ` (${pending.length})` : ""}` },
                  { value: "balances", label: "Balances" },
                ]}
              />
            </div>
            {(tab === "month" || tab === "late" || tab === "balances") && (
              <div className="flex items-center gap-2 text-sm">
                <Button variant="secondary" disabled={busy} onClick={() => goMonth(shiftMonth(data.month, -1))} aria-label="Previous month">
                  ←
                </Button>
                <span className="min-w-32 text-center font-medium">{monthName(data.month)}</span>
                <Button variant="secondary" disabled={busy} onClick={() => goMonth(shiftMonth(data.month, 1))} aria-label="Next month">
                  →
                </Button>
              </div>
            )}
          </div>

          {tab === "today" && <TodayBoard data={data} />}
          {tab === "month" && <MonthGrid data={data} />}
          {tab === "late" && <LateList data={data} />}
          {tab === "leave" && (leave.data ? <LeaveList rows={leave.data} decide={decide} /> : <LoadState loading={leave.loading} error={leave.error} />)}
          {tab === "balances" && <Balances data={data} />}
        </div>
      )}
    </>
  );
}

function TodayStats({ data, pending, onPending }: { data: AttendanceView; pending: number; onPending: () => void }) {
  const count = (s: AttendanceToday) => data.board.filter((b) => b.status === s).length;
  const offDay = data.todayKind.kind !== "working";
  const holiday = data.todayKind.kind === "holiday" ? data.todayKind : null;
  return (
    <>
      {offDay && (
        <p className="border border-border bg-canvas/60 px-4 py-3 text-sm">
          Today ({fmtDate(data.today)}) is {holiday ? (holiday.label && holiday.label !== "Holiday" ? <>a holiday: <strong>{holiday.label}</strong></> : "a holiday") : "a weekly off"}. No one is expected to check in.
        </p>
      )}
      <StatRow cols={5}>
        <StatTile label="In today" value={count("checked_in") + count("checked_out")} hint={`of ${data.board.length} people`} />
        <StatTile label="Late today" value={data.board.filter((b) => b.late).length} tone={data.board.some((b) => b.late) ? "warn" : "default"} hint={`after ${data.workingHours.start}`} />
        <StatTile label="On leave" value={count("on_leave")} />
        <StatTile label="Not checked in" value={count("absent")} tone={count("absent") ? "warn" : "default"} />
        <button onClick={onPending} className="text-left">
          <StatTile label="Leave to decide" value={pending} tone={pending ? "good" : "default"} hint={pending ? "Open requests →" : "All caught up"} />
        </button>
      </StatRow>
    </>
  );
}

function TodayBoard({ data }: { data: AttendanceView }) {
  const columns: Column<AttendanceBoardRow>[] = [
    {
      key: "who",
      header: "Person",
      cell: (r) => (
        <div>
          <div className="font-medium">{r.user.name}</div>
          <div className="text-xs text-ink-muted">{r.user.department ?? "No department"}</div>
        </div>
      ),
    },
    {
      key: "status",
      header: "Today",
      cell: (r) => (
        <span className="flex flex-wrap gap-1.5">
          <Badge tone={TODAY_LABEL[r.status].tone}>{TODAY_LABEL[r.status].text}</Badge>
          {r.late && <Badge tone="amber">Late</Badge>}
        </span>
      ),
    },
    { key: "in", header: "Checked in", align: "right", cell: (r) => fmtTime(r.checkIn) },
    { key: "out", header: "Checked out", align: "right", cell: (r) => fmtTime(r.checkOut) },
  ];
  const order: AttendanceToday[] = ["absent", "checked_in", "checked_out", "on_leave", "not_yet", "holiday", "day_off"];
  const rows = [...data.board].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
  return (
    <Panel title={`Today · ${fmtDate(data.today)}`} subtitle={`Working hours ${data.workingHours.start}–${data.workingHours.end}, ${data.workingHours.days.map((d) => DAY_NAMES[d]).join(" ")}`} flush>
      <DataTable rows={rows} columns={columns} rowKey={(r) => r.user.id} empty="No active team members." />
    </Panel>
  );
}

function MonthGrid({ data }: { data: AttendanceView }) {
  return (
    <Panel title={monthName(data.month)} subtitle="Each square is one day. Hover for details." flush>
      {data.grid.length === 0 ? (
        <Empty>No active team members.</Empty>
      ) : (
        <div className="overflow-x-auto p-5">
          <table className="border-separate border-spacing-[3px] text-xs">
            <thead>
              <tr>
                <th className="sticky left-0 z-10 bg-surface-raised pr-3 text-left font-medium text-ink-muted">Person</th>
                {data.days.map((d) => (
                  <th key={d.date} className={`w-5 text-center font-normal ${d.date === data.today ? "text-ink" : "text-ink-muted"}`} title={d.label ?? weekday(d.date)}>
                    <div className="text-[10px]">{weekday(d.date).slice(0, 1)}</div>
                    <div className={d.date === data.today ? "font-semibold" : ""}>{Number(d.date.slice(8))}</div>
                  </th>
                ))}
                <th className="pl-3 text-right font-medium text-ink-muted">In</th>
                <th className="pl-2 text-right font-medium text-ink-muted">Leave</th>
                <th className="pl-2 text-right font-medium text-ink-muted">Absent</th>
              </tr>
            </thead>
            <tbody>
              {data.grid.map((row) => (
                <tr key={row.user.id}>
                  <td className="sticky left-0 z-10 max-w-40 truncate bg-surface-raised pr-3 text-sm whitespace-nowrap">{row.user.name}</td>
                  {row.cells.map((c, i) => {
                    const d = data.days[i];
                    return (
                      <td key={d.date} title={`${fmtShort(d.date)}: ${d.kind === "holiday" ? d.label : CELL[c].label}`}>
                        <div className={`flex h-5 w-5 items-center justify-center text-[9px] text-ink-muted ${CELL[c].cls}`}>{CELL[c].mark}</div>
                      </td>
                    );
                  })}
                  <td className="pl-3 text-right tabular-nums">{row.present}</td>
                  <td className="pl-2 text-right tabular-nums">{row.leave}</td>
                  <td className={`pl-2 text-right tabular-nums ${row.absent ? "text-[#b4432c]" : ""}`}>{row.absent}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <ul className="mt-4 flex flex-wrap gap-x-5 gap-y-1.5 text-xs text-ink-muted">
            {(Object.keys(CELL) as AttendanceCell[]).filter((k) => k !== "none").map((k) => (
              <li key={k} className="flex items-center gap-1.5">
                <span className={`inline-flex h-3 w-3 items-center justify-center text-[8px] ${CELL[k].cls}`}>{CELL[k].mark}</span>
                {CELL[k].label}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  );
}

function LateList({ data }: { data: AttendanceView }) {
  const counts = new Map<string, number>();
  for (const l of data.late) counts.set(l.user.id, (counts.get(l.user.id) ?? 0) + 1);
  return (
    <Panel title="Late check-ins" subtitle={`Checked in after ${data.workingHours.start} (from Holidays & Working Hours)`} flush>
      <DataTable
        rows={data.late}
        rowKey={(r) => `${r.user.id}-${r.date}`}
        empty={`Nobody checked in late in ${monthName(data.month)}.`}
        columns={[
          { key: "who", header: "Person", cell: (r) => <span className="font-medium">{r.user.name}</span> },
          { key: "date", header: "Day", cell: (r) => `${weekday(r.date)}, ${fmtShort(r.date)}` },
          { key: "in", header: "Checked in", align: "right", cell: (r) => fmtTime(r.checkIn) },
          { key: "late", header: "Late by", align: "right", cell: (r) => <span className={r.minutesLate >= 30 ? "text-[#9a6b00]" : ""}>{r.minutesLate} min</span> },
          { key: "times", header: "Late this month", align: "right", cell: (r) => counts.get(r.user.id) },
        ]}
      />
    </Panel>
  );
}

function LeaveList({ rows, decide }: { rows: LeaveRow[]; decide: (l: LeaveRow, d: "approve" | "reject") => void }) {
  const [show, setShow] = useState<"pending" | "all">("pending");
  const list = show === "pending" ? rows.filter((r) => r.status === "pending") : rows;
  const tone = { pending: "amber", approved: "green", rejected: "red", cancelled: "neutral" } as const;
  return (
    <Panel
      title="Leave requests"
      subtitle="The manager decides first. Leave over 3 working days then needs HR (HR, Admin or the Founder can decide at any stage). The person is notified."
      action={<Tabs value={show} onChange={setShow} options={[{ value: "pending", label: "Waiting" }, { value: "all", label: "All" }]} />}
      flush
    >
      <DataTable
        rows={list}
        rowKey={(r) => r.id}
        empty={show === "pending" ? "No leave waiting for a decision." : "No leave requests yet."}
        columns={[
          { key: "who", header: "Person", cell: (r) => <span className="font-medium">{r.user.name}</span> },
          {
            key: "when",
            header: "Dates",
            cell: (r) => (
              <div>
                <div>{r.from === r.to ? fmtDate(r.from) : `${fmtShort(r.from)} – ${fmtDate(r.to)}`}</div>
                <div className="text-xs text-ink-muted">
                  {r.workingDays} working day{r.workingDays === 1 ? "" : "s"}
                </div>
              </div>
            ),
          },
          { key: "type", header: "Type", cell: (r) => <span className="capitalize">{r.type}</span> },
          { key: "reason", header: "Reason", cell: (r) => <span className="text-ink-muted">{r.reason ?? "—"}</span>, className: "max-w-xs" },
          {
            key: "status",
            header: "Status",
            cell: (r) => (
              <div>
                <Badge tone={tone[r.status]}>{r.status === "pending" ? (r.stage === "hr" ? "Waiting for HR" : "Waiting for manager") : r.status}</Badge>
                {r.managerDecidedBy && r.status === "pending" && <div className="mt-1 text-xs text-ink-muted">manager OK: {r.managerDecidedBy.name}</div>}
                {r.decidedBy && <div className="mt-1 text-xs text-ink-muted">by {r.decidedBy.name}</div>}
                {r.decisionNote && <div className="mt-1 text-xs text-ink-muted">“{r.decisionNote}”</div>}
                {!!r.tasksDuringLeave && r.status !== "rejected" && r.status !== "cancelled" && (
                  <div className="mt-1 text-xs">
                    <Link className="underline" href={`/team/leave/${r.id}/cover`}>
                      {r.tasksDuringLeave} task(s) need cover
                    </Link>
                  </div>
                )}
              </div>
            ),
          },
          {
            key: "act",
            header: "",
            align: "right",
            cell: (r) =>
              r.canDecide ? (
                <div className="flex justify-end gap-1">
                  <Button onClick={() => decide(r, "approve")}>Approve</Button>
                  <Button variant="ghost" onClick={() => decide(r, "reject")}>
                    Decline
                  </Button>
                </div>
              ) : null,
          },
        ]}
      />
    </Panel>
  );
}

function Balances({ data }: { data: AttendanceView }) {
  const year = data.month.slice(0, 4);
  return (
    <Panel title={`Leave balances · ${year}`} subtitle={`${LEAVE_ALLOWANCE.casual} casual + ${LEAVE_ALLOWANCE.sick} sick days a year, minus approved leave (working days only).`} flush>
      <DataTable
        rows={data.balances}
        rowKey={(r) => r.user.id}
        empty="No active team members."
        columns={[
          { key: "who", header: "Person", cell: (r) => <span className="font-medium">{r.user.name}</span> },
          {
            key: "casual",
            header: "Casual left",
            cell: (r) => (
              <div className="min-w-40">
                <Meter value={(r.casualLeft / LEAVE_ALLOWANCE.casual) * 100} tone={r.casualLeft <= 2 ? "warn" : "default"} label={`${r.casualUsed} used`} />
                <div className="mt-1 text-xs text-ink-muted">
                  {r.casualLeft} of {LEAVE_ALLOWANCE.casual} days
                </div>
              </div>
            ),
          },
          {
            key: "sick",
            header: "Sick left",
            cell: (r) => (
              <div className="min-w-40">
                <Meter value={(r.sickLeft / LEAVE_ALLOWANCE.sick) * 100} tone={r.sickLeft <= 2 ? "warn" : "default"} label={`${r.sickUsed} used`} />
                <div className="mt-1 text-xs text-ink-muted">
                  {r.sickLeft} of {LEAVE_ALLOWANCE.sick} days
                </div>
              </div>
            ),
          },
          { key: "other", header: "Other leave taken", align: "right", cell: (r) => (r.otherUsed ? `${r.otherUsed} days` : "—") },
        ]}
      />
    </Panel>
  );
}
