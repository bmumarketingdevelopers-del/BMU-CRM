"use client";

import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { BillingDetailsPanel } from "./billing-details-form";

/** Finance: open the printable tax invoice and (re)send the invoice email to the client. */
export function InvoiceTools({ id, canEdit, hasClient, voided }: { id: string; canEdit: boolean; hasClient: boolean; voided: boolean }) {
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();
  const [busy, setBusy] = useState(false);
  async function email() {
    setBusy(true);
    setMsg(undefined);
    try {
      const r = await api.service.emailInvoice(id);
      setMsg({ ok: true, text: r.sent ? `Sent to ${r.sent} ${r.sent === 1 ? "person" : "people"} (see Outbox)` : "Nobody to send to" });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Link href={`/admin/finance/invoices/${id}/print`} className="border border-charcoal px-3 py-1.5 text-sm hover:bg-canvas">
        Tax invoice / PDF
      </Link>
      {canEdit && hasClient && !voided && (
        <Button variant="secondary" className="py-1.5" disabled={busy} onClick={email}>
          {busy ? "Sending…" : "Email to client"}
        </Button>
      )}
      {msg && <span className={`text-xs ${msg.ok ? "text-[#5f8a12]" : "text-red"}`}>{msg.text}</span>}
    </div>
  );
}

/** Finance edits a client's GSTIN, legal name, address and place of supply. */
export function ClientBillingDetails({ clientId }: { clientId: string }) {
  const state = useLoad(() => api.service.clientBillingDetails(clientId));
  if (!state.data) return state.error ? <p className="text-sm text-red">{state.error}</p> : null;
  return <BillingDetailsPanel title={`${state.data.name}: billing details`} details={state.data} onSave={(v) => api.service.saveBillingDetails(clientId, v)} />;
}
