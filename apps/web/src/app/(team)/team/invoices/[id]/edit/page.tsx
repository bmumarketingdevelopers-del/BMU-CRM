"use client";

// v52: edit a draft invoice in the shared quotation / invoice form (issued invoices open read-only: they are locked).
import { useParams } from "next/navigation";
import { InvoiceForm } from "@/components/quotes/invoice-form";

export default function EditInvoicePage() {
  const { id } = useParams<{ id: string }>()!;
  return <InvoiceForm key={id} id={id} />;
}
