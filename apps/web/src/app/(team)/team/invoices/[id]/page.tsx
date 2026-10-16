"use client";

// v29: a Client Manager's view of one of their clients' invoices, with "Sign invoice" when it waits for a signature.
import Link from "next/link";
import { useParams } from "next/navigation";
import { SigningStatus } from "@/components/service/signing-status";
import { TaxInvoice } from "@/components/service/tax-invoice";
import { LoadState } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

export default function TeamInvoicePage() {
  const { id } = useParams<{ id: string }>()!;
  const state = useLoad(() => api.service.cmTaxInvoice(id));
  return (
    <>
      <Link href="/team/invoices" className="no-print mb-4 inline-block text-sm underline">
        ← Invoices
      </Link>
      {state.data ? (
        <>
          <SigningStatus key={`${state.data.id}-${state.data.signing.signed}`} id={id} invoice={state.data} onSigned={state.reload} />
          <TaxInvoice t={state.data} />
        </>
      ) : (
        <LoadState loading={state.loading} error={state.error} />
      )}
    </>
  );
}
