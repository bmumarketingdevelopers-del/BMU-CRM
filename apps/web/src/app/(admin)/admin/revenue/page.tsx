"use client";

import { useState } from "react";
import type { RevenuePeriod } from "@bmu/shared";
import { BarList, ColumnChart, DataTable, Grid, KeyValues, Panel, StackBar, StatRow, StatTile, Tabs } from "@/components/dash";
import { PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { Legend, WithData, inr, inrShort } from "../_insights/kit";

const PERIODS: { value: RevenuePeriod; label: string }[] = [
  { value: "month", label: "This month" },
  { value: "quarter", label: "This quarter" },
  { value: "fy", label: "This financial year" },
];

export default function RevenuePage() {
  const [period, setPeriod] = useState<RevenuePeriod>("month");
  return (
    <>
      <PageTitle title="Revenue" subtitle="What we billed, what came in, and where it comes from." action={<Tabs value={period} options={PERIODS} onChange={setPeriod} />} />
      <RevenueBody key={period} period={period} />
    </>
  );
}

function RevenueBody({ period }: { period: RevenuePeriod }) {
  const state = useLoad(() => api.insights.revenue(period));
  return (
    <WithData state={state}>
      {(r) => {
        const splitTotal = r.split.reduce((s, x) => s + x.valuePaise, 0);
        return (
          <div className="space-y-8">
            <p className="-mt-4 text-sm text-ink-muted">{r.periodLabel}</p>
            <StatRow cols={5}>
              <StatTile label="Revenue" value={inr(r.revenuePaise)} hint="before GST, after credit notes" />
              <StatTile label="Invoiced" value={inr(r.invoicedPaise)} hint="including GST" href="/admin/finance/invoices" />
              <StatTile label="Collected" value={inr(r.collectedPaise)} hint="payments received" href="/admin/finance/payments" />
              <StatTile label="Monthly recurring" value={inr(r.mrrPaise)} hint={`${r.activeRetainers} active retainer${r.activeRetainers === 1 ? "" : "s"}`} tone="good" />
              <StatTile label="GST collected" value={inr(r.gstPaise)} hint={r.creditNotesPaise ? `after ${inrShort(r.creditNotesPaise)} credit notes` : "on invoices"} href="/admin/finance/gst" />
            </StatRow>

            <Panel className="min-w-0" title="Invoiced and collected by month" subtitle="Including GST" action={<Legend items={[{ label: "Invoiced", className: "bg-grey/60" }, { label: "Collected", className: "bg-charcoal" }]} />}>
              <ColumnChart data={r.byMonth.map((m) => ({ label: m.label, value: m.collectedPaise, secondary: m.invoicedPaise }))} format={inrShort} height={200} highlightLast={false} />
            </Panel>

            <Grid>
              <Panel className="min-w-0" title="Revenue by service" subtitle="Before GST">
                <BarList items={r.byService.map((s, i) => ({ label: s.label, value: s.valuePaise, highlight: i === 0 }))} format={inr} />
              </Panel>
              <Panel className="min-w-0" title="Revenue by client" subtitle="Before GST">
                <BarList items={r.byClient.map((c) => ({ label: c.label, value: c.valuePaise, href: c.id !== "none" ? `/team/clients/${c.id}` : undefined }))} format={inr} />
              </Panel>
            </Grid>

            <Grid>
              <Panel className="min-w-0" title="Projects and retainers" subtitle="Share of revenue this period">
                <StackBar
                  parts={r.split.map((s) => ({ label: s.label, value: s.valuePaise, tone: s.label === "Retainers" ? "dark" : s.label === "Projects" ? "green" : s.label === "Add-ons" ? "grey" : "muted" }))}
                  format={inrShort}
                />
                <div className="mt-5">
                  <KeyValues items={r.split.map((s) => ({ k: s.label, v: `${inr(s.valuePaise)} · ${splitTotal ? Math.round((s.valuePaise / splitTotal) * 100) : 0}%` }))} />
                </div>
              </Panel>
              <Panel className="min-w-0" title="Active retainers" subtitle="Monthly price from the current price book" flush>
                <DataTable
                  rows={r.retainers}
                  rowKey={(x) => x.engagementId}
                  empty="No active retainers."
                  columns={[
                    { key: "client", header: "Client", cell: (x) => <span className="font-medium">{x.client}</span> },
                    { key: "service", header: "Service", cell: (x) => <span className="text-ink-muted">{x.service} · <span className="capitalize">{x.tier}</span></span> },
                    { key: "price", header: "Per month", align: "right", cell: (x) => inr(x.pricePaise) },
                  ]}
                />
              </Panel>
            </Grid>
          </div>
        );
      }}
    </WithData>
  );
}
