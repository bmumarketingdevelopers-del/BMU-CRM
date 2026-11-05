"use client";

// v45: one quotation for the client: read it, download it, and (the account Owner) accept it or decline it.
// v49: accepting takes their name plus their signature and seal, or the signed quotation uploaded; they can ask for
// changes; then they pay and say so here, and the team sends the invoice.
import Link from "next/link";
import { use, useState } from "react";
import { formatINR, quoteStatusLabels, type QuoteAcceptFileKind, type QuoteView } from "@bmu/shared";
import { QuotationDocument } from "@/components/quotes/quotation-document";
import { Button, Input, LoadState, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

function FilePick({ label, hint, accept, done, onPick }: { label: string; hint?: string; accept: string; done?: boolean; onPick: (f: File) => void }) {
  return (
    <label className="grid gap-1 text-xs font-medium">
      {label}
      <input type="file" accept={accept} className="text-sm font-normal" aria-label={label} onChange={(e) => e.target.files?.[0] && onPick(e.target.files[0])} />
      {done ? <span className="font-normal text-green">Added</span> : hint ? <span className="font-normal text-ink-muted">{hint}</span> : null}
    </label>
  );
}

function Decide({ q, onDone }: { q: QuoteView; onDone: (v: QuoteView & { message: string }) => void }) {
  const [mode, setMode] = useState<"accept" | "changes" | "decline">();
  const [how, setHow] = useState<"sign" | "upload">("sign");
  const [name, setName] = useState("");
  const [reason, setReason] = useState("");
  const [files, setFiles] = useState<Partial<Record<QuoteAcceptFileKind, string>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const upload = async (kind: QuoteAcceptFileKind, f: File) => {
    setBusy(true);
    setError(undefined);
    try {
      const r = await api.quotes.uploadAcceptance(q.id, kind, f);
      setFiles((x) => ({ ...x, [kind]: r.fileId }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const ready = name.trim().length >= 2 && (how === "sign" ? !!files.signature : !!files.signed_copy);
  const send = async () => {
    setBusy(true);
    setError(undefined);
    try {
      onDone(
        await api.quotes.decide(
          q.id,
          mode === "accept"
            ? { decision: "accept", name: name.trim(), ...(how === "sign" ? { signatureFileId: files.signature, sealFileId: files.seal } : { signedCopyFileId: files.signed_copy }) }
            : { decision: mode!, reason: reason.trim() || undefined },
        ),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mb-5 grid max-w-3xl gap-3 border border-border bg-surface-raised p-4 text-sm" data-testid="quote-decide">
      <p>
        <strong>{formatINR(q.totalPaise)}</strong> incl. GST. Accepting confirms the services and that the project can start.
      </p>
      {!mode && (
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setMode("accept")} data-testid="quote-accept">
            Accept quotation
          </Button>
          <Button variant="secondary" onClick={() => setMode("changes")} data-testid="quote-changes">
            Ask for changes
          </Button>
          <Button variant="secondary" onClick={() => setMode("decline")} data-testid="quote-decline">
            Decline
          </Button>
        </div>
      )}
      {mode === "accept" && (
        <div className="grid gap-3">
          <label className="grid gap-1 text-xs font-medium">
            Your full name
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" aria-label="Your name" />
          </label>
          <div className="flex flex-wrap gap-4 text-sm" role="radiogroup" aria-label="How to sign">
            <label className="flex items-center gap-2">
              <input type="radio" checked={how === "sign"} onChange={() => setHow("sign")} /> Add my signature and seal
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" checked={how === "upload"} onChange={() => setHow("upload")} /> Upload the signed quotation
            </label>
          </div>
          {how === "sign" ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <FilePick label="Signature" accept="image/png,image/jpeg,image/webp" hint="PNG, JPG or WebP, up to 2 MB" done={!!files.signature} onPick={(f) => upload("signature", f)} />
              <FilePick label="Seal (optional)" accept="image/png,image/jpeg,image/webp" hint="PNG, JPG or WebP, up to 2 MB" done={!!files.seal} onPick={(f) => upload("seal", f)} />
            </div>
          ) : (
            <FilePick label="Signed quotation" accept="application/pdf,image/png,image/jpeg,image/webp" hint="Download the PDF below, sign it, and upload it here (PDF or image, up to 4 MB)" done={!!files.signed_copy} onPick={(f) => upload("signed_copy", f)} />
          )}
          <div className="flex gap-2">
            <Button disabled={busy || !ready} onClick={send} data-testid="quote-accept-send">
              I accept this quotation
            </Button>
            <Button variant="secondary" onClick={() => setMode(undefined)}>
              Back
            </Button>
          </div>
        </div>
      )}
      {(mode === "decline" || mode === "changes") && (
        <div className="grid gap-2">
          <textarea className="h-20 w-full border border-border bg-surface px-3 py-2" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={mode === "changes" ? "What should change?" : "Why (optional): budget, timing, scope…"} aria-label={mode === "changes" ? "What should change" : "Reason"} />
          <div className="flex gap-2">
            <Button disabled={busy || (mode === "changes" && reason.trim().length < 3)} onClick={send} data-testid="quote-decline-send">
              {mode === "changes" ? "Send to my Client Manager" : "Decline quotation"}
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

/** v49: once accepted the client pays with the details on the quotation and tells the team here. */
function TellPaid({ q, onDone }: { q: QuoteView; onDone: (v: QuoteView & { message: string }) => void }) {
  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const paise = Math.round((Number(amount.replace(/[^\d.]/g, "")) || 0) * 100);
  const advance = Math.round(((q.subtotalPaise * q.content.advancePct) / 100) * (1 + q.gstRatePct / 100));
  const send = async () => {
    setBusy(true);
    setError(undefined);
    try {
      onDone(await api.quotes.notifyPaid(q.id, { amountPaise: paise, reference: reference.trim() }));
      setAmount("");
      setReference("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mb-5 grid max-w-3xl gap-2 border border-border bg-surface-raised p-4 text-sm" data-testid="quote-paid">
      <p className="font-medium">Have you paid?</p>
      <p className="text-ink-muted">Pay using the details on the quotation{q.content.advancePct > 0 && q.content.advancePct < 100 ? ` (advance ${q.content.advancePct}%: ${formatINR(advance)} incl. GST)` : ""}, then tell us here. Your Client Manager will send your invoice.</p>
      {q.paymentNotes.map((n) => (
        <p key={n.at} className="text-xs">
          Told: {formatINR(n.amountPaise)}, reference {n.reference}
        </p>
      ))}
      <div className="grid gap-2 sm:grid-cols-[10rem_1fr_auto]">
        <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Amount (₹)" aria-label="Amount paid in rupees" />
        <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="UTR or payment reference" aria-label="Payment reference" maxLength={120} />
        <Button disabled={busy || paise <= 0 || reference.trim().length < 3} onClick={send} data-testid="quote-paid-send">
          I have paid
        </Button>
      </div>
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
      {q.can.notifyPaid && (
        <TellPaid
          q={q}
          onDone={(v) => {
            setFresh(v);
            setMsg(v.message);
          }}
        />
      )}
      {q.status === "draft" && <p className="mb-3 text-sm text-ink-muted">Your Client Manager is making your changes. The updated quotation will appear here.</p>}
      {q.status === "accepted" && q.advanceInvoice && (
        <p className="mb-3 text-sm">
          Your invoice <strong>{q.advanceInvoice.number}</strong> ({formatINR(q.advanceInvoice.totalPaise)}) is in{" "}
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
