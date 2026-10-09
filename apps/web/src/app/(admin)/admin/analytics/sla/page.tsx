"use client";

import Link from "next/link";
import type { OpsAmRow, OpsOpenRequestRow, OpsSlaTypeRow, OpsSlaView } from "@bmu/shared";
import { SatisfactionPanel } from "@/components/service/satisfaction-panel";
import { CsvButton, Heatmap, LineChart, usePeriod } from "@/components/charts";
import { DataTable, KeyValues, Meter, Panel, StatRow, StatTile, type Column } from "@/components/dash";
import { Badge } from "@/components/ui";
import { api } from "@/lib/api";
import { InsightList, OpsPage, RangeNote, deltaOf, fmtDateTime, minutesText, num, pctText, usePeriodData, wasText } from "../team/ops-kit";

const hourLabel = (h: string) => {
  const n = Number(h);
  return n === 0 ? "12a" : n < 12 ? `${n}a` : n === 12 ? "12p" : `${n - 12}p`;
};

export default function SlaPage() {
  const { period, setPeriod } = usePeriod("90d");
  const state = usePeriodData(() => api.opsAnalytics.sla({ from: period.from, to: period.to }), [period.from, period.to]);
  return (
    <OpsPage title="SLA & response" subtitle="How fast clients get a first reply, when requests arrive, and where reply times slip. Times are working time (9:30–6:30, Mon–Sat)." period={period} onPeriod={setPeriod} state={state}>
      {(v) => <Body v={v} />}
    </OpsPage>
  );
}

function Body({ v }: { v: OpsSlaView }) {
  const t = v.totals;
  const typeCols: Column<OpsSlaTypeRow>[] = [
    { key: "type", header: "Request type", cell: (r) => <span className="font-medium">{r.label}</span> },
    { key: "target", header: "Target", align: "right", cell: (r) => minutesText(r.targetMin) },
    { key: "count", header: "Requests", align: "right", cell: (r) => r.count },
    { key: "avg", header: "Average reply", align: "right", cell: (r) => <span className={r.avgReplyMin !== null && r.avgReplyMin > r.targetMin ? "text-[#b4432c]" : ""}>{minutesText(r.avgReplyMin)}</span> },
    { key: "median", header: "Median", align: "right", cell: (r) => minutesText(r.medianReplyMin) },
    { key: "within", header: "Within target", className: "min-w-32", cell: (r) => (r.withinPct === null ? <span className="text-ink-muted">—</span> : <Meter value={r.withinPct} tone={r.withinPct >= 85 ? "good" : r.withinPct < 70 ? "bad" : "warn"} />) },
    { key: "prev", header: "Before", align: "right", cell: (r) => <span className="text-ink-muted">{pctText(r.prevWithinPct)}</span> },
  ];
  const amCols: Column<OpsAmRow>[] = [
    { key: "name", header: "Account Manager", cell: (a) => <span className="font-medium">{a.name}</span> },
    { key: "requests", header: "Requests", align: "right", cell: (a) => a.requests },
    { key: "avg", header: "Average first reply", align: "right", cell: (a) => minutesText(a.avgReplyMin) },
    { key: "within", header: "Within target", className: "min-w-32", cell: (a) => (a.withinPct === null ? "—" : <Meter value={a.withinPct} tone={a.withinPct >= 85 ? "good" : a.withinPct < 70 ? "bad" : "warn"} />) },
    { key: "missed", header: "Missed", align: "right", cell: (a) => (a.breaches ? <span className="text-[#b4432c]">{a.breaches}</span> : 0) },
  ];
  const openCols: Column<OpsOpenRequestRow>[] = [
    {
      key: "desc",
      header: "Request",
      cell: (r) => (
        <div className="min-w-52 max-w-md">
          <Link href={`/team/requests/${r.id}`} className="font-medium hover:underline">
            {r.description}
          </Link>
          <p className="text-xs text-ink-muted">
            <Link href={`/team/clients/${r.clientId}`} className="hover:underline">
              {r.client}
            </Link>{" "}
            · {r.typeLabel} · {r.am ?? "No AM"}
          </p>
        </div>
      ),
    },
    { key: "status", header: "Status", cell: (r) => (r.pastSla ? <Badge tone="red">Past reply target</Badge> : r.replied ? <Badge>Replied · {r.status}</Badge> : <Badge tone="amber">Waiting for reply</Badge>) },
    { key: "raised", header: "Raised", align: "right", cell: (r) => fmtDateTime(r.createdAt) },
    { key: "wait", header: "Working time", align: "right", cell: (r) => <span title={r.replied ? "Until the first reply" : "Waiting so far"}>{minutesText(r.waitingMin)}</span> },
  ];

  return (
    <div className="space-y-8">
      <div>
        <StatRow cols={5}>
          <StatTile label="Client requests" value={num(t.requests.value)} delta={deltaOf(t.requests)} hint={wasText(t.requests.prev, String)} href="/team/requests" />
          <StatTile label="Replied within target" value={pctText(t.withinPct.value)} delta={deltaOf(t.withinPct)} tone={(t.withinPct.value ?? 100) < 80 ? "warn" : "good"} hint="first reply" />
          <StatTile label="Average first reply" value={minutesText(t.avgReplyMin.value)} delta={deltaOf(t.avgReplyMin, { lowerIsBetter: true })} hint="working time" />
          <StatTile label="Reply times missed" value={num(t.breaches.value)} delta={deltaOf(t.breaches, { lowerIsBetter: true })} tone={t.breaches.value ? "warn" : "default"} hint={wasText(t.breaches.prev, String)} />
          <StatTile label="Waiting past target now" value={t.openPastSla} tone={t.openPastSla ? "bad" : "good"} hint="no reply yet" href="/team/requests" />
        </StatRow>
        <RangeNote range={v.range} />
      </div>

      <Panel title="What this means">
        <InsightList items={v.insights} />
      </Panel>

      <Panel
        className="min-w-0"
        title="First reply by request type"
        subtitle="Targets come from Command Centre → SLA rules."
        flush
        action={
          <CsvButton
            rows={v.byType}
            filename={`sla-by-type-${v.range.from}-${v.range.to}`}
            columns={[
              { header: "Type", value: (r) => r.label },
              { header: "Target minutes", value: (r) => r.targetMin },
              { header: "Requests", value: (r) => r.count },
              { header: "Average reply minutes", value: (r) => r.avgReplyMin },
              { header: "Median reply minutes", value: (r) => r.medianReplyMin },
              { header: "Within target %", value: (r) => r.withinPct },
              { header: "Within target % before", value: (r) => r.prevWithinPct },
              { header: "Missed", value: (r) => r.breaches },
            ]}
          />
        }
      >
        <DataTable rows={v.byType} rowKey={(r) => r.type} columns={typeCols} empty="No client requests in this period." />
      </Panel>

      <Panel className="min-w-0" title={`Replied within target, by ${v.range.bucket}`}>
        <LineChart labels={v.trend.labels} series={[{ ...v.trend.series[0], color: "green", area: true }]} format={(n) => `${Math.round(n)}%`} />
      </Panel>

      <div className="space-y-8">
        <Panel className="min-w-0" title="When requests arrive" subtitle="Requests by weekday and hour (IST).">
          <Heatmap rows={v.heatmap.rows} cols={v.heatmap.cols.map(hourLabel)} values={v.heatmap.requests.map((r) => r.map((n) => n || null))} cellTitle={(ri, ci, n) => `${v.heatmap.rows[ri]} ${hourLabel(v.heatmap.cols[ci])}: ${n ?? 0} requests`} />
        </Panel>
        <Panel className="min-w-0" title="When replies are missed" subtitle="Requests that missed the reply target, by when they came in.">
          <Heatmap tone="red" rows={v.heatmap.rows} cols={v.heatmap.cols.map(hourLabel)} values={v.heatmap.breaches.map((r) => r.map((n) => n || null))} cellTitle={(ri, ci, n) => `${v.heatmap.rows[ri]} ${hourLabel(v.heatmap.cols[ci])}: ${n ?? 0} missed`} />
        </Panel>
      </div>

      <div className="grid gap-6 2xl:grid-cols-2">
        <Panel className="min-w-0" title="Account Managers" subtitle="Fastest average first reply first." flush>
          <DataTable rows={v.ams} rowKey={(a) => a.id} columns={amCols} empty="No requests in this period." />
        </Panel>
        <Panel className="min-w-0" title="Message replies" subtitle="Client messages in app threads and whether the team answered in time.">
          {v.messages ? (
            <KeyValues
              items={[
                { k: "Rule", v: v.messages.rule },
                { k: "Client messages", v: v.messages.clientMessages },
                { k: "Answered", v: v.messages.replied },
                { k: "Answered in time", v: `${pctText(v.messages.sameDayPct.value)}${v.messages.sameDayPct.prev !== null ? ` (was ${pctText(v.messages.sameDayPct.prev)})` : ""}` },
                { k: "Average reply", v: `${minutesText(v.messages.avgReplyMin)} working time` },
              ]}
            />
          ) : (
            <p className="py-6 text-center text-sm text-ink-muted">Not enough client messages in this period to measure.</p>
          )}
        </Panel>
        <SatisfactionPanel from={v.range.from} to={v.range.to} />
      </div>

      <Panel
        className="min-w-0"
        title="Open requests, slowest first"
        subtitle="Requests not yet closed. Past-target ones come first."
        flush
        action={
          <CsvButton
            rows={v.slowest}
            filename="open-requests"
            columns={[
              { header: "Request", value: (r) => r.description },
              { header: "Client", value: (r) => r.client },
              { header: "Type", value: (r) => r.typeLabel },
              { header: "Account Manager", value: (r) => r.am },
              { header: "Raised", value: (r) => r.createdAt },
              { header: "Working minutes", value: (r) => r.waitingMin },
              { header: "Replied", value: (r) => (r.replied ? "yes" : "no") },
              { header: "Past target", value: (r) => (r.pastSla ? "yes" : "no") },
            ]}
          />
        }
      >
        <DataTable rows={v.slowest} rowKey={(r) => r.id} columns={openCols} empty="No open requests. Nice." />
      </Panel>
    </div>
  );
}
