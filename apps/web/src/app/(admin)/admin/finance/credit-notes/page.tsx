"use client";

import Link from "next/link";
import { useState } from "react";
import type { CreditNoteRow, CreditNotesView } from "@bmu/shared";
import { DataTable, Panel, StatRow, StatTile } from "@/components/dash";
import { Button, Input, PageTitle, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { Field, FormNote, WithData, fmtDate, inr, rupeesInput } from "../../_insights/kit";

export default function CreditNotesPage() {
  const state = useLoad(() => api.finance.creditNotes());
  return (
    <>
      <PageTitle title="Credit Notes" subtitle="Reduce what a client owes on an invoice, with GST reversed at the same rate." />
      <WithData state={state}>
        {(v) => (
          <div className="space-y-8">
            <StatRow cols={3}>
              <StatTile label="Credit notes" value={v.rows.length} />
              <StatTile label="Total credited" value={inr(v.totalPaise)} hint="including GST" />
              <StatTile label="GST rate" value={`${v.gstRatePct}%`} hint="from GST settings" href="/admin/finance/gst" />
            </StatRow>
            <div className="grid gap-6 lg:grid-cols-3">
              <div className="min-w-0 lg:col-span-2">
                <Panel className="min-w-0" title="Issued" flush>
                  <DataTable<CreditNoteRow>
                    rows={v.rows}
                    rowKey={(r) => r.id}
                    empty="No credit notes yet."
                    columns={[
                      { key: "num", header: "Number", cell: (r) => <span className="whitespace-nowrap font-medium">{r.number}</span> },
                      { key: "inv", header: "Invoice", cell: (r) => <Link href={`/admin/finance/invoices/${r.invoiceId}`} className="whitespace-nowrap hover:underline">{r.invoiceNumber}</Link> },
                      { key: "client", header: "Client", cell: (r) => r.client },
                      { key: "why", header: "Reason", cell: (r) => <span className="text-ink-muted">{r.reason}</span> },
                      { key: "at", header: "Issued", cell: (r) => <span className="whitespace-nowrap">{fmtDate(r.createdAt)}</span> },
                      { key: "tot", header: "Total", align: "right", cell: (r) => <span title={`${inr(r.amountPaise)} + GST ${inr(r.gstPaise)}`}>{inr(r.totalPaise)}</span> },
                    ]}
                  />
                </Panel>
              </div>
              {v.canEdit && <IssueForm view={v} done={state.reload} />}
            </div>
          </div>
        )}
      </WithData>
    </>
  );
}

function IssueForm({ view, done }: { view: CreditNotesView; done: () => void }) {
  const [invoiceId, setInvoiceId] = useState("");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inv = view.invoices.find((i) => i.id === invoiceId);
  const paise = rupeesInput(amount);
  const gst = paise ? Math.round((paise * view.gstRatePct) / 100) : 0;
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!invoiceId) return setError("Pick an invoice");
    if (!paise) return setError("Enter the amount to credit, before GST");
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      const r = await api.finance.issueCreditNote({ invoiceId, amountPaise: paise, reason });
      setOk(r.pending ? (r.message ?? "Sent to a Branch Manager to approve") : `Credit note ${r.number} issued`);
      setAmount("");
      setReason("");
      setInvoiceId("");
      done();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Panel className="min-w-0" title="Issue a credit note">
      <form onSubmit={submit} className="space-y-3">
        <Field label="Invoice" hint={inv ? `Up to ${inr(inv.creditableTotalPaise)} including GST can still be credited` : undefined}>
          <Select value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)} className="w-full !py-2">
            <option value="">Pick an invoice</option>
            {view.invoices.map((i) => (
              <option key={i.id} value={i.id}>
                {i.number} · {i.client}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Amount before GST (₹)" hint={paise ? `GST ${view.gstRatePct}%: ${inr(gst)} · credit total ${inr(paise + gst)}` : undefined}>
          <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="Reason">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Two posts not delivered" />
        </Field>
        <FormNote error={error} ok={ok} />
        <Button disabled={busy}>{busy ? "Issuing…" : "Issue credit note"}</Button>
      </form>
    </Panel>
  );
}
