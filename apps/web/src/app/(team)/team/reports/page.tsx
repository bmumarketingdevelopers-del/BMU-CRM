"use client";

import { use } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { TeamEodPerson } from "@bmu/shared";
import { Empty, Panel, StatRow, StatTile } from "@/components/dash";
import { Badge, Input, LoadState, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

const dayLabel = (ymd: string) => new Intl.DateTimeFormat("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${ymd}T00:00:00Z`));

/**
 * v50 Daily reports: the end-of-day reports of the people I oversee, one day at a time. That is everyone who reports to
 * me ("Reports to"), plus everyone in the departments I head. The Founder sees the Branch Manager, HR Head, Department
 * Heads and Client Manager Lead; each of them sees their own people, and so on down the hierarchy.
 */
export default function DailyReportsPage({ searchParams }: { searchParams: Promise<{ date?: string }> }) {
  const { date } = use(searchParams);
  return <Day key={date ?? "today"} date={date} />;
}

function Day({ date }: { date?: string }) {
  const router = useRouter();
  const loaded = useLoad(() => api.dailyReports.team(date));
  const view = loaded.data;
  if (!view) return <LoadState loading={loaded.loading} error={loaded.error} />;
  const sent = view.people.filter((p) => p.report);
  const missing = view.people.filter((p) => !p.report);
  const blocked = sent.reduce((n, p) => n + p.report!.blocked.length, 0);
  const isToday = view.date === view.today;
  return (
    <div>
      <PageTitle title="Daily reports" subtitle="End-of-day reports from the people who report to you, and from everyone in the departments you head." />
      {/* Pick any day up to today; the reports for that day load. */}
      <div className="mb-6 flex flex-wrap items-end gap-3">
        <label className="block text-sm">
          <span className="text-[11px] uppercase tracking-[0.1em] text-ink-muted">Date</span>
          <Input
            type="date"
            className="mt-1.5 block"
            value={view.date}
            max={view.today}
            onChange={(e) => {
              const d = e.target.value;
              if (d) router.push(d === view.today ? "/team/reports" : `/team/reports?date=${d}`);
            }}
            data-testid="report-date"
          />
        </label>
        {!isToday && (
          <Link href="/team/reports" className="pb-2 text-sm underline">
            Back to today
          </Link>
        )}
      </div>
      <p className="mb-4 text-sm font-medium" data-testid="report-day">
        {dayLabel(view.date)}
        {isToday && <span className="font-normal text-ink-muted"> · today, people can still send or update theirs until midnight</span>}
      </p>
      {!view.people.length ? (
        <Empty>No one reports to you yet. When people have you as their &ldquo;Reports to&rdquo;, or you head a department, their reports show here.</Empty>
      ) : (
        <div className="grid gap-6">
          <StatRow cols={3}>
            <StatTile label="Submitted" value={`${sent.length} of ${view.people.length}`} tone={missing.length ? "default" : "good"} />
            <StatTile label="Not submitted" value={missing.length} tone={missing.length ? "warn" : "default"} />
            <StatTile label="Blocked items" value={blocked} hint="Things people are stuck on" tone={blocked ? "warn" : "default"} />
          </StatRow>
          {missing.length > 0 && (
            <Panel title="Not submitted" subtitle={isToday ? "Not yet today." : "No report for this day (it may have been leave, a holiday or a weekly off)."}>
              <ul className="flex flex-wrap gap-2" data-testid="not-submitted">
                {missing.map((p) => (
                  <li key={p.id} className="border border-border px-3 py-1.5 text-sm">
                    {p.name} <span className="text-xs text-ink-muted">· {p.role}</span>
                  </li>
                ))}
              </ul>
            </Panel>
          )}
          {sent.map((p) => (
            <Report key={p.id} p={p} />
          ))}
        </div>
      )}
    </div>
  );
}

function Report({ p }: { p: TeamEodPerson }) {
  const r = p.report!;
  const block = (label: string, items: string[], tone?: "red" | "amber") =>
    items.length ? (
      <div>
        <p className="mb-1.5 flex items-center gap-2 text-[11px] uppercase tracking-[0.1em] text-ink-muted">
          {label} {tone ? <Badge tone={tone}>{items.length}</Badge> : <span>{items.length}</span>}
        </p>
        <ul className="list-disc space-y-1 pl-5 text-sm">
          {items.map((i, n) => (
            <li key={n}>{i}</li>
          ))}
        </ul>
      </div>
    ) : null;
  const empty = !r.completed.length && !r.pending.length && !r.blocked.length && !r.waiting.length;
  return (
    <Panel title={p.name} subtitle={[p.role, p.department].filter(Boolean).join(" · ")}>
      <div className="grid gap-5 md:grid-cols-2" data-testid="report">
        {empty ? <p className="text-sm text-ink-muted">Sent an empty report.</p> : null}
        {block("Completed", r.completed)}
        {block("Pending", r.pending)}
        {block("Blocked", r.blocked, "red")}
        {block("Waiting", r.waiting, "amber")}
      </div>
    </Panel>
  );
}
