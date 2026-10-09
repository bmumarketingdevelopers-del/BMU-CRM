"use client";

import Link from "next/link";
import { formatINR, type PayoutView } from "@bmu/shared";
import { DataTable, Panel, StatRow, StatTile } from "@/components/dash";
import { fmtDate } from "@/components/workspace/format";
import { Badge, LoadState, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

export default function PayoutsPage() {
  const loaded = useLoad(() => api.creator.payouts());
  const p = loaded.data;
  return (
    <div className="[&_.grid>*]:min-w-0">
      <PageTitle title="Payouts" subtitle="Each approved brief books a payout: your fee minus 10% TDS, which is deposited against your PAN." />
      {!p ? (
        <LoadState loading={loaded.loading} error={loaded.error} />
      ) : (
        <div className="[&_.grid>*]:min-w-0">
          <StatRow cols={3}>
            <StatTile label="Pending" value={formatINR(p.totals.pendingPaise)} tone={p.totals.pendingPaise ? "warn" : "default"} hint="Net, on its way" />
            <StatTile label="Paid to you" value={formatINR(p.totals.paidPaise)} tone={p.totals.paidPaise ? "good" : "default"} hint="Net received" />
            <StatTile label="TDS deducted" value={formatINR(p.totals.tdsPaise)} hint="Claim it when you file your return" />
          </StatRow>
          <Panel title="All payouts" className="mt-6" flush>
            <DataTable<PayoutView>
              rows={p.items}
              rowKey={(x) => x.id}
              rowHref={(x) => (x.briefId ? `/creator/briefs/${x.briefId}` : undefined)}
              empty="No payouts yet. They appear here when BMU approves your work."
              columns={[
                { key: "b", header: "Brief", cell: (x) => x.briefTitle ?? "Payout" },
                { key: "d", header: "Booked", cell: (x) => fmtDate.format(new Date(x.createdAt)) },
                { key: "f", header: "Fee", align: "right", cell: (x) => formatINR(x.amountPaise) },
                { key: "t", header: "TDS", align: "right", cell: (x) => <span className="text-ink-muted">− {formatINR(x.tdsPaise)}</span> },
                { key: "n", header: "Net", align: "right", cell: (x) => <span className="font-semibold">{formatINR(x.netPaise)}</span> },
                { key: "s", header: "Status", align: "right", cell: (x) => <Badge tone={x.status === "paid" ? "green" : x.status === "on_hold" ? "red" : "amber"}>{x.status === "paid" ? `Paid${x.paidAt ? ` ${fmtDate.format(new Date(x.paidAt))}` : ""}` : x.status === "on_hold" ? "On hold" : "Pending"}</Badge> },
              ]}
            />
          </Panel>
          <p className="mt-4 text-xs text-ink-muted">
            Questions about a payout? Reply on the brief or <Link href="/creator/profile" className="underline">check your details</Link>.
          </p>
        </div>
      )}
    </div>
  );
}
