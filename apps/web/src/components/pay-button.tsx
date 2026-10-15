"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { formatINR } from "@bmu/shared";
import { Button } from "@/components/ui";
import { api } from "@/lib/api";
import { payWithRazorpay } from "@/lib/razorpay";

/** Pays one client invoice: Razorpay when keys are set, otherwise a test payment in development. */
export function PayButton({ invoiceId, amountPaise, onPaid, className = "" }: { invoiceId: string; amountPaise: number; onPaid?: () => void; className?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [testMode, setTestMode] = useState(false);

  async function pay() {
    setBusy(true);
    setError(undefined);
    try {
      const c = await api.client.checkout(invoiceId);
      if (c.mode === "test") {
        setTestMode(true);
        await api.client.payTest(invoiceId);
      } else if (c.mode === "razorpay") {
        await payWithRazorpay(c, (r) => api.client.verifyPayment(invoiceId, r));
      } else if (c.mode === "unavailable") {
        throw new Error("Online payment isn't set up yet. Please contact your Client Manager.");
      }
      onPaid?.();
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className={`inline-flex flex-col items-start gap-1 ${className}`}>
      <Button onClick={pay} disabled={busy} className="py-1.5">
        {busy ? "Processing…" : `Pay ${formatINR(amountPaise)}`}
      </Button>
      {testMode && <span className="text-[11px] text-ink-muted">Test payment: no real money moved.</span>}
      {error && <span className="text-xs text-red">{error}</span>}
    </span>
  );
}
