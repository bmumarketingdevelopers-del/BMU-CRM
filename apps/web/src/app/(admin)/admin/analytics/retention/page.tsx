"use client";

import type { SalesMrrMovementKind, SalesRetentionView } from "@bmu/shared";
import { CohortGrid, CsvButton, LineChart, Waterfall, type Period } from "@/components/charts";
import { BarList, DataTable, Grid, KeyValues, Panel, StackBar, StatRow, StatTile } from "@/components/dash";
import { Badge } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { Insights, PeriodLine, PeriodPage, WithData, change, inr, inrShort, rupees } from "../_sales/kit";

export default function RetentionPage() {
  return (
    <PeriodPage title="MRR & Retention" subtitle="Monthly recurring revenue from retainers: what we added, what we lost, and how long clients stay.">
      {(p) => <RetentionBody period={p} />}
    </PeriodPage>
  );
}

function RetentionBody({ period }: { period: Period }) {
  const state = useLoad(() => api.analytics.retention({ from: period.from, to: period.to }));
  return <WithData state={state}>{(d) => <Retention d={d} />}</WithData>;
}

const KIND: Record<SalesMrrMovementKind, { label: string; tone: "green" | "amber" | "red" | "dark" }> = {
  new: { label: "New client", tone: "green" },
  expansion: { label: "Upgrade", tone: "dark" },
  contraction: { label: "Downgrade", tone: "amber" },
  churn: { label: "Left", tone: "red" },
};
const pctText = (n: number | null) => (n === null ? "—" : `${Math.round(n)}%`);

function Retention({ d }: { d: SalesRetentionView }) {
  const w = d.waterfall;
  const rest = Math.max(0, d.concentration.totalPaise - d.concentration.top3.reduce((s, c) => s + c.revenuePaise, 0));
  return (
    <div className="space-y-8">
      <PeriodLine period={d.period} />
      <StatRow cols={5}>
        <StatTile label="MRR now" value={inrShort(w.endPaise)} delta={change(w.endPaise, w.startPaise)} hint={`from ${inrShort(w.startPaise)} at the start`} tone="good" />
        <StatTile label="Net revenue retention" value={pctText(d.nrrPct)} delta={change(d.nrrPct, d.prevNrrPct, { unit: "pct" })} hint="existing clients only" tone={d.nrrPct !== null && d.nrrPct < 90 ? "warn" : "default"} />
        <StatTile label="Client churn" value={pctText(d.logoChurnPct)} delta={change(d.logoChurnPct, d.prevLogoChurnPct, { unit: "pct", lowerIsBetter: true })} hint="retainer clients who left" tone={d.logoChurnPct !== null && d.logoChurnPct > 10 ? "warn" : "default"} />
        <StatTile label="Revenue churn" value={pctText(d.revenueChurnPct)} delta={change(d.revenueChurnPct, d.prevRevenueChurnPct, { unit: "pct", lowerIsBetter: true })} hint="MRR lost to exits and downgrades" />
        <StatTile label="Retainer clients" value={d.retainerClients} delta={change(d.retainerClients, d.prevRetainerClients)} hint={d.avgLifetimeMonths === null ? "nobody has left yet" : `leavers stayed ${d.avgLifetimeMonths} months`} />
      </StatRow>

      <Grid>
        <Panel className="min-w-0" title="MRR by month" subtitle="Retainers running at the end of each month, last 12 months">
          <LineChart labels={d.mrrTrend.map((m) => m.label)} series={[{ key: "mrr", label: "MRR", values: d.mrrTrend.map((m) => m.mrrPaise), area: true }]} format={inrShort} height={190} />
        </Panel>
        <Panel className="min-w-0" title="What changed in this period" subtitle="Start, new clients, upgrades, downgrades, clients who left, end">
          <Waterfall
            start={{ label: "Start", value: w.startPaise }}
            steps={[
              { label: "New", value: w.newPaise },
              { label: "Upgrades", value: w.expansionPaise },
              { label: "Downgrades", value: w.contractionPaise },
              { label: "Left", value: w.churnPaise },
            ]}
            format={inrShort}
            height={170}
          />
        </Panel>
      </Grid>
      <Insights items={d.insights} />

      <Panel
        className="min-w-0"
        title="Clients behind the change"
        flush
        action={
          <CsvButton
            rows={d.movements}
            filename="mrr-movements"
            columns={[
              { header: "Client", value: (m) => m.client },
              { header: "Change", value: (m) => KIND[m.kind].label },
              { header: "MRR at start (₹)", value: (m) => rupees(m.startPaise) },
              { header: "MRR at end (₹)", value: (m) => rupees(m.endPaise) },
              { header: "Difference (₹)", value: (m) => rupees(m.endPaise - m.startPaise) },
            ]}
          />
        }
      >
        <DataTable
          rows={d.movements}
          rowKey={(m) => m.clientId}
          rowHref={(m) => `/team/clients/${m.clientId}`}
          empty="No retainer changes in this period."
          columns={[
            { key: "c", header: "Client", cell: (m) => m.client },
            { key: "k", header: "Change", cell: (m) => <Badge tone={KIND[m.kind].tone}>{KIND[m.kind].label}</Badge> },
            { key: "s", header: "Start", align: "right", cell: (m) => inr(m.startPaise) },
            { key: "e", header: "End", align: "right", cell: (m) => inr(m.endPaise) },
            { key: "d", header: "Difference", align: "right", cell: (m) => <span className={m.endPaise >= m.startPaise ? "text-[#5f8a12]" : "text-[#b4432c]"}>{m.endPaise >= m.startPaise ? "+" : "−"}{inr(Math.abs(m.endPaise - m.startPaise))}</span> },
          ]}
        />
      </Panel>

      <Panel className="min-w-0" title="How long clients stay" subtitle="Clients grouped by the month they started; share still working with us 1 to 11 months later">
        <CohortGrid cohorts={d.cohorts} periods={Array.from({ length: 11 }, (_, i) => `+${i + 1}`)} />
      </Panel>

      <Grid>
        <Panel className="min-w-0" title="Top clients by lifetime revenue" subtitle="Everything invoiced since they started, before GST">
          <BarList items={d.topClients.map((c, i) => ({ label: c.name, value: c.lifetimePaise, href: `/team/clients/${c.id}`, highlight: i === 0, note: c.active ? `${c.months} mo` : "left" }))} format={inrShort} />
        </Panel>
        <Panel className="min-w-0" title="Revenue concentration" subtitle="Share of this period's revenue from the three biggest clients">
          <StackBar
            parts={[
              ...d.concentration.top3.map((c, i) => ({ label: c.name, value: c.revenuePaise, tone: (["dark", "grey", "muted"] as const)[i] })),
              { label: "Everyone else", value: rest, tone: "green" as const },
            ]}
            format={inrShort}
          />
          <div className="mt-5">
            <KeyValues
              items={[
                { k: "Top 3 share", v: <span className={d.concentration.top3Pct !== null && d.concentration.top3Pct > 50 ? "text-[#9a6b00]" : ""}>{pctText(d.concentration.top3Pct)}</span> },
                { k: "Revenue this period", v: inr(d.concentration.totalPaise) },
                { k: "Average stay of clients who left", v: d.avgLifetimeMonths === null ? "—" : `${d.avgLifetimeMonths} months (${d.churnedClients} client${d.churnedClients === 1 ? "" : "s"})` },
              ]}
            />
          </div>
        </Panel>
      </Grid>
    </div>
  );
}
