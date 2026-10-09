"use client";

import Link from "next/link";
import { formatINR, invoiceKindLabels, type ServiceClientInvoiceRow } from "@bmu/shared";
import { DataTable, Panel, StatRow, StatTile, type Column } from "@/components/dash";
import { PayButton } from "@/components/pay-button";
import { BillingDetailsPanel } from "@/components/service/billing-details-form";
import { Badge, LoadState, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

const date = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" });
const statusLabel: Record<string, string> = { paid: "Paid", partially_paid: "Part paid", issued: "Due", overdue: "Overdue", void: "Cancelled", credit_noted: "Credited" };
const tone = (s: string) => (s === "paid" || s === "credit_noted" ? "green" : s === "overdue" ? "red" : s === "void" ? "neutral" : "amber");

export default function BillingPage() {
  const state = useLoad(() => api.service.clientBilling());
  if (!state.data) {
    if (state.error) return <PageTitle title="Billing" subtitle={state.error} />;
    return <LoadState loading={state.loading} error={state.error} />;
  }
  const b = state.data;
  const columns: Column<ServiceClientInvoiceRow>[] = [
    {
      key: "number",
      header: "Invoice",
      cell: (i) => (
        <Link href={`/client/billing/${i.id}`} className="font-medium hover:underline">
          {i.number}
        </Link>
      ),
    },
    { key: "for", header: "For", cell: (i) => <span className="line-clamp-1 text-ink-muted">{i.label || invoiceKindLabels[i.kind]}</span> },
    { key: "date", header: "Date", cell: (i) => <span className="whitespace-nowrap">{date.format(new Date(i.createdAt))}</span> },
    { key: "due", header: "Due", cell: (i) => <span className="whitespace-nowrap">{date.format(new Date(i.dueDate))}</span> },
    { key: "total", header: "Total (incl. GST)", align: "right", cell: (i) => formatINR(i.totalPaise) },
    { key: "balance", header: "Still to pay", align: "right", cell: (i) => (i.balancePaise ? <strong>{formatINR(i.balancePaise)}</strong> : <span className="text-ink-muted">—</span>) },
    { key: "status", header: "Status", cell: (i) => <Badge tone={tone(i.status)}>{i.status === "overdue" ? `Overdue ${i.daysOverdue}d` : (statusLabel[i.status] ?? i.status)}</Badge> },
    {
      key: "pay",
      header: "",
      align: "right",
      cell: (i) => (i.balancePaise > 0 && b.online !== "unavailable" ? <PayButton invoiceId={i.id} amountPaise={i.balancePaise} onPaid={state.reload} /> : i.balancePaise > 0 ? <Link href={`/client/billing/${i.id}`} className="text-xs underline">How to pay</Link> : null),
    },
  ];
  return (
    <>
      <PageTitle title="Billing" subtitle="Your invoices with GST shown separately. Pay online, or by bank transfer / UPI using the details on each invoice." />
      <div className="grid min-w-0 grid-cols-1 gap-6 [&>*]:min-w-0">
        <StatRow cols={3}>
          <StatTile label="To pay now" value={formatINR(b.duePaise)} tone={b.duePaise ? "warn" : "good"} hint={b.duePaise ? `${b.invoices.filter((i) => i.balancePaise > 0).length} invoice(s) open` : "Nothing due. Thank you!"} />
          <StatTile label="Overdue" value={formatINR(b.overduePaise)} tone={b.overduePaise ? "bad" : "default"} hint="past the due date" />
          <StatTile label="Paid this financial year" value={formatINR(b.paidThisYearPaise)} />
        </StatRow>
        <Panel title="Invoices" subtitle="Open an invoice to see the full GST tax invoice and download it as a PDF." flush>
          <DataTable rows={b.invoices} columns={columns} rowKey={(i) => i.id} empty="No invoices yet." />
        </Panel>
        {b.online === "test" && <p className="text-xs text-ink-muted">Development mode: “Pay” records a test payment, no real money moves.</p>}
        <div className="max-w-2xl">
          <BillingDetailsPanel details={b.details} onSave={(v) => api.service.saveClientBillingDetails(v)} />
        </div>
      </div>
    </>
  );
}
