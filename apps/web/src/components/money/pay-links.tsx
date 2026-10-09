"use client";
// v18: pay-by-link panel on a Finance invoice page.
import { useState } from "react";
import { Badge, Button } from "@/components/ui";
import { Panel } from "@/components/dash";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { day, inr, Note } from "./kit";

export function PayLinks({ invoiceId, canWrite, open }: { invoiceId: string; canWrite: boolean; open: boolean }) {
  const links = useLoad(() => api.money.links(invoiceId), { live: ["PaymentLink", "Invoice", "Payment"] });
  const [msg, setMsg] = useState<{ error?: string; ok?: string }>({});
  const create = async () => {
    setMsg({});
    try {
      const l = await api.money.createLink(invoiceId);
      await navigator.clipboard?.writeText(l.shortUrl ?? l.url).catch(() => undefined);
      setMsg({ ok: "Link ready and copied. Send it to the client on WhatsApp or email." });
      links.reload();
    } catch (e) {
      setMsg({ error: (e as Error).message });
    }
  };
  const rows = links.data ?? [];
  return (
    <Panel title="Pay by link" subtitle="The client pays by UPI, card or net banking; the invoice is marked paid on its own." action={canWrite && open ? <Button onClick={create} data-testid="create-pay-link">{rows.some((l) => l.status === "active") ? "Copy link" : "Create pay link"}</Button> : undefined}>
      <Note {...msg} />
      {rows.length === 0 ? (
        <p className="text-sm text-ink-muted">No pay link yet.</p>
      ) : (
        <ul className="divide-y divide-border text-sm">
          {rows.map((l) => (
            <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 py-2" data-testid="pay-link">
              <div className="min-w-0">
                <a href={l.shortUrl ?? l.url} target="_blank" rel="noreferrer" className="break-all underline">
                  {l.shortUrl ?? l.url}
                </a>
                <p className="text-xs text-ink-muted">
                  {inr(l.amountPaise)} · made {day(l.createdAt)} · {l.provider === "razorpay" ? "Razorpay" : "test link (no Razorpay keys)"}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Badge tone={l.status === "paid" ? "green" : l.status === "active" ? "dark" : "neutral"}>{l.status === "paid" ? "Paid" : l.status === "active" ? "Active" : "Cancelled"}</Badge>
                {canWrite && l.status === "active" && (
                  <Button variant="ghost" onClick={() => api.money.cancelLink(l.id).then(links.reload).catch((e: Error) => setMsg({ error: e.message }))}>
                    Cancel
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
