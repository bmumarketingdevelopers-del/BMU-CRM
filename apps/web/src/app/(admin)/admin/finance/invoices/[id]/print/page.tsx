"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { TaxInvoice } from "@/components/service/tax-invoice";
import { LoadState } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

export default function FinanceTaxInvoicePage() {
  const { id } = useParams<{ id: string }>();
  const state = useLoad(() => api.service.taxInvoice(id));
  return (
    <>
      <Link href={`/admin/finance/invoices/${id}`} className="no-print mb-4 inline-block text-sm underline">
        ← Back to the invoice
      </Link>
      {state.data ? <TaxInvoice t={state.data} /> : <LoadState loading={state.loading} error={state.error} />}
    </>
  );
}
