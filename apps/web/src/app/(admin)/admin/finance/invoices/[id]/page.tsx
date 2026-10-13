"use client";

import Link from "next/link";
import { HistoryTab } from "@/components/actions/history-tab";
import { useActionsMaybe } from "@/components/actions/actions-provider";
import { ProofInput } from "@/components/ops/kit";
import { DueDateDialog } from "@/components/ops/invoice-actions";
import { useParams } from "next/navigation";
import { useState } from "react";
import { OPS_CONVERT_METHODS, invoiceKindLabels, paymentMethodLabels, type FinanceInvoiceDetail } from "@bmu/shared";
import { ClientBillingDetails, InvoiceTools } from "@/components/service/invoice-tools";
import { DataTable, Grid, KeyValues, Panel, StatRow, StatTile } from "@/components/dash";
import { PayLinks } from "@/components/money/pay-links";
import { Button, Input, PageTitle, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { Field, FormNote, InvoiceStatus, WithData, fmtDate, fmtDateTime, inr, rupeesInput, todayIst } from "../../../_insights/kit";

export default function InvoiceDetailPage() {
  const { id } = useParams<{ id: string }>()!;
  const state = useLoad(() => api.finance.invoice(id));
  return (
    <WithData state={state}>
      {(inv) => <Detail inv={inv} reload={state.reload} />}
    </WithData>
  );
}

function Detail({ inv, reload }: { inv: FinanceInvoiceDetail; reload: () => void }) {
  const open = inv.balancePaise > 0;
  const actions = useActionsMaybe();
  const [moving, setMoving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  async function issue() {
    setBusy(true);
    try {
      const r = await api.ops.finance.issue(inv.id);
      setNote(r.message);
      reload();
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const workLines = inv.lines.filter((l) => !/^GST\b/i.test(l.label));
  return (
    <>
      <PageTitle
        title={`Invoice ${inv.number}`}
        subtitle={`${inv.client} · ${invoiceKindLabels[inv.kind] ?? inv.kind}${inv.service ? ` · ${inv.service}` : ""}`}
        action={
          <div className="flex flex-wrap items-center gap-3">
            <InvoiceStatus status={inv.status} />
            {inv.canEdit && inv.status === "draft" && (
              <Button disabled={busy} onClick={issue}>
                {busy ? "Issuing…" : "Issue to client"}
              </Button>
            )}
            {inv.canEdit && open && inv.status !== "draft" && inv.status !== "void" && (
              <Button variant="secondary" onClick={() => setMoving(true)}>
                Change due date
              </Button>
            )}
            <Link href="/admin/finance/invoices" className="text-sm text-ink-muted hover:text-ink">
              ← All invoices
            </Link>
          </div>
        }
      />
      {note && (
        <p className="mb-4 border border-border bg-surface-raised px-4 py-2 text-sm" role="status">
          {note}
        </p>
      )}
      {moving && (
        <DueDateDialog
          invoice={inv}
          onClose={() => setMoving(false)}
          onDone={(m, undo) => {
            setNote(m);
            actions?.notify(m, undo);
            reload();
          }}
        />
      )}
      <div className="space-y-8">
        <InvoiceTools id={inv.id} canEdit={inv.canEdit} hasClient={!!inv.clientId} voided={inv.status === "void"} />
        <StatRow cols={4}>
          <StatTile label="Total" value={inr(inv.totalPaise)} hint={`${inr(inv.subtotalPaise)} + GST ${inr(inv.gstPaise)}`} />
          <StatTile label="Paid" value={inr(inv.paidPaise)} tone={inv.paidPaise ? "good" : "default"} hint={`${inv.payments.length} payment${inv.payments.length === 1 ? "" : "s"}`} />
          <StatTile label="Credited" value={inr(inv.creditedPaise)} hint={`${inv.creditNotes.length} credit note${inv.creditNotes.length === 1 ? "" : "s"}`} />
          <StatTile label="Still due" value={inr(inv.balancePaise)} tone={inv.status === "overdue" ? "bad" : open ? "warn" : "default"} hint={`due ${fmtDate(inv.dueDate)}`} />
        </StatRow>

        {inv.status === "void" && (
          <p className="border border-border bg-canvas px-4 py-3 text-sm">
            This invoice was cancelled{inv.cancelReason ? `: ${inv.cancelReason}` : "."} It no longer counts towards revenue or GST.
          </p>
        )}

        <Grid>
          <Panel className="min-w-0" title="What it is for">
            <KeyValues
              items={[
                ...workLines.map((l) => ({ k: l.label, v: inr(l.amountPaise) })),
                { k: "Taxable value", v: inr(inv.subtotalPaise) },
                { k: `GST ${inv.gstRatePct}%`, v: inr(inv.gstPaise) },
                { k: <span className="font-medium text-ink">Total</span>, v: inr(inv.totalPaise) },
              ]}
            />
            <p className="mt-4 text-xs text-ink-muted">Raised {fmtDate(inv.createdAt)} · due {fmtDate(inv.dueDate)}</p>
          </Panel>
          <Panel className="min-w-0" title="Payments" flush>
            <DataTable
              rows={inv.payments}
              rowKey={(p) => p.id}
              empty="No payments yet."
              columns={[
                { key: "at", header: "When", cell: (p) => <span className="whitespace-nowrap">{fmtDateTime(p.at)}</span> },
                { key: "method", header: "How", cell: (p) => paymentMethodLabels[p.method] ?? p.method },
                { key: "ref", header: "Reference", cell: (p) => <span className="text-ink-muted">{p.ref ?? "—"}</span> },
                { key: "amt", header: "Amount", align: "right", cell: (p) => inr(p.amountPaise) },
              ]}
            />
          </Panel>
        </Grid>

        {inv.creditNotes.length > 0 && (
          <Panel className="min-w-0" title="Credit notes" flush>
            <DataTable
              rows={inv.creditNotes}
              rowKey={(n) => n.id}
              columns={[
                { key: "num", header: "Number", cell: (n) => <span className="whitespace-nowrap font-medium">{n.number}</span> },
                { key: "at", header: "Issued", cell: (n) => fmtDate(n.createdAt) },
                { key: "why", header: "Reason", cell: (n) => <span className="text-ink-muted">{n.reason}</span> },
                { key: "by", header: "By", cell: (n) => n.createdBy ?? "—" },
                { key: "amt", header: "Amount", align: "right", cell: (n) => inr(n.amountPaise) },
                { key: "gst", header: "GST", align: "right", cell: (n) => inr(n.gstPaise) },
                { key: "tot", header: "Total", align: "right", cell: (n) => inr(n.totalPaise) },
              ]}
            />
          </Panel>
        )}

        {inv.status !== "draft" && inv.status !== "void" && <PayLinks invoiceId={inv.id} canWrite={inv.canEdit} open={open} />}

        {inv.canEdit && inv.status !== "void" && (
          <Grid cols={3}>
            {open && inv.status !== "draft" && <RecordPayment inv={inv} done={reload} />}
            {inv.creditableTotalPaise > 0 && <CreditNoteForm inv={inv} done={reload} />}
            {inv.payments.length === 0 && inv.creditNotes.length === 0 && <CancelForm inv={inv} done={reload} />}
          </Grid>
        )}

        {inv.clientId && (
          <div className="max-w-2xl">
            <ClientBillingDetails clientId={inv.clientId} />
          </div>
        )}
        <div id="history">
          <HistoryTab entity="Invoice" id={inv.id} />
        </div>
      </div>
    </>
  );
}

function RecordPayment({ inv, done }: { inv: FinanceInvoiceDetail; done: () => void }) {
  const [amount, setAmount] = useState(String(inv.balancePaise / 100));
  const [method, setMethod] = useState<(typeof OPS_CONVERT_METHODS)[number]>("bank");
  const [proof, setProof] = useState<{ id: string; name: string } | null>(null);
  const [ref, setRef] = useState("");
  const [tds, setTds] = useState("");
  const [at, setAt] = useState(todayIst());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const paise = rupeesInput(amount);
    if (!paise) return setError("Enter the amount received");
    if (ref.trim().length < 3) return setError("Enter the bank, UPI or cheque reference");
    if (!proof) return setError("Upload the proof (bank slip, cheque photo or receipt)");
    setBusy(true);
    setError(null);
    try {
      await api.ops.finance.offlinePayment(inv.id, { amountPaise: paise, method, ref: ref.trim(), at, proofFileId: proof.id, tdsPaise: rupeesInput(tds) || undefined });
      done();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Panel className="min-w-0" title="Record a payment" subtitle="Money received outside Razorpay, with proof">
      <form onSubmit={submit} className="space-y-3" id="record-payment">
        <Field label="Amount (₹)" hint={`Balance due ${inr(inv.balancePaise)}`}>
          <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="TDS deducted by the client (₹)" hint="Optional. Counts towards the invoice; claim it from the TDS certificate.">
          <Input inputMode="decimal" value={tds} onChange={(e) => setTds(e.target.value)} />
        </Field>
        <Field label="Paid by">
          <Select value={method} onChange={(e) => setMethod(e.target.value as (typeof OPS_CONVERT_METHODS)[number])} className="w-full !py-2" aria-label="Paid by">
            {OPS_CONVERT_METHODS.map((m) => (
              <option key={m} value={m}>
                {paymentMethodLabels[m]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Reference" hint="UTR, UPI reference or cheque number. The same reference is never recorded twice.">
          <Input value={ref} onChange={(e) => setRef(e.target.value)} required />
        </Field>
        <Field label="Date received">
          <Input type="date" value={at} max={todayIst()} onChange={(e) => setAt(e.target.value)} />
        </Field>
        <ProofInput value={proof} onChange={setProof} />
        <FormNote error={error} />
        <Button disabled={busy}>{busy ? "Saving…" : "Record payment"}</Button>
      </form>
    </Panel>
  );
}

function CreditNoteForm({ inv, done }: { inv: FinanceInvoiceDetail; done: () => void }) {
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const paise = rupeesInput(amount);
  const gst = paise ? Math.round((paise * inv.gstRatePct) / 100) : 0;
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!paise) return setError("Enter the amount to credit, before GST");
    setBusy(true);
    setError(null);
    try {
      const r = await api.finance.issueCreditNote({ invoiceId: inv.id, amountPaise: paise, reason });
      setOk(r.pending ? (r.message ?? "Sent to a Branch Manager to approve") : `Credit note ${r.number} issued`);
      setAmount("");
      setReason("");
      done();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Panel className="min-w-0" title="Issue a credit note" subtitle={`Up to ${inr(inv.creditableTotalPaise)} including GST`}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Amount before GST (₹)" hint={paise ? `GST ${inv.gstRatePct}%: ${inr(gst)} · credit total ${inr(paise + gst)}` : undefined}>
          <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="Reason">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Two posts not delivered" />
        </Field>
        <FormNote error={error} ok={ok} />
        <Button variant="secondary" disabled={busy}>
          {busy ? "Issuing…" : "Issue credit note"}
        </Button>
      </form>
    </Panel>
  );
}

function CancelForm({ inv, done }: { inv: FinanceInvoiceDetail; done: () => void }) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!confirm(`Cancel invoice ${inv.number}? This cannot be undone.`)) return;
    setBusy(true);
    setError(null);
    try {
      await api.finance.cancelInvoice(inv.id, reason);
      done();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Panel className="min-w-0" title="Cancel this invoice" subtitle="Only for invoices with no payments">
      <form onSubmit={submit} className="space-y-3">
        <Field label="Reason">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Raised twice by mistake" />
        </Field>
        <FormNote error={error} />
        <Button variant="ghost" className="!px-0 text-[#b4432c] hover:!text-[#b4432c]" disabled={busy}>
          {busy ? "Cancelling…" : "Cancel invoice"}
        </Button>
      </form>
    </Panel>
  );
}
