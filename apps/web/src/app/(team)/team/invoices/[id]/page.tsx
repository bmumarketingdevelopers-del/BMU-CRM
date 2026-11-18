"use client";

// v29: a Client Manager's view of one of their clients' invoices, with "Sign invoice" when it waits for a signature.
// v52: a draft can be edited in the shared form, then issued; once issued, its items and amounts are locked.
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { SigningStatus } from "@/components/service/signing-status";
import { TaxInvoice } from "@/components/service/tax-invoice";
import { Button, LoadState } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

export default function TeamInvoicePage() {
  const { id } = useParams<{ id: string }>()!;
  const router = useRouter();
  const state = useLoad(() => api.service.cmTaxInvoice(id));
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();
  const [busy, setBusy] = useState(false);
  async function issue() {
    if (!window.confirm("Issue this invoice? Its items and amounts are locked once it is issued.")) return;
    setBusy(true);
    setMsg(undefined);
    try {
      setMsg({ ok: true, text: (await api.ops.finance.issue(id)).message });
      state.reload();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }
  const draft = state.data?.status === "draft";
  // This is the Client Manager's view; Founders and Finance see invoices under Admin → Finance.
  useEffect(() => {
    if (state.error === "For Client Managers") router.replace(`/admin/finance/invoices/${id}`);
  }, [state.error, id, router]);
  return (
    <>
      <Link href="/team/invoices" className="no-print mb-4 inline-block text-sm underline">
        ← Invoices
      </Link>
      {msg && <p className={`no-print mb-3 text-sm ${msg.ok ? "text-green" : "text-red"}`}>{msg.text}</p>}
      {state.data ? (
        <>
          {draft && (
            <div className="no-print mb-4 flex flex-wrap items-center gap-3" data-testid="invoice-draft-actions">
              <Link href={`/team/invoices/${id}/edit`} className="border border-border px-3 py-1.5 text-sm hover:border-ink" data-testid="invoice-edit">
                Edit
              </Link>
              <Button onClick={issue} disabled={busy} data-testid="invoice-issue">
                Issue invoice
              </Button>
              <span className="text-xs text-ink-muted">Draft: change it as often as you like. Once issued it is locked.</span>
            </div>
          )}
          <SigningStatus key={`${state.data.id}-${state.data.signing.signed}`} id={id} invoice={state.data} onSigned={state.reload} />
          <TaxInvoice t={state.data} />
        </>
      ) : (
        <LoadState loading={state.loading} error={state.error} />
      )}
    </>
  );
}
