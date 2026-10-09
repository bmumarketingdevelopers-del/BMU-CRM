"use client";

import Link from "next/link";
import type { OpsClientView } from "@bmu/shared";
import { CsvButton, usePeriod } from "@/components/charts";
import { BarList, ColumnChart, DataTable, Grid, Meter, Panel, StatRow, StatTile } from "@/components/dash";
import { Badge } from "@/components/ui";
import { api } from "@/lib/api";
import { AdResults } from "@/components/integrations/ad-results";
import { InsightList, OpsPage, RangeNote, deltaOf, fmtShort, inr, inrShort, num, pctText, usePeriodData } from "@/app/(admin)/admin/analytics/team/ops-kit";

export default function ClientInsightsPage() {
  const { period, setPeriod } = usePeriod("6m");
  const state = usePeriodData(() => api.opsAnalytics.client({ from: period.from, to: period.to }), [period.from, period.to]);
  return (
    <OpsPage title="Insights" subtitle="What we delivered for you, how quickly we replied, and how your package is being used." period={period} onPeriod={setPeriod} state={state}>
      {(v) => <Body v={v} />}
    </OpsPage>
  );
}

function Body({ v }: { v: OpsClientView }) {
  const t = v.totals;
  const usedPct = v.revisions.allowance ? (v.revisions.used / v.revisions.allowance) * 100 : 0;
  return (
    <div className="space-y-8">
      <div>
        <StatRow cols={4}>
          <StatTile label="Work approved" value={num(t.approved.value)} delta={deltaOf(t.approved)} hint="pieces you signed off" href="/client/reviews" />
          <StatTile label="First reply to requests" value={t.firstReplyHours.value === null ? "—" : `${t.firstReplyHours.value}h`} delta={deltaOf(t.firstReplyHours, { lowerIsBetter: true })} hint="working hours, on average" href="/client/requests" />
          <StatTile label="Draft to approval" value={t.draftToApprovalDays.value === null ? "—" : `${t.draftToApprovalDays.value} days`} delta={deltaOf(t.draftToApprovalDays, { lowerIsBetter: true })} hint="working days, including your review" />
          <StatTile label="Delivered on time" value={pctText(t.onTimePct.value)} delta={deltaOf(t.onTimePct)} hint="approved by the promised date" />
        </StatRow>
        <RangeNote range={v.range} />
      </div>

      <Panel title="In short">
        <InsightList items={v.insights} />
      </Panel>

      <AdResults audience="client" load={() => api.integrations.clientResults()} />

      <Grid>
        <Panel className="min-w-0" title="Work approved each month">
          <ColumnChart data={v.approvedByMonth} />
        </Panel>
        <Panel className="min-w-0" title="Revision rounds" subtitle="Change rounds used on approved work, against what your package includes.">
          {v.revisions.allowance ? (
            <div className="space-y-4">
              <p className="text-3xl font-semibold tabular-nums">
                {v.revisions.used} <span className="text-base font-normal text-ink-muted">of {v.revisions.allowance} included rounds used</span>
              </p>
              <Meter value={usedPct} tone={usedPct > 100 ? "warn" : "good"} />
              <p className="text-sm text-ink-muted">
                {v.revisions.overAllowance
                  ? `${v.revisions.overAllowance} ${v.revisions.overAllowance === 1 ? "piece" : "pieces"} needed more rounds than included.`
                  : "Every piece stayed within its included rounds."}
              </p>
            </div>
          ) : (
            <p className="py-6 text-center text-sm text-ink-muted">No approved work in this period yet.</p>
          )}
        </Panel>
        <Panel className="min-w-0" title="Your requests by type" subtitle={`${t.requests.value ?? 0} in this period${t.requests.prev !== null ? `, ${t.requests.prev} in the period before` : ""}.`}>
          <BarList items={v.requestsByType.map((r) => ({ label: r.label, value: r.count, href: "/client/requests" }))} />
        </Panel>
        {v.canSeeMoney && v.spendByMonth && (
          <Panel className="min-w-0" title="Spend each month" subtitle={`Invoices raised, including 18% GST (dark), and payments made (grey). Total ${inr(v.spendTotalPaise ?? 0)}.`} action={<Link href="/client/billing" className="text-sm text-ink-muted hover:text-ink">Billing →</Link>}>
            <ColumnChart data={v.spendByMonth.map((m) => ({ label: m.label, value: m.invoicedPaise, secondary: m.paidPaise }))} format={inrShort} highlightLast={false} />
          </Panel>
        )}
      </Grid>

      <Panel
        className="min-w-0"
        title="Delivered work"
        subtitle="Everything you approved in this period. Open one to see it in Review Studio."
        flush
        action={
          <CsvButton
            rows={v.delivered}
            filename={`delivered-work-${v.range.from}-${v.range.to}`}
            columns={[
              { header: "Work", value: (d) => d.title },
              { header: "Type", value: (d) => d.type },
              { header: "Approved", value: (d) => d.approvedAt.slice(0, 10) },
              { header: "Revision rounds", value: (d) => d.rounds },
              { header: "Rounds included", value: (d) => d.allowance },
              { header: "On time", value: (d) => (d.onTime === null ? "" : d.onTime ? "yes" : "no") },
            ]}
          />
        }
      >
        <DataTable
          rows={v.delivered}
          rowKey={(d) => d.id}
          rowHref={(d) => `/client/reviews/${d.id}`}
          empty="Nothing approved in this period yet."
          columns={[
            { key: "title", header: "Work", className: "min-w-40", cell: (d) => d.title },
            { key: "type", header: "Type", cell: (d) => <span className="text-ink-muted">{d.type}</span> },
            { key: "approved", header: "Approved", align: "right", cell: (d) => fmtShort(d.approvedAt) },
            { key: "rounds", header: "Rounds", align: "right", cell: (d) => <span className={d.rounds > d.allowance ? "text-[#9a6b00]" : ""}>{d.rounds} of {d.allowance}</span> },
            { key: "onTime", header: "On time", cell: (d) => (d.onTime === null ? <span className="text-ink-muted">—</span> : d.onTime ? <Badge tone="green">On time</Badge> : <Badge>A little late</Badge>) },
          ]}
        />
      </Panel>
    </div>
  );
}
