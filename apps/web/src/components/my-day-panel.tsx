"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { dashboardDefaultLayout, type MyDayView, type TaskView } from "@bmu/shared";
import { DashGrid, type DashLayoutProps } from "@/components/dashboards/grid";
import { Empty, Panel, StatRow, StatTile } from "@/components/dash";
import { SlaList } from "@/components/deliver/sla-list";
import { TaskCard } from "@/components/task-list";
import { Button, LoadState } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

const time = new Intl.DateTimeFormat("en-IN", { timeStyle: "short", timeZone: "Asia/Kolkata" });
const dayName = (ymd: string) => new Intl.DateTimeFormat("en-IN", { weekday: "long", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${ymd}T00:00:00Z`));
const lines = (v: string) => v.split("\n").map((l) => l.trim()).filter(Boolean);
/** "09:30" + 15 -> "09:45". */
const addMin = (hhmm: string, n: number) => {
  const m = Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5)) + n;
  return `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};

/** My Day: check-in/out, today's priorities and the end-of-day report (people_capacity module). */
export function MyDayPanel({ layout, wrap, hasLeads }: DashLayoutProps & { hasLeads?: boolean }) {
  const loaded = useLoad(() => api.myDay.get());
  const [fresh, setFresh] = useState<MyDayView>();
  const [error, setError] = useState<string>();
  const day = fresh ?? loaded.data;
  if (!day) return <LoadState loading={loaded.loading} error={loaded.error} />;

  async function act(fn: () => Promise<MyDayView>) {
    setError(undefined);
    try {
      setFresh(await fn());
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const refresh = () => api.myDay.get().then(setFresh);
  const groups: [string, TaskView[], string][] = [
    ["Overdue", day.tasks.overdue, "bg-red"],
    ["Due today", day.tasks.today, "bg-amber"],
    ["Blocked", day.tasks.blocked, "bg-red"],
    ["Coming up", day.tasks.upcoming, "bg-charcoal"],
  ];
  const openCount = day.tasks.overdue.length + day.tasks.today.length + day.tasks.blocked.length + day.tasks.upcoming.length;
  const hours = day.checkIn ? ((day.checkOut ? new Date(day.checkOut) : new Date()).getTime() - new Date(day.checkIn).getTime()) / 3_600_000 : 0;

  const sections: Record<string, ReactNode> = {
    attendance: (
      <div className="grid gap-px border border-border bg-border lg:grid-cols-[1.1fr_3fr]">
        <div className="flex flex-col justify-between gap-4 bg-surface-raised p-5">
          <div>
            <p className="text-[13px] text-ink-muted">Attendance</p>
            {!day.checkIn ? (
              <p className="mt-2 text-[28px] leading-none font-semibold tracking-tight">{day.onLeave ? "On leave" : day.workday && day.workday.kind !== "working" ? (day.workday.kind === "holiday" ? "Holiday" : "Weekly off") : "Not in yet"}</p>
            ) : (
              <p className="mt-2 text-[28px] leading-none font-semibold tracking-tight tabular-nums">{Math.floor(hours)}h {Math.round((hours % 1) * 60)}m</p>
            )}
            <p className="mt-2 text-xs text-ink-muted">
              {day.checkIn
                ? `In at ${time.format(new Date(day.checkIn))}`
                : day.onLeave
                  ? `${day.onLeave.label} until ${dayName(day.onLeave.until)}. No check-in needed.`
                  : day.workday && day.workday.kind !== "working"
                  ? `${day.workday.label ? `${day.workday.label}. ` : ""}No check-in today.`
                  : day.workingHours
                    ? `Office starts ${day.workingHours.start}. Check in by ${addMin(day.workingHours.start, day.workingHours.graceMinutes)} to be on time.`
                    : "Check in when you start work"}
              {day.checkOut && ` · out at ${time.format(new Date(day.checkOut))}`}
              {day.late && " · late"}
              {day.wfh && " · working from home"}
            </p>
          </div>
          {day.canCheckIn ?? !day.checkIn ? (
            <Button onClick={() => act(api.myDay.checkIn)} data-testid="check-in">
              Check in
            </Button>
          ) : (day.canCheckOut ?? !day.checkOut) && day.checkIn ? (
            <Button variant="secondary" onClick={() => act(api.myDay.checkOut)} data-testid="check-out">
              Check out
            </Button>
          ) : (
            <p className="text-xs text-ink-muted">
              {day.checkOut ? "Done for the day." : ""}
              {day.nextCheckIn ? ` Check-in opens on ${dayName(day.nextCheckIn)}.` : day.checkOut ? " See you tomorrow." : ""}
            </p>
          )}
          {day.missedCheckOut && (
            <p className="text-xs text-[#9a6b00]">
              You did not check out on {dayName(day.missedCheckOut)}.{" "}
              <Link href="/team/profile#corrections" className="underline">
                Ask for a correction
              </Link>
            </p>
          )}
        </div>
        <div className="grid gap-px bg-border sm:grid-cols-2 lg:grid-cols-4">
          <StatTile label="Overdue" value={day.tasks.overdue.length} tone={day.tasks.overdue.length ? "bad" : "default"} />
          <StatTile label="Due today" value={day.tasks.today.length} tone={day.tasks.today.length ? "warn" : "default"} />
          <StatTile label="Blocked" value={day.tasks.blocked.length} tone={day.tasks.blocked.length ? "bad" : "default"} />
          <StatTile label="Open tasks" value={openCount} href="/team/tasks" hint="All tasks →" />
        </div>
      </div>
    ),
    queues:
      day.qcWaiting > 0 || day.sendToClientWaiting > 0 ? (
        <StatRow cols={2}>
          {day.qcWaiting > 0 && <StatTile label="Versions waiting for QC" value={day.qcWaiting} tone="warn" href="/team/qc" hint="Open QC queue →" />}
          {day.sendToClientWaiting > 0 && <StatTile label="QC passed, ready to send to clients" value={day.sendToClientWaiting} tone="good" href="/team/reviews" hint="Open Review Studio →" />}
        </StatRow>
      ) : null,
    deadlines: day.deliverSla?.length ? (
      <Panel
        title="Delivery deadlines to watch"
        subtitle={`${day.deliverSla.filter((i) => i.state === "overdue").length} late, ${day.deliverSla.filter((i) => i.state === "at_risk").length} due within a working day. Steps more than a working day late go to the department head.`}
      >
        <SlaList items={day.deliverSla} limit={8} />
      </Panel>
    ) : null,
    tasks:
      openCount === 0 ? (
        <Panel>
          <Empty>No open tasks assigned to you. Enjoy the calm, or check the team board.</Empty>
        </Panel>
      ) : (
        <div className={`grid gap-6 ${groups.filter(([, t]) => t.length).length > 1 ? "lg:grid-cols-2" : ""}`}>
          {groups.map(([title, tasks, dot]) =>
            tasks.length ? (
              <Panel
                key={title}
                title={title}
                action={
                  <span className="flex items-center gap-2 text-xs text-ink-muted">
                    <span className={`inline-block h-2 w-2 ${dot}`} />
                    {tasks.length}
                  </span>
                }
              >
                <div className="grid gap-2">
                  {tasks.map((t) => (
                    <TaskCard key={t.id} t={t} onChanged={refresh} />
                  ))}
                </div>
              </Panel>
            ) : null,
          )}
        </div>
      ),
    eod: (
      <div className="grid gap-3">
        <EodForm key={String(day.eod.submitted)} day={day} onSubmit={(input) => act(() => api.myDay.submitEod(input))} />
        <p className="text-xs text-ink-muted">
          Past reports and your attendance are on <Link href="/team/profile" className="underline">your profile</Link>.
        </p>
      </div>
    ),
    // Unknown (shown on another dashboard): the tiles hide themselves for people without leads.
    sales: hasLeads === false ? null : <SalesTiles />,
  };

  return (
    <div className="grid gap-6 [&_.grid>*]:min-w-0 [&>*]:min-w-0">
      {error && <p className="border border-red bg-red/10 px-4 py-2 text-sm">{error}</p>}
      {/* v31: the final decision on the latest leave request, worded for its type. */}
      {day.leaveNotice && (
        <div className={`border px-4 py-3 text-sm ${day.leaveNotice.status === "approved" ? "border-green bg-green/10" : "border-amber bg-amber/10"}`} role="status" data-testid="leave-notice">
          <p className="font-medium">{day.leaveNotice.title}</p>
          <p className="mt-0.5 text-ink-muted">{day.leaveNotice.body}</p>
        </div>
      )}
      <DashGrid host="my_day" items={layout ?? dashboardDefaultLayout("my_day")} sections={sections} wrap={wrap} />
    </div>
  );
}

/** The person's open pipeline (people with access to leads). */
function SalesTiles() {
  const state = useLoad(() => api.leads.list());
  if (!state.data) return state.error ? null : <LoadState loading />;
  const open = state.data.filter((l) => !["won", "lost"].includes(l.stage));
  const fresh = open.filter((l) => l.stage === "new");
  const proposals = open.filter((l) => l.stage === "proposal_sent");
  return (
    <Panel title="Sales" subtitle="Your open pipeline" flush>
      <StatRow cols={3}>
        <StatTile label="New leads to contact" value={fresh.length} tone={fresh.length ? "good" : "default"} href="/team/leads" hint="Open pipeline →" />
        <StatTile label="Open leads" value={open.length} href="/team/leads" />
        <StatTile label="Proposals out" value={proposals.length} href="/team/proposals" />
      </StatRow>
    </Panel>
  );
}

function EodForm({ day, onSubmit }: { day: MyDayView; onSubmit: (input: MyDayView["eod"]) => void }) {
  const [v, setV] = useState({
    completed: day.eod.completed.join("\n"),
    pending: day.eod.pending.join("\n"),
    blocked: day.eod.blocked.join("\n"),
    waiting: day.eod.waiting.join("\n"),
  });
  const field = (k: keyof typeof v, label: string) => (
    <label className="block text-sm">
      <span className="text-[11px] uppercase tracking-[0.1em] text-ink-muted">{label}</span>
      <textarea className="mt-1.5 w-full border border-border bg-surface-raised px-3 py-2 text-sm" rows={3} value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })} placeholder="One item per line" />
    </label>
  );
  return (
    <Panel
      title="End-of-day report"
      subtitle="Pre-filled from your tasks. Edit, then submit. Your manager sees it in their weekly review."
      action={day.eod.submitted ? <span className="text-xs text-ink-muted">Submitted · you can update it until midnight</span> : undefined}
    >
      <div className="grid gap-4 md:grid-cols-2">
        {field("completed", "Completed")}
        {field("pending", "Pending")}
        {field("blocked", "Blocked")}
        {field("waiting", "Waiting")}
      </div>
      <Button
        className="mt-4"
        onClick={() => onSubmit({ completed: lines(v.completed), pending: lines(v.pending), blocked: lines(v.blocked), waiting: lines(v.waiting), submitted: true })}
      >
        {day.eod.submitted ? "Update report" : "Submit report"}
      </Button>
    </Panel>
  );
}
