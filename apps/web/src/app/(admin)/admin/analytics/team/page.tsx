"use client";

import { useState } from "react";
import Link from "next/link";
import type { OpsDepartmentRow, OpsPersonRow, OpsTeamView } from "@bmu/shared";
import { CsvButton, Heatmap, LineChart, usePeriod } from "@/components/charts";
import { DataTable, Grid, Meter, Panel, StatRow, StatTile, type Column } from "@/components/dash";
import { Badge, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { InsightList, OpsPage, RangeNote, daysText, deltaOf, loadTone, num, pctText, usePeriodData, useSort, wasText } from "./ops-kit";

export default function TeamPerformancePage() {
  const { period, setPeriod } = usePeriod("90d");
  const [dept, setDept] = useState("");
  const state = usePeriodData(() => api.opsAnalytics.team({ from: period.from, to: period.to, departmentId: dept || undefined }), [period.from, period.to, dept]);
  return (
    <OpsPage
      title="Team performance"
      subtitle="Who finishes work on time, how busy each person is, and where overload is building up."
      period={period}
      onPeriod={setPeriod}
      state={state}
      filters={
        state.data && !state.data.lockedDepartmentId ? (
          <Select aria-label="Department" value={dept} onChange={(e) => setDept(e.target.value)}>
            <option value="">All departments</option>
            {state.data.departmentFilter.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </Select>
        ) : state.data?.lockedDepartmentId ? (
          <Badge tone="dark">{state.data.departmentFilter[0]?.name ?? "Your department"}</Badge>
        ) : null
      }
    >
      {(v) => <Body v={v} />}
    </OpsPage>
  );
}


function Body({ v }: { v: OpsTeamView }) {
  const t = v.totals;
  const people = useSort<OpsPersonRow>(v.people, { key: "completed", dir: "desc" }, {
    name: (p) => p.name,
    completed: (p) => p.completed,
    onTime: (p) => p.onTimePct,
    cycle: (p) => p.avgCycleDays,
    hours: (p) => p.hours,
    util: (p) => p.utilisation,
    qc: (p) => p.qcFirstPassPct,
    rounds: (p) => p.avgRevisionRounds,
    overdue: (p) => p.overdueNow,
  });
  const h = people.header;
  const personCols: Column<OpsPersonRow>[] = [
    {
      key: "name",
      header: h("name", "Person"),
      cell: (p) => (
        <div className="min-w-36">
          <p className="font-medium">{p.name}</p>
          <p className="text-xs text-ink-muted">{[p.role, p.department].filter(Boolean).join(" · ") || "—"}</p>
        </div>
      ),
    },
    { key: "completed", header: h("completed", "Done"), align: "right", cell: (p) => <span title={`Previous period: ${p.completedPrev}`}>{p.completed}</span> },
    { key: "onTime", header: h("onTime", "On time"), className: "min-w-32", cell: (p) => (p.onTimePct === null ? <span className="text-ink-muted">—</span> : <Meter value={p.onTimePct} tone={p.onTimePct >= 80 ? "good" : p.onTimePct < 60 ? "bad" : "default"} />) },
    { key: "cycle", header: h("cycle", "Cycle time"), align: "right", cell: (p) => daysText(p.avgCycleDays, "d") },
    { key: "hours", header: h("hours", "Hours"), align: "right", cell: (p) => num(p.hours) },
    { key: "util", header: h("util", `Use of ${v.productiveHoursPerWeek}h week`), className: "min-w-32", cell: (p) => <Meter value={p.utilisation} tone={loadTone(p.utilisation)} /> },
    { key: "qc", header: h("qc", "QC first pass"), align: "right", cell: (p) => (p.qcVersions ? <span title={`${p.qcVersions} versions checked`}>{pctText(p.qcFirstPassPct)}</span> : <span className="text-ink-muted">—</span>) },
    { key: "rounds", header: h("rounds", "Revisions"), align: "right", cell: (p) => num(p.avgRevisionRounds) },
    {
      key: "overdue",
      header: h("overdue", "Overdue"),
      align: "right",
      cell: (p) =>
        p.overdueNow ? (
          <Link href="/team/tasks" className="text-[#b4432c] hover:underline">
            {p.overdueNow}
          </Link>
        ) : (
          0
        ),
    },
  ];
  const deptCols: Column<OpsDepartmentRow>[] = [
    { key: "name", header: "Department", cell: (d) => <span className="font-medium">{d.name}</span> },
    { key: "people", header: "People", align: "right", cell: (d) => d.people },
    { key: "done", header: "Done", align: "right", cell: (d) => d.completed },
    { key: "onTime", header: "On time", align: "right", cell: (d) => pctText(d.onTimePct) },
    { key: "cycle", header: "Cycle time", align: "right", cell: (d) => daysText(d.avgCycleDays, "d") },
    { key: "util", header: "Use of time", className: "min-w-32", cell: (d) => <Meter value={d.utilisation} tone={loadTone(d.utilisation)} /> },
    { key: "qc", header: "QC first pass", align: "right", cell: (d) => pctText(d.qcFirstPassPct) },
    { key: "overdue", header: "Overdue", align: "right", cell: (d) => (d.overdueNow ? <span className="text-[#b4432c]">{d.overdueNow}</span> : 0) },
  ];

  if (!v.people.length) return <Panel><p className="py-8 text-center text-sm text-ink-muted">No one in this view has tasks in the period. Try another department or a longer period.</p></Panel>;

  return (
    <div className="space-y-8">
      <div>
        <StatRow cols={3}>
          <StatTile label="Tasks completed" value={num(t.completed.value)} delta={deltaOf(t.completed)} hint={wasText(t.completed.prev, String)} href="/team/tasks" />
          <StatTile label="Finished on time" value={pctText(t.onTimePct.value)} delta={deltaOf(t.onTimePct)} hint="done by the deadline" tone={(t.onTimePct.value ?? 100) < 70 ? "warn" : "default"} />
          <StatTile label="Average cycle time" value={daysText(t.avgCycleDays.value)} delta={deltaOf(t.avgCycleDays, { lowerIsBetter: true })} hint="start to done" />
          <StatTile label="Hours logged" value={num(t.hours.value)} delta={deltaOf(t.hours)} hint={`${pctText(t.utilisation.value)} of ${v.productiveHoursPerWeek}h weeks`} />
          <StatTile label="QC first-time pass" value={pctText(t.qcFirstPassPct.value)} delta={deltaOf(t.qcFirstPassPct)} hint="versions passing on the first check" />
          <StatTile label="Overdue right now" value={t.overdueNow} tone={t.overdueNow ? "bad" : "good"} hint="open tasks past the deadline" href="/team/tasks" />
        </StatRow>
        <RangeNote range={v.range} />
      </div>

      <Panel title="What this means">
        <InsightList items={v.insights} />
      </Panel>

      <Grid>
        <Panel className="min-w-0" title={`Throughput by ${v.range.bucket}`} subtitle="Tasks completed against tasks created. Created above completed means the backlog is growing.">
          <LineChart labels={v.throughput.labels} series={v.throughput.series.map((s, i) => ({ ...s, color: i === 0 ? "dark" : "grey", dashed: i === 1 }))} />
        </Panel>
        <Panel className="min-w-0" title="Workload, next four weeks" subtitle={`Open tasks by deadline (overdue counts in this week). Hover for load at about ${v.workload.hoursPerTask}h per task.`}>
          {v.workload.rows.length ? (
            <Heatmap
              rows={v.workload.rows.map((r) => r.name)}
              cols={v.workload.weeks}
              values={v.workload.rows.map((r) => r.tasks)}
              cellTitle={(ri, ci, val) => `${v.workload.rows[ri].name}, ${v.workload.weeks[ci]}: ${val ?? 0} tasks ≈ ${v.workload.rows[ri].loadPct[ci]}% of a ${v.productiveHoursPerWeek}h week`}
            />
          ) : (
            <p className="py-6 text-center text-sm text-ink-muted">No open tasks with deadlines in the next four weeks.</p>
          )}
          {v.workload.rows.some((r) => r.loadPct[1] > 100) && (
            <p className="mt-3 text-xs text-ink-muted">
              Over capacity next week:{" "}
              {v.workload.rows
                .filter((r) => r.loadPct[1] > 100)
                .map((r) => `${r.name} (${r.loadPct[1]}%)`)
                .join(", ")}
            </p>
          )}
        </Panel>
      </Grid>

      <Panel
        className="min-w-0"
        title="Leaderboard"
        subtitle="Click a column to sort. Cycle time runs from start (or creation) to done; utilisation is hours logged against 48 productive hours a week, minus holidays."
        flush
        action={
          <CsvButton
            rows={people.sorted}
            filename={`team-performance-${v.range.from}-${v.range.to}`}
            columns={[
              { header: "Person", value: (p) => p.name },
              { header: "Department", value: (p) => p.department },
              { header: "Role", value: (p) => p.role },
              { header: "Tasks done", value: (p) => p.completed },
              { header: "Done previous period", value: (p) => p.completedPrev },
              { header: "On time %", value: (p) => p.onTimePct },
              { header: "Avg cycle days", value: (p) => p.avgCycleDays },
              { header: "Hours", value: (p) => p.hours },
              { header: "Utilisation %", value: (p) => p.utilisation },
              { header: "QC first pass %", value: (p) => p.qcFirstPassPct },
              { header: "Versions checked", value: (p) => p.qcVersions },
              { header: "Avg revision rounds", value: (p) => p.avgRevisionRounds },
              { header: "Overdue now", value: (p) => p.overdueNow },
              { header: "Open tasks", value: (p) => p.openTasks },
            ]}
          />
        }
      >
        <DataTable rows={people.sorted} rowKey={(p) => p.id} columns={personCols} empty="No one here yet." />
      </Panel>

      <Panel
        className="min-w-0"
        title="By department"
        flush
        action={
          <CsvButton
            rows={v.departments}
            filename={`team-departments-${v.range.from}-${v.range.to}`}
            columns={[
              { header: "Department", value: (d) => d.name },
              { header: "People", value: (d) => d.people },
              { header: "Tasks done", value: (d) => d.completed },
              { header: "On time %", value: (d) => d.onTimePct },
              { header: "Avg cycle days", value: (d) => d.avgCycleDays },
              { header: "Hours", value: (d) => d.hours },
              { header: "Utilisation %", value: (d) => d.utilisation },
              { header: "QC first pass %", value: (d) => d.qcFirstPassPct },
              { header: "Overdue now", value: (d) => d.overdueNow },
            ]}
          />
        }
      >
        <DataTable rows={v.departments} rowKey={(d) => d.id ?? "none"} columns={deptCols} />
      </Panel>
    </div>
  );
}
