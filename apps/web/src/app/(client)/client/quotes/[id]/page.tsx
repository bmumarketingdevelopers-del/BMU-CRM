"use client";

// v45: one quotation for the client: read it, download it, and (the account Owner) accept it by typing their name or
// decline it with a reason. On accept the advance invoice appears in Billing.
import Link from "next/link";
import { use, useState } from "react";
import { formatINR, quoteStatusLabels, type QuoteView } from "@bmu/shared";
import { QuotationDocument } from "@/components/quotes/quotation-document";
import { Button, Input, LoadState, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

function Decide({ q, onDone }: { q: QuoteView; onDone: (v: QuoteView & { message: string }) => void }) {
  const [mode, setMode] = useState<"accept" | "decline">();
  const [name, setName] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const advance = Math.round((q.subtotalPaise * q.content.advancePct) / 100);
  const send = async () => {
    setBusy(true);
    setError(undefined);
    try {
      onDone(await api.quotes.decide(q.id, mode === "accept" ? { decision: "accept", name: name.trim() } : { decision: "decline", reason: reason.trim() || undefined }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mb-5 grid max-w-3xl gap-3 border border-border bg-surface-raised p-4 text-sm" data-testid="quote-decide">
      <p>
        <strong>{formatINR(q.totalPaise)}</strong> incl. GST.{" "}
        {q.content.advancePct > 0 ? `If you accept, an advance invoice of ${q.content.advancePct}% (${formatINR(Math.round(advance * (1 + q.gstRatePct / 100)))} incl. GST) is created in Billing.` : ""}
      </p>
      {!mode && (
        <div className="flex gap-2">
          <Button onClick={() => setMode("accept")} data-testid="quote-accept">
            Accept quotation
          </Button>
          <Button variant="secondary" onClick={() => setMode("decline")} data-testid="quote-decline">
            Decline
          </Button>
        </div>
      )}
      {mode === "accept" && (
        <div className="grid gap-2">
          <label className="grid gap-1 text-xs font-medium">
            Type your full name to accept
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" aria-label="Your name" />
          </label>
          <div className="flex gap-2">
            <Button disabled={busy || name.trim().length < 2} onClick={send} data-testid="quote-accept-send">
              I accept this quotation
            </Button>
            <Button variant="secondary" onClick={() => setMode(undefined)}>
              Back
            </Button>
          </div>
        </div>
      )}
      {mode === "decline" && (
        <div className="grid gap-2">
          <textarea className="h-20 w-full border border-border bg-surface px-3 py-2" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why (optional): budget, timing, scope…" aria-label="Reason" />
          <div className="flex gap-2">
            <Button disabled={busy} onClick={send} data-testid="quote-decline-send">
              Decline quotation
            </Button>
            <Button variant="secondary" onClick={() => setMode(undefined)}>
              Back
            </Button>
          </div>
        </div>
      )}
      {error && <p className="text-red">{error}</p>}
    </div>
  );
}

export default function ClientQuotePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const loaded = useLoad(() => api.quotes.mineOne(id), { live: ["Quotation"] });
  const [fresh, setFresh] = useState<QuoteView>();
  const [msg, setMsg] = useState<string>();
  const q = fresh ?? loaded.data;
  if (!q) return <LoadState loading={loaded.loading} error={loaded.error} />;
  return (
    <>
      <Link href="/client/quotes" className="text-sm underline">
        ← Quotations
      </Link>
      <PageTitle title={q.content.title} subtitle={`${q.number} · ${quoteStatusLabels[q.status].client}`} />
      {msg && <p className="mb-3 border border-green bg-green/10 px-3 py-2 text-sm">{msg}</p>}
      {q.status === "accepted" && q.advanceInvoice && (
        <p className="mb-3 text-sm">
          Your advance invoice <strong>{q.advanceInvoice.number}</strong> ({formatINR(q.advanceInvoice.totalPaise)}) is in{" "}
          <Link href="/client/billing" className="underline">
            Billing
          </Link>
          .
        </p>
      )}
      {q.can.decide && (
        <Decide
          q={q}
          onDone={(v) => {
            setFresh(v);
            setMsg(v.message);
          }}
        />
      )}
      {q.status === "sent" && !q.can.decide && <p className="mb-3 text-sm text-ink-muted">Your account Owner can accept or decline this quotation.</p>}
      <QuotationDocument q={q} />
    </>
  );
}
