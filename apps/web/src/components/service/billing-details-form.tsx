"use client";

import { useState } from "react";
import { SERVICE_GST_STATES, serviceGstStateName, type ServiceBillingDetails, type ServiceBillingDetailsInput } from "@bmu/shared";
import { KeyValues, Panel } from "@/components/dash";
import { Button, Input, Select } from "@/components/ui";

/** Optional details printed on GST tax invoices: legal name, GSTIN, billing address, place of supply, invoice email. */
export function BillingDetailsPanel({ details, onSave, title = "Billing details for tax invoices" }: { details: ServiceBillingDetails; onSave: (v: ServiceBillingDetailsInput) => Promise<ServiceBillingDetails>; title?: string }) {
  const [d, setD] = useState(details);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ legalName: d.legalName ?? "", gstin: d.gstin ?? "", billingAddress: d.billingAddress ?? "", placeOfSupply: d.placeOfSupply ?? "", billingEmail: d.billingEmail ?? "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [ok, setOk] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    setOk(false);
    try {
      const fresh = await onSave({ legalName: form.legalName || null, gstin: form.gstin || null, billingAddress: form.billingAddress || null, placeOfSupply: form.placeOfSupply || null, billingEmail: form.billingEmail || null });
      setD(fresh);
      setEditing(false);
      setOk(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <Panel
      title={title}
      subtitle="Optional. Shown on every GST invoice we send you."
      action={d.canEdit && !editing && <Button variant="ghost" className="px-0 py-0 text-xs" onClick={() => (setEditing(true), setOk(false))}>Edit</Button>}
    >
      {editing ? (
        <form onSubmit={save} className="grid gap-3 text-sm" data-testid="billing-details-form">
          <label className="grid gap-1">
            <span className="text-ink-muted">Registered business name</span>
            <Input value={form.legalName} onChange={set("legalName")} placeholder={d.name} maxLength={200} />
          </label>
          <label className="grid gap-1">
            <span className="text-ink-muted">GSTIN (leave empty if not registered)</span>
            <Input value={form.gstin} onChange={(e) => setForm((f) => ({ ...f, gstin: e.target.value.toUpperCase() }))} placeholder="29ABCDE1234F1Z5" maxLength={15} />
          </label>
          <label className="grid gap-1">
            <span className="text-ink-muted">Billing address</span>
            <textarea className="w-full border border-border bg-surface px-3 py-2" rows={3} value={form.billingAddress} onChange={set("billingAddress")} maxLength={500} />
          </label>
          <label className="grid gap-1">
            <span className="text-ink-muted">Place of supply (your state)</span>
            <Select value={form.placeOfSupply} onChange={set("placeOfSupply")}>
              <option value="">Same as your GSTIN / our state</option>
              {SERVICE_GST_STATES.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.name} ({s.code})
                </option>
              ))}
            </Select>
          </label>
          <label className="grid gap-1">
            <span className="text-ink-muted">Also email invoices to (optional)</span>
            <Input type="email" value={form.billingEmail} onChange={set("billingEmail")} placeholder="accounts@yourcompany.in" />
          </label>
          {error && <p className="text-red">{error}</p>}
          <div className="flex gap-2">
            <Button disabled={busy}>{busy ? "Saving…" : "Save details"}</Button>
            <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <>
          <KeyValues
            items={[
              { k: "Business name", v: d.legalName || d.name },
              { k: "GSTIN", v: d.gstin || "Not registered" },
              { k: "Billing address", v: d.billingAddress ? <span className="whitespace-pre-line">{d.billingAddress}</span> : "—" },
              { k: "Place of supply", v: serviceGstStateName(d.placeOfSupply) ?? (d.gstin ? serviceGstStateName(d.gstin.slice(0, 2)) : null) ?? "Not set" },
              { k: "Invoice email", v: d.billingEmail || "Owner and finance users" },
            ]}
          />
          {ok && <p className="mt-2 text-sm text-[#5f8a12]">Saved. New invoices will show these details.</p>}
          {!d.canEdit && <p className="mt-2 text-xs text-ink-muted">Only your account owner or finance person can change these.</p>}
        </>
      )}
    </Panel>
  );
}
