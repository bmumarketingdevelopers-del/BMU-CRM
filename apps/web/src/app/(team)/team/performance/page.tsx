"use client";

import { useState } from "react";
import Link from "next/link";
import type { OpsMyView } from "@bmu/shared";
import { CsvButton, LineChart, usePeriod } from "@/components/charts";
import { ColumnChart, DataTable, Grid, Panel, StatRow, StatTile } from "@/components/dash";
import { Badge } from "@/components/ui";
import { api } from "@/lib/api";
import { InsightList, OpsPage, RangeNote, deltaOf, fmtDateTime, fmtShort, num, pctText, usePeriodData } from "@/app/(admin)/admin/analytics/team/ops-kit";

export default function MyPerformancePage() {
  const { period, setPeriod } = usePeriod("90d");
  const state = usePeriodData(() => api.opsAnalytics.me({ from: period.from, to: period.to }), [period.from, period.to]);
  return (
    <OpsPage title="My performance" subtitle="How your work is going and what is coming up. Only you see your own numbers; colleagues appear only as a team average." period={period} onPeriod={setPeriod} state={state}>
      {(v) => <Body v={v} />}
    </OpsPage>
  );
}

function Body({ v }: { v: OpsMyView }) {
  const [all, setAll] = useState(false);
  const s = v.stats;
  const avg = v.teamAverage;
  const teamHint = (n: number | null, fmt: (x: number) => string) => (n === null ? "no team average yet" : `team average ${fmt(n)}`);
  return (
    <div className="space-y-8">
      <div>
        <StatRow cols={5}>
          <StatTile label="Tasks done" value={num(s.completed.value)} delta={deltaOf(s.completed)} hint={teamHint(avg.completed, num)} href="/team/tasks" />
          <StatTile label="On time" value={pctText(s.onTimePct.value)} delta={deltaOf(s.onTimePct)} hint={teamHint(avg.onTimePct, pctText)} tone={s.onTimePct.value !== null && avg.onTimePct !== null && s.onTimePct.value >= avg.onTimePct ? "good" : "default"} />
          <StatTile label="Hours logged" value={num(s.hours.value)} delta={deltaOf(s.hours)} hint={teamHint(avg.hours, (n) => `${num(n)}h`)} />
          <StatTile label="QC first-time pass" value={pctText(s.qcFirstPassPct.value)} delta={deltaOf(s.qcFirstPassPct)} hint={s.qcFirstPassPct.value === null ? "no versions checked" : teamHint(avg.qcFirstPassPct, pctText)} />
          <StatTile label="On-time streak" value={`${s.streakDays} ${s.streakDays === 1 ? "day" : "days"}`} tone={s.streakDays >= 5 ? "good" : "default"} hint="working days with everything on time" />
        </StatRow>
        <RangeNote range={v.range} />
      </div>

      <Panel title="How you're doing">
        <InsightList items={v.insights} />
      </Panel>

      <Grid>
        <Panel className="min-w-0" title={`Tasks done by ${v.range.bucket}`} subtitle={`You compared with the average across ${avg.people} ${avg.people === 1 ? "person" : "people"} who finished work in this period.`}>
          <LineChart labels={v.trend.labels} series={v.trend.series.map((x, i) => ({ ...x, color: i === 0 ? "green" : "grey", dashed: i === 1 }))} format={(n) => num(n)} />
        </Panel>
        <Panel className="min-w-0" title="Coming up, next two weeks" subtitle="Your open tasks by deadline. Today includes anything already late.">
          {v.upcoming.days.some((d) => d.count) ? (
            <ColumnChart data={v.upcoming.days.map((d, i) => ({ label: i === 0 ? "Now" : `${"SMTWTFS"[new Date(`${d.date}T12:00:00+05:30`).getUTCDay()]}${Number(d.date.slice(8))}`, value: d.count }))} highlightLast={false} height={140} />
          ) : (
            <p className="py-6 text-center text-sm text-ink-muted">Nothing due in the next two weeks.</p>
          )}
          {v.upcoming.tasks.length > 0 && (
            <ul className="mt-4 divide-y divide-border border-t border-border text-sm">
              {v.upcoming.tasks.slice(0, 6).map((t) => (
                <li key={t.id} className="flex items-center justify-between gap-3 py-2">
                  <Link href="/team/tasks" className="min-w-0 truncate hover:underline">
                    {t.title}
                    {t.client && <span className="text-ink-muted"> · {t.client}</span>}
                  </Link>
                  <span className={`shrink-0 text-xs tabular-nums ${new Date(t.deadline) < new Date() ? "text-[#b4432c]" : "text-ink-muted"}`}>{fmtDateTime(t.deadline)}</span>
                </li>
              ))}
              {v.upcoming.tasks.length > 6 && (
                <li className="py-2 text-xs">
                  <Link href="/team/tasks" className="text-ink-muted hover:text-ink">
                    and {v.upcoming.tasks.length - 6} more in Tasks →
                  </Link>
                </li>
              )}
            </ul>
          )}
        </Panel>
      </Grid>

      <Panel
        className="min-w-0"
        title="Finished in this period"
        flush
        action={
          <CsvButton
            rows={v.recent}
            filename={`my-tasks-${v.range.from}-${v.range.to}`}
            columns={[
              { header: "Task", value: (t) => t.title },
              { header: "Client", value: (t) => t.client },
              { header: "Deadline", value: (t) => t.deadline },
              { header: "Finished", value: (t) => t.completedAt },
              { header: "On time", value: (t) => (t.onTime === null ? "" : t.onTime ? "yes" : "no") },
              { header: "Hours", value: (t) => t.hours },
            ]}
          />
        }
      >
        <DataTable
          rows={all ? v.recent : v.recent.slice(0, 12)}
          rowKey={(t) => t.id}
          empty="Nothing finished in this period yet."
          columns={[
            { key: "title", header: "Task", cell: (t) => <div className="min-w-48"><p className="font-medium">{t.title}</p>{t.client && <p className="text-xs text-ink-muted">{t.client}</p>}</div> },
            { key: "deadline", header: "Deadline", align: "right", cell: (t) => fmtShort(t.deadline) },
            { key: "done", header: "Finished", align: "right", cell: (t) => fmtShort(t.completedAt) },
            { key: "onTime", header: "On time", cell: (t) => (t.onTime === null ? <span className="text-ink-muted">No deadline</span> : t.onTime ? <Badge tone="green">On time</Badge> : <Badge tone="amber">Late</Badge>) },
            { key: "hours", header: "Hours", align: "right", cell: (t) => num(t.hours) },
          ]}
        />
        {v.recent.length > 12 && (
          <div className="border-t border-border px-4 py-3 text-sm">
            <button type="button" onClick={() => setAll((x) => !x)} className="text-ink-muted hover:text-ink">
              {all ? "Show fewer" : `Show all ${v.recent.length}`}
            </button>
          </div>
        )}
      </Panel>
    </div>
  );
}
