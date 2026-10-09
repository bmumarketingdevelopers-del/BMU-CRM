"use client";

import Link from "next/link";
import { use } from "react";
import { PayButton } from "@/components/pay-button";
import { TaxInvoice } from "@/components/service/tax-invoice";
import { LoadState, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

export default function ClientInvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const state = useLoad(() => api.service.clientTaxInvoice(id));
  const t = state.data;
  return (
    <>
      <Link href="/client/billing" className="no-print text-sm underline">
        ← Billing
      </Link>
      <div className="no-print">
        <PageTitle title={t ? `Invoice ${t.number}` : "Invoice"} subtitle="Your GST tax invoice. Download it as a PDF for your accounts." />
      </div>
      {!t ? <LoadState loading={state.loading} error={state.error} /> : <TaxInvoice t={t} actions={t.balancePaise > 0 ? <PayButton invoiceId={t.id} amountPaise={t.balancePaise} onPaid={state.reload} /> : null} />}
    </>
  );
}
