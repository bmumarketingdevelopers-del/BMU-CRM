"use client";
// v18 public pay page (/pay/<token>): balance, the Razorpay link, or a test payment in development.
import { useState } from "react";
import { Badge, Button, Card, LoadState } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { dayYear, inr, Note } from "./kit";

export function PublicPay({ token }: { token: string }) {
  const view = useLoad(() => api.money.publicPay(token), { live: false });
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  if (!view.data) return <LoadState loading={view.loading} error={view.error} />;
  const v = view.data;
  return (
    <div data-testid="public-pay"><Card className="mx-auto max-w-md space-y-4 p-6">
      <div>
        <p className="text-xs text-ink-muted">{v.company}</p>
        <h1 className="text-xl font-semibold tracking-tight">Invoice {v.invoiceNumber}</h1>
        <p className="text-sm text-ink-muted">{v.client}</p>
      </div>
      <div className="flex items-end justify-between border-y border-border py-4">
        <div>
          <p className="text-xs text-ink-muted">{v.status === "paid" ? "Paid" : "Amount due"}</p>
          <p className="text-3xl font-semibold tabular-nums">{inr(v.status === "paid" ? v.totalPaise : v.balancePaise)}</p>
        </div>
        <Badge tone={v.status === "paid" ? "green" : v.status === "cancelled" ? "neutral" : "dark"}>{v.status === "paid" ? "Paid, thank you" : v.status === "cancelled" ? "Link closed" : `Due ${dayYear(v.dueDate)}`}</Badge>
      </div>
      {v.status === "due" && v.shortUrl && (
        <a href={v.shortUrl} className="block bg-charcoal px-4 py-3 text-center font-medium text-ivory">Pay {inr(v.balancePaise)} securely (UPI, card, net banking)</a>
      )}
      {v.status === "due" && v.testMode && (
        <div className="space-y-2">
          <Button
            className="w-full"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              api.money.publicPayTest(token).then(view.reload).catch((e: Error) => setError(e.message)).finally(() => setBusy(false));
            }}
            data-testid="pay-test"
          >
            Pay {inr(v.balancePaise)} (test payment)
          </Button>
          <p className="text-xs text-ink-muted">Test mode: Razorpay keys are not set up, so no real money moves.</p>
        </div>
      )}
      {v.status === "due" && !v.shortUrl && !v.testMode && <p className="text-sm text-ink-muted">Online payment is not set up yet. Please pay by bank transfer and share the reference with us.</p>}
      {v.status === "paid" && <p className="text-sm">We have received your payment. A receipt is in your client portal.</p>}
      <Note error={error} />
    </Card></div>
  );
}
