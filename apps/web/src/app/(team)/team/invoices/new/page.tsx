"use client";

// v52: a new invoice in the shared quotation / invoice form (Client 360 → Invoices → "+ New invoice" passes the client).
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { InvoiceForm } from "@/components/quotes/invoice-form";

function NewInvoice() {
  const preset = useSearchParams()?.get("clientId") ?? "";
  return <InvoiceForm presetClientId={preset} />;
}

export default function NewInvoicePage() {
  return (
    <Suspense>
      <NewInvoice />
    </Suspense>
  );
}
