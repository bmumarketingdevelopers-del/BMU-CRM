"use client";

import Link from "next/link";
import type { OpsDeliveryView, OpsWipRow } from "@bmu/shared";
import { CsvButton, LineChart, usePeriod } from "@/components/charts";
import { BarList, ColumnChart, DataTable, Grid, Panel, StatRow, StatTile, type Column } from "@/components/dash";
import { Badge } from "@/components/ui";
import { api } from "@/lib/api";
import { InsightList, OpsPage, RangeNote, daysText, deltaOf, fmtShort, num, pctText, usePeriodData, wasText } from "../team/ops-kit";

export default function DeliverySpeedPage() {
  const { period, setPeriod } = usePeriod("90d");
  const state = usePeriodData(() => api.opsAnalytics.delivery({ from: period.from, to: period.to }), [period.from, period.to]);
  return (
    <OpsPage title="Delivery speed" subtitle="How long work takes from sign-up to sign-off, where it waits longest, and what is stuck right now." period={period} onPeriod={setPeriod} state={state}>
      {(v) => <Body v={v} />}
    </OpsPage>
  );
}

function Body({ v }: { v: OpsDeliveryView }) {
  const t = v.totals;
  const wipCols: Column<OpsWipRow>[] = [
    {
      key: "title",
      header: "Deliverable",
      cell: (w) => (
        <div className="min-w-44">
          <Link href={`/team/deliverables/${w.id}`} className="font-medium hover:underline">
            {w.title}
          </Link>
          <p className="text-xs text-ink-muted">
            <Link href={`/team/clients/${w.clientId}`} className="hover:underline">
              {w.client}
            </Link>{" "}
            · {w.type}
          </p>
        </div>
      ),
    },
    { key: "status", header: "Stage", cell: (w) => <Badge tone={w.status.toLowerCase().includes("fail") || w.status.toLowerCase().includes("changes") ? "amber" : "neutral"}>{w.status}</Badge> },
    { key: "owner", header: "With", cell: (w) => <span className="text-ink-muted">{w.owner ?? "—"}</span> },
    { key: "age", header: "In progress", align: "right", cell: (w) => <span className={w.ageDays > 15 ? "text-[#b4432c]" : ""}>{w.ageDays}d</span> },
    { key: "quiet", header: "Last activity", align: "right", cell: (w) => (w.sinceUpdateDays ? `${w.sinceUpdateDays}d ago` : "today") },
    { key: "due", header: "Due", align: "right", cell: (w) => (w.dueAt ? <span className={w.overdue ? "text-[#b4432c]" : ""}>{fmtShort(w.dueAt)}</span> : "—") },
  ];
  const slow = v.steps.find((s) => s.key === v.bottleneck);
  return (
    <div className="space-y-8">
      <div>
        <StatRow cols={5}>
          <StatTile label="Deliverables approved" value={num(t.approved.value)} delta={deltaOf(t.approved)} hint={wasText(t.approved.prev, String)} href="/team/reviews" />
          <StatTile label="Draft to approval" value={daysText(t.avgCycleDays.value)} delta={deltaOf(t.avgCycleDays, { lowerIsBetter: true })} hint="working days, average" />
          <StatTile label="QC pass rate" value={pctText(t.qcPassRate.value)} delta={deltaOf(t.qcPassRate)} hint="of all checks" />
          <StatTile label="Approved on time" value={pctText(t.onTimePct.value)} delta={deltaOf(t.onTimePct)} hint="by the due date" />
          <StatTile label="Revision rounds" value={num(t.avgRevisionRounds.value)} delta={deltaOf(t.avgRevisionRounds, { lowerIsBetter: true })} hint="per deliverable" />
        </StatRow>
        <RangeNote range={v.range} />
      </div>

      <Panel title="What this means">
        <InsightList items={v.insights} />
      </Panel>

      <Panel className="min-w-0" title="Time per gate step" subtitle="Working days for each step, counted when the step finished in this period. The slowest step is highlighted.">
        <div className="grid gap-8 lg:grid-cols-[1fr_1.2fr]">
          <BarList
            items={v.steps.map((s) => ({ label: s.label, value: s.avgDays ?? 0, highlight: s.key === v.bottleneck, note: s.count ? `${s.count}×` : "no data" }))}
            format={(n) => (n ? `${n} days` : "—")}
          />
          <DataTable
            rows={v.steps}
            rowKey={(s) => s.key}
            columns={[
              { key: "step", header: "Step", cell: (s) => <div><p className={s.key === v.bottleneck ? "font-semibold" : "font-medium"}>{s.label}</p><p className="text-xs text-ink-muted">{s.detail}</p></div> },
              { key: "avg", header: "Average", align: "right", cell: (s) => daysText(s.avgDays, "d") },
              { key: "median", header: "Median", align: "right", cell: (s) => daysText(s.medianDays, "d") },
              { key: "prev", header: "Before", align: "right", cell: (s) => <span className="text-ink-muted">{daysText(s.prevAvgDays, "d")}</span> },
            ]}
          />
        </div>
        {slow && <p className="mt-4 text-xs text-ink-muted">Bottleneck: {slow.detail.toLowerCase()} ({slow.avgDays} working days on average).</p>}
      </Panel>

      <Grid>
        <Panel className="min-w-0" title="Draft to approval by type" subtitle="Working days from the first version to the client's approval.">
          <BarList items={v.byType.filter((b) => b.avgDays !== null).map((b, i) => ({ label: b.type, value: b.avgDays!, highlight: i === 0, note: `${b.count} done${b.prevAvgDays !== null ? ` · was ${b.prevAvgDays}d` : ""}` }))} format={(n) => `${n}d`} />
        </Panel>
        <Panel className="min-w-0" title="Revision rounds used" subtitle="Deliverables approved in the period, by number of client change rounds.">
          <ColumnChart data={v.revisions.map((r) => ({ label: r.label, value: r.count }))} highlightLast={false} />
        </Panel>
        <Panel className="min-w-0" title="QC pass rate" subtitle={`Share of QC checks that passed, by ${v.range.bucket}.`}>
          <LineChart labels={v.qcTrend.labels} series={[{ ...v.qcTrend.series[0], color: "green" }]} format={(n) => `${Math.round(n)}%`} />
        </Panel>
        <Panel className="min-w-0" title="Approved on time" subtitle={`Share of approvals on or before the due date, by ${v.range.bucket}.`}>
          <LineChart labels={v.onTimeTrend.labels} series={[{ ...v.onTimeTrend.series[0], color: "dark" }]} format={(n) => `${Math.round(n)}%`} />
        </Panel>
      </Grid>

      <Panel
        className="min-w-0"
        title="Work in progress, oldest first"
        subtitle="Deliverables started but not yet approved. Open one to see its tasks and versions."
        flush
        action={
          <CsvButton
            rows={v.wip}
            filename="work-in-progress"
            columns={[
              { header: "Deliverable", value: (w) => w.title },
              { header: "Client", value: (w) => w.client },
              { header: "Type", value: (w) => w.type },
              { header: "Stage", value: (w) => w.status },
              { header: "With", value: (w) => w.owner },
              { header: "Days in progress", value: (w) => w.ageDays },
              { header: "Days since last activity", value: (w) => w.sinceUpdateDays },
              { header: "Due", value: (w) => w.dueAt?.slice(0, 10) },
            ]}
          />
        }
      >
        <DataTable rows={v.wip} rowKey={(w) => w.id} columns={wipCols} empty="Nothing in progress. Everything started has been approved." />
      </Panel>
    </div>
  );
}
