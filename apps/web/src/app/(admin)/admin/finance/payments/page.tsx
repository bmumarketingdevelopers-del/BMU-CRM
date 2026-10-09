"use client";

import Link from "next/link";
import { useState } from "react";
import { paymentMethodLabels, type PaymentRow } from "@bmu/shared";
import { BarList, DataTable, Grid, Panel, StackBar, StatRow, StatTile, Tabs } from "@/components/dash";
import { PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { WithData, fmtDateTime, inr, inrShort } from "../../_insights/kit";

type Filter = "all" | "razorpay" | "offline";

export default function PaymentsPage() {
  const state = useLoad(() => api.finance.payments());
  const [filter, setFilter] = useState<Filter>("all");
  return (
    <>
      <PageTitle title="Payments" subtitle="Every payment received, online through Razorpay or recorded by hand." />
      <WithData state={state}>
        {(p) => {
          const rows = p.rows.filter((r) => filter === "all" || (filter === "razorpay" ? r.method === "razorpay" : r.method !== "razorpay"));
          return (
            <div className="space-y-8">
              <StatRow cols={4}>
                <StatTile label="This month" value={inr(p.thisMonthPaise)} tone="good" />
                <StatTile label="All time" value={inr(p.totalPaise)} hint={`${p.rows.length} payments`} />
                <StatTile label="Through Razorpay" value={inr(p.razorpayPaise)} />
                <StatTile label="Recorded offline" value={inr(p.offlinePaise)} hint="bank, UPI, cash, cheque" />
              </StatRow>
              <Grid>
                <Panel className="min-w-0" title="Online and offline">
                  <StackBar
                    parts={[
                      { label: "Razorpay", value: p.razorpayPaise, tone: "dark" },
                      { label: "Offline", value: p.offlinePaise, tone: "grey" },
                    ]}
                    format={inrShort}
                  />
                </Panel>
                <Panel className="min-w-0" title="By method">
                  <BarList items={p.byMethod.map((m) => ({ label: m.label, value: m.valuePaise, note: `${m.count}×` }))} format={inr} />
                </Panel>
              </Grid>
              <Panel className="min-w-0"
                title="All payments"
                subtitle="Newest first"
                flush
                action={
                  <Tabs
                    value={filter}
                    onChange={setFilter}
                    options={[
                      { value: "all", label: "All" },
                      { value: "razorpay", label: "Razorpay" },
                      { value: "offline", label: "Offline" },
                    ]}
                  />
                }
              >
                <DataTable<PaymentRow>
                  rows={rows}
                  rowKey={(r) => r.id}
                  empty="No payments yet."
                  columns={[
                    { key: "at", header: "When", cell: (r) => <span className="whitespace-nowrap">{fmtDateTime(r.at)}</span> },
                    { key: "client", header: "Client", cell: (r) => r.client },
                    { key: "inv", header: "Invoice", cell: (r) => <Link href={`/admin/finance/invoices/${r.invoiceId}`} className="whitespace-nowrap hover:underline">{r.invoiceNumber}</Link> },
                    { key: "method", header: "How", cell: (r) => paymentMethodLabels[r.method] ?? r.method },
                    { key: "ref", header: "Reference", cell: (r) => <span className="text-ink-muted">{r.ref ?? "—"}</span> },
                    { key: "amt", header: "Amount", align: "right", cell: (r) => <span className="font-medium">{inr(r.amountPaise)}</span> },
                  ]}
                />
              </Panel>
            </div>
          );
        }}
      </WithData>
    </>
  );
}
