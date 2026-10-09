"use client";

import { useState } from "react";
import type { GstSummaryView, SettingsValue } from "@bmu/shared";
import { DataTable, Panel, StatRow, StatTile } from "@/components/dash";
import { Button, Input, LoadState, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { Field, FormNote, InvoiceStatus, WithData, fmtDate, inr, todayIst } from "../../_insights/kit";

type Gst = SettingsValue<"gst">;

export default function GstPage() {
  const [month, setMonth] = useState(todayIst().slice(0, 7));
  const settings = useLoad(() => api.settings.all());
  return (
    <>
      <PageTitle title="GST" subtitle="Your GST registration details and what GST was charged on invoices each month." />
      <div className="space-y-8">
        <Panel className="min-w-0"
          title="Monthly summary"
          subtitle="Invoices raised in the month, cancelled ones left out"
          action={
            <div className="flex items-center gap-2">
              <Input type="month" value={month} max={todayIst().slice(0, 7)} onChange={(e) => e.target.value && setMonth(e.target.value)} className="!w-40 !py-1.5" aria-label="Month" />
              <a href={`/api${api.finance.gstCsvPath(month)}`} className="border border-border px-3 py-1.5 text-sm whitespace-nowrap hover:border-ink">
                Download CSV
              </a>
            </div>
          }
          flush
        >
          <Summary key={month} month={month} />
        </Panel>

        <WithData state={settings}>{(s) => <GstForm value={s.gst} canEdit={s.canEdit.gst} />}</WithData>
      </div>
    </>
  );
}

function Summary({ month }: { month: string }) {
  const state = useLoad(() => api.finance.gst(month));
  if (!state.data) return <div className="p-5"><LoadState loading={state.loading} error={state.error} /></div>;
  const g: GstSummaryView = state.data;
  const netGst = g.gstPaise - g.creditNotes.gstPaise;
  return (
    <>
      <div className="border-b border-border">
        <StatRow cols={4}>
          <StatTile label={`Taxable value · ${g.monthLabel}`} value={inr(g.taxablePaise)} hint={`${g.invoiceCount} invoice${g.invoiceCount === 1 ? "" : "s"}`} />
          <StatTile label="GST charged" value={inr(g.gstPaise)} hint={`at ${g.ratePct}%`} />
          <StatTile label="Credit notes" value={inr(g.creditNotes.gstPaise)} hint={`GST reversed on ${g.creditNotes.count}`} />
          <StatTile label="Net GST for the month" value={inr(netGst)} tone="good" />
        </StatRow>
      </div>
      <p className="border-b border-border bg-canvas/50 px-5 py-3 text-xs text-ink-muted">
        Client states are not recorded yet, so GST is shown as one total. When filing, split it into CGST + SGST for clients in your state and IGST for clients outside it.
      </p>
      <DataTable
        rows={g.rows}
        rowKey={(r) => r.id}
        empty="No invoices raised in this month."
        columns={[
          { key: "num", header: "Invoice", cell: (r) => <span className="whitespace-nowrap font-medium">{r.number}</span> },
          { key: "date", header: "Date", cell: (r) => <span className="whitespace-nowrap">{fmtDate(r.date)}</span> },
          { key: "client", header: "Client", cell: (r) => r.client },
          { key: "gstin", header: "Client GSTIN", cell: (r) => <span className="text-ink-muted">{r.gstin ?? "No GSTIN"}</span> },
          { key: "status", header: "Status", cell: (r) => <InvoiceStatus status={r.status} /> },
          { key: "tax", header: "Taxable", align: "right", cell: (r) => inr(r.taxablePaise) },
          { key: "gst", header: "GST", align: "right", cell: (r) => inr(r.gstPaise) },
          { key: "tot", header: "Total", align: "right", cell: (r) => inr(r.totalPaise) },
        ]}
      />
    </>
  );
}

function GstForm({ value, canEdit }: { value: Gst; canEdit: boolean }) {
  const [v, setV] = useState<Gst>(value);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof Gst) => (e: React.ChangeEvent<HTMLInputElement>) => setV((s) => ({ ...s, [k]: k === "ratePct" ? Number(e.target.value) : e.target.value }));
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      const r = await api.settings.save("gst", v);
      setV(r.gst);
      setOk("Saved");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Panel className="min-w-0" title="GST settings" subtitle={canEdit ? "Printed on every invoice and credit note" : "Only Founder, Admin and Finance can change these"}>
      <form onSubmit={save}>
        <fieldset disabled={!canEdit || busy} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="GSTIN">
            <Input value={v.gstin} onChange={set("gstin")} maxLength={15} placeholder="29ABCDE1234F1Z5" />
          </Field>
          <Field label="Legal name">
            <Input value={v.legalName} onChange={set("legalName")} />
          </Field>
          <Field label="State">
            <Input value={v.state} onChange={set("state")} />
          </Field>
          <Field label="State code">
            <Input value={v.stateCode} onChange={set("stateCode")} maxLength={2} />
          </Field>
          <Field label="GST rate (%)">
            <Input type="number" min={0} max={28} step="0.5" value={v.ratePct} onChange={set("ratePct")} />
          </Field>
          <Field label="SAC code" hint="998361 is advertising services">
            <Input value={v.sacCode} onChange={set("sacCode")} />
          </Field>
          <Field label="Invoice prefix">
            <Input value={v.invoicePrefix} onChange={set("invoicePrefix")} maxLength={10} />
          </Field>
          <Field label="Registered address" hint="Printed on tax invoices">
            <Input value={v.address ?? ""} onChange={set("address")} maxLength={500} />
          </Field>
          <Field label="UPI ID" hint="Shown on invoices with a pay-by-UPI link">
            <Input value={v.upiId ?? ""} onChange={set("upiId")} placeholder="bmumarketing@okhdfc" />
          </Field>
          <Field label="Bank name">
            <Input value={v.bankName ?? ""} onChange={set("bankName")} />
          </Field>
          <Field label="Account number">
            <Input value={v.bankAccount ?? ""} onChange={set("bankAccount")} />
          </Field>
          <Field label="IFSC">
            <Input value={v.bankIfsc ?? ""} onChange={set("bankIfsc")} />
          </Field>
          <Field label="Branch">
            <Input value={v.bankBranch ?? ""} onChange={set("bankBranch")} />
          </Field>
        </fieldset>
        {canEdit && (
          <div className="mt-5 flex items-center gap-4">
            <Button disabled={busy}>{busy ? "Saving…" : "Save GST settings"}</Button>
            <FormNote error={error} ok={ok} />
          </div>
        )}
      </form>
    </Panel>
  );
}
