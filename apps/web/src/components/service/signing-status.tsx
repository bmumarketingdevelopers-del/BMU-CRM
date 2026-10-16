"use client";

// v28: on the team's invoice page: is the invoice signed (seal + signature), or waiting for it and not sent yet?
// People who handle invoices sign it here with the signing password.
import { useState } from "react";
import type { ServiceTaxInvoice } from "@bmu/shared";
import { Button } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { SignInvoiceDialog } from "./sign-invoice-dialog";

const when = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });

export function SigningStatus({ id, invoice, onSigned }: { id: string; invoice?: ServiceTaxInvoice; onSigned?: () => void }) {
  const state = useLoad(() => (invoice ? Promise.resolve(invoice) : api.service.taxInvoice(id)), { live: false });
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<string>();
  const t = invoice ?? state.data;
  if (!t || t.status === "void") return null;
  const s = t.signing;
  return (
    <div className={`no-print mb-4 flex flex-wrap items-center gap-3 border px-4 py-3 text-sm ${s.signed ? "border-[#5f8a12] bg-[#f2f7e6]" : s.held ? "border-[#b7791f] bg-[#fdf6e7]" : "border-border bg-surface-raised"}`} data-testid="signing-status">
      <span className="min-w-0 flex-1 text-[#1c2430]">
        {s.signed
          ? `Signed${s.signedBy ? ` by ${s.signedBy}` : ""}${s.signedAt ? ` on ${when.format(new Date(s.signedAt))}` : ""}: the seal and signature are on this invoice.`
          : s.held
            ? "Waiting for the seal and signature. The client has not received this invoice yet; it is sent as soon as it is signed."
            : "Not signed: this invoice has no seal or signature."}
        {msg && <span className="block font-medium">{msg}</span>}
      </span>
      {s.canSign && (
        <Button onClick={() => setOpen(true)} data-testid="sign-invoice">
          Sign invoice
        </Button>
      )}
      {open && (
        <SignInvoiceDialog
          invoice={{ id: t.id, number: t.number, totalPaise: t.totalPaise, client: t.buyer.legalName }}
          onClose={() => setOpen(false)}
          onSigned={(m) => {
            setMsg(m);
            state.reload();
            onSigned?.();
          }}
        />
      )}
    </div>
  );
}
