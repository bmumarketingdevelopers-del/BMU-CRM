"use client";

import { useState } from "react";
import { ACCOUNTING_FORMATS, accountingFormatLabels, type AccountingFormat, type SettingsValue } from "@bmu/shared";
import { KeyValues, Panel } from "@/components/dash";
import { Button, Input, PageTitle, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { Field, FormNote, WithData, fmtDateTime, todayIst } from "../../_insights/kit";

type Accounting = SettingsValue<"accounting">;
const TOOLS: { value: Accounting["tool"]; label: string }[] = [
  { value: "none", label: "Not using one yet" },
  { value: "tally", label: "Tally" },
  { value: "zoho_books", label: "Zoho Books" },
  { value: "quickbooks", label: "QuickBooks" },
];

export default function AccountingPage() {
  const settings = useLoad(() => api.settings.all());
  return (
    <>
      <PageTitle title="Accounting Sync" subtitle="Send invoices, receipts and credit notes to your accountant’s software as a spreadsheet." />
      <WithData state={settings}>{(s) => <Body initial={s.accounting} canEdit={s.canEdit.accounting} />}</WithData>
    </>
  );
}

function firstOfMonth() {
  return `${todayIst().slice(0, 7)}-01`;
}

function Body({ initial, canEdit }: { initial: Accounting; canEdit: boolean }) {
  const [value, setValue] = useState<Accounting>(initial);
  const [tool, setTool] = useState<Accounting["tool"]>(initial.tool);
  const [from, setFrom] = useState(firstOfMonth());
  const [to, setTo] = useState(todayIst());
  const [saveMsg, setSaveMsg] = useState<{ error?: string; ok?: string }>({});
  const [exportMsg, setExportMsg] = useState<{ error?: string; ok?: string }>({});
  const [busy, setBusy] = useState<"save" | "export" | null>(null);
  const [format, setFormat] = useState<AccountingFormat>(initial.tool === "tally" ? "tally_xml" : initial.tool === "zoho_books" ? "zoho_invoices" : "csv");

  async function saveTool(e: React.FormEvent) {
    e.preventDefault();
    setBusy("save");
    setSaveMsg({});
    try {
      const r = await api.settings.save("accounting", { ...value, tool });
      setValue(r.accounting);
      setSaveMsg({ ok: "Saved" });
    } catch (err) {
      setSaveMsg({ error: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function exportCsv(e: React.FormEvent) {
    e.preventDefault();
    setBusy("export");
    setExportMsg({});
    try {
      const res = await fetch(`/api${api.finance.exportCsvPath(from, to, format)}`, { credentials: "include" });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? "Export failed");
      }
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `bmu-${format === "csv" ? "accounting" : format.replace("_", "-")}-${from}-to-${to}.${format === "tally_xml" ? "xml" : "csv"}`;
      a.click();
      URL.revokeObjectURL(a.href);
      if (canEdit) {
        const r = await api.settings.save("accounting", { ...value, lastExportAt: new Date().toISOString() });
        setValue(r.accounting);
      }
      setExportMsg({ ok: "Downloaded" });
    } catch (err) {
      setExportMsg({ error: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Panel className="min-w-0" title="Export for accounting" subtitle="One row per voucher: sales invoices, receipts and credit notes, with Tally-friendly columns">
        <form onSubmit={exportCsv} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="From">
              <Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} required />
            </Field>
            <Field label="To">
              <Input type="date" value={to} min={from} max={todayIst()} onChange={(e) => setTo(e.target.value)} required />
            </Field>
          </div>
          <Field label="Format">
            <Select value={format} onChange={(e) => setFormat(e.target.value as AccountingFormat)} className="w-full !py-2" aria-label="Format">
              {ACCOUNTING_FORMATS.map((f) => (
                <option key={f} value={f}>
                  {accountingFormatLabels[f]}
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex items-center gap-4">
            <Button disabled={busy !== null}>{busy === "export" ? "Preparing…" : format === "tally_xml" ? "Download XML" : "Download CSV"}</Button>
            <FormNote error={exportMsg.error} ok={exportMsg.ok} />
          </div>
          <p className="text-xs text-ink-muted">
            {format === "tally_xml"
              ? "In Tally Prime: Import → Vouchers, pick this file. Party ledgers are created under Sundry Debtors; sales use Sales - Services and Output CGST/SGST or IGST ledgers."
              : format === "zoho_invoices"
                ? "In Zoho Books: Sales → Invoices → Import. One row per invoice line, with GST treatment and place of supply."
                : format === "zoho_payments"
                  ? "In Zoho Books: Sales → Payments Received → Import. Import the invoices file first."
                  : "Columns: date, voucher type, voucher number, party name and GSTIN, ledger, taxable value, GST rate and amount, total, payment mode, reference, narration."}
          </p>
        </form>
      </Panel>
      <Panel className="min-w-0" title="Accounting software" subtitle={canEdit ? "Where your accountant keeps the books" : "Only Founder, Branch Manager and Finance can change this"}>
        <form onSubmit={saveTool} className="space-y-4">
          <Field label="Software">
            <Select value={tool} onChange={(e) => setTool(e.target.value as Accounting["tool"])} disabled={!canEdit} className="w-full !py-2">
              {TOOLS.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </Select>
          </Field>
          <KeyValues items={[{ k: "Last export", v: value.lastExportAt ? fmtDateTime(value.lastExportAt) : "Never" }]} />
          {canEdit && (
            <div className="flex items-center gap-4">
              <Button variant="secondary" disabled={busy !== null || tool === value.tool}>
                {busy === "save" ? "Saving…" : "Save"}
              </Button>
              <FormNote error={saveMsg.error} ok={saveMsg.ok} />
            </div>
          )}
        </form>
      </Panel>
    </div>
  );
}
