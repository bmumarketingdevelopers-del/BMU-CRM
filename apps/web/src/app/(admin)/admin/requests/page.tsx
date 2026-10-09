"use client";

import { useState } from "react";
import { formatINR, requestStatusLabels, requestTypeLabels, type RequestView } from "@bmu/shared";
import { BarList, DataTable, Panel, StatRow, StatTile, Tabs, type Column } from "@/components/dash";
import { Badge, LoadState, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { fmtDate } from "../_admin-org/kit";

const CLOSED = ["done", "declined"];
type Show = "open" | "late" | "quoted" | "all";
const istMonth = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 7);

export default function AdminRequestsPage() {
  const reqs = useLoad(() => api.requests.list());
  const addOns = useLoad(() => api.requests.addOns());
  const [show, setShow] = useState<Show>("open");

  const all = reqs.data ?? [];
  const month = istMonth(new Date());
  const isLate = (r: RequestView) => r.sla.state === "overdue";
  const open = all.filter((r) => !CLOSED.includes(r.status));
  const quoted = all.filter((r) => r.status === "quoted");
  const approvedThisMonth = all.filter((r) => r.quote && r.approval && istMonth(new Date(r.approval.at)) === month);
  const addOnRevenue = approvedThisMonth.reduce((s, r) => s + (r.quote?.amountPaise ?? 0), 0);
  const rows = { open, late: all.filter(isLate), quoted, all }[show];

  const byClient = [...open.reduce((m, r) => m.set(r.client.name, (m.get(r.client.name) ?? 0) + 1), new Map<string, number>()).entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);

  const columns: Column<RequestView>[] = [
    {
      key: "what",
      header: "Request",
      cell: (r) => (
        <span className="block max-w-sm">
          <span className="line-clamp-1">{r.description}</span>
          <span className="block text-xs font-normal text-ink-muted">
            {r.client.name} · {r.engagement.serviceName}
          </span>
        </span>
      ),
    },
    { key: "type", header: "Type", cell: (r) => <span className="whitespace-nowrap">{requestTypeLabels[r.type]?.team ?? r.type}</span> },
    { key: "status", header: "Status", cell: (r) => <Badge tone={r.status === "quoted" ? "amber" : CLOSED.includes(r.status) ? "neutral" : "dark"}>{requestStatusLabels[r.status]?.team ?? r.status}</Badge> },
    {
      key: "sla",
      header: "First reply",
      cell: (r) =>
        r.sla.state === "overdue" ? (
          <Badge tone="red">Past SLA</Badge>
        ) : r.sla.state === "breached" ? (
          <span className="text-xs text-[#9a6b00]">Replied late</span>
        ) : r.sla.state === "met" ? (
          <span className="text-xs text-ink-muted">On time</span>
        ) : (
          <span className="text-xs">Due {r.sla.firstReplyDue ? fmtDate(r.sla.firstReplyDue) : "—"}</span>
        ),
    },
    { key: "quote", header: "Quote", align: "right", cell: (r) => (r.quote ? formatINR(r.quote.amountPaise) : "—") },
    { key: "at", header: "Raised", align: "right", cell: (r) => <span className="whitespace-nowrap">{fmtDate(r.createdAt)}</span> },
  ];

  return (
    <>
      <PageTitle title="Requests & Add-ons" subtitle="Every client request across all accounts: what is waiting, what is late, and the extra work clients have approved." />
      <LoadState loading={reqs.loading && !reqs.data} error={reqs.error} />
      {reqs.data && (
        <div className="space-y-6">
          <StatRow>
            <StatTile label="Open requests" value={open.length} />
            <StatTile label="Past first-reply SLA" value={all.filter(isLate).length} tone={all.some(isLate) ? "bad" : "default"} hint="working hours" />
            <StatTile label="Quotes waiting for client" value={quoted.length} hint={quoted.length ? formatINR(quoted.reduce((s, r) => s + (r.quote?.amountPaise ?? 0), 0)) : undefined} />
            <StatTile label="Add-ons approved this month" value={formatINR(addOnRevenue)} tone={addOnRevenue ? "good" : "default"} hint={`${approvedThisMonth.length} approved · before GST`} />
          </StatRow>

          <div className="grid grid-cols-1 gap-6 [&>*]:min-w-0 lg:grid-cols-[2fr_1fr]">
            <Panel
              title="Requests"
              action={
                <Tabs
                  value={show}
                  onChange={setShow}
                  options={[
                    { value: "open", label: "Open" },
                    { value: "late", label: "Past SLA" },
                    { value: "quoted", label: "Quoted" },
                    { value: "all", label: "All" },
                  ]}
                />
              }
              flush
            >
              <DataTable rows={rows} columns={columns} rowKey={(r) => r.id} rowHref={(r) => `/team/requests/${r.id}`} empty={show === "late" ? "Nothing is past its SLA." : "No requests here."} />
            </Panel>
            <div className="space-y-6">
              <Panel title="Open requests by client">
                <BarList items={byClient.map(([label, value]) => ({ label, value }))} />
              </Panel>
              <Panel title="Add-on price list" subtitle="Edit under Catalogue → Add-ons" flush>
                <LoadState loading={addOns.loading && !addOns.data} error={addOns.error} />
                <ul className="divide-y divide-border text-sm">
                  {(addOns.data ?? []).map((a) => (
                    <li key={a.id} className="flex items-baseline justify-between gap-3 px-5 py-2.5">
                      <span>{a.name}</span>
                      <span className="shrink-0 tabular-nums text-ink-muted">{a.isCustomQuote || a.pricePaise === null ? "Custom quote" : `${formatINR(a.pricePaise)}${a.unit ? ` / ${a.unit}` : ""}`}</span>
                    </li>
                  ))}
                  {addOns.data?.length === 0 && <li className="px-5 py-6 text-center text-ink-muted">No add-ons in the active price book.</li>}
                </ul>
              </Panel>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
