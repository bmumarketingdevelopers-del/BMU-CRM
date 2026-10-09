"use client";

import Link from "next/link";
import { use, useState } from "react";
import { formatINR, type RequestView } from "@bmu/shared";
import { PayButton } from "@/components/pay-button";
import { RequestStatusBadge, RequestTypeLabel, when } from "@/components/request-bits";
import { Button, Card, LoadState, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

export default function ClientRequestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const loaded = useLoad(() => api.client.request(id));
  const [fresh, setFresh] = useState<RequestView>();
  const [body, setBody] = useState("");
  const [reason, setReason] = useState("");
  const [rateNote, setRateNote] = useState("");
  const [reopenWhy, setReopenWhy] = useState("");
  const [reopening, setReopening] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const r = fresh ?? loaded.data;

  async function run(fn: () => Promise<RequestView>) {
    setBusy(true);
    setError(undefined);
    try {
      setFresh(await fn());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!r) return <LoadState loading={loaded.loading} error={loaded.error} />;

  return (
    <>
      <Link href="/client/requests" className="text-sm underline">
        ← All requests
      </Link>
      <PageTitle title={r.description.length > 70 ? `${r.description.slice(0, 70)}…` : r.description} subtitle={`${r.engagement.serviceName} · raised by ${r.createdBy} on ${when.format(new Date(r.createdAt))}`} action={<RequestStatusBadge status={r.status} side="client" />} />

      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <div className="grid gap-4">
          <Card>
            <p className="text-xs text-ink-muted">
              <RequestTypeLabel type={r.type} side="client" />
            </p>
            <p className="mt-1 whitespace-pre-wrap text-sm">{r.description}</p>
          </Card>

          <Card>
            <h2 className="mb-3 font-semibold">Conversation</h2>
            <ol className="space-y-2">
              {r.comments.map((c) => (
                <li key={c.id} className={`border-l-4 px-3 py-2 text-sm ${c.isClient ? "border-green bg-green/10" : "border-charcoal bg-canvas/40"}`}>
                  <p className="text-xs text-ink-muted">
                    <span className="font-semibold text-ink">{c.author}</span> · {when.format(new Date(c.at))}
                  </p>
                  <p className="mt-1 whitespace-pre-wrap">{c.body}</p>
                </li>
              ))}
              {r.comments.length === 0 && <li className="text-sm text-ink-muted">Your Account Manager will reply here.</li>}
            </ol>
            <form
              className="mt-3 grid gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                run(() => api.client.commentRequest(id, body)).then(() => setBody(""));
              }}
            >
              <textarea className="w-full border border-border bg-surface px-3 py-2 text-sm" rows={2} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Add a reply" required />
              <div>
                <Button type="submit" variant="secondary" disabled={busy}>
                  Reply
                </Button>
              </div>
            </form>
          </Card>
        </div>

        <div className="grid content-start gap-4">
          {r.quote && (
            <Card className={r.status === "quoted" ? "border-amber" : ""}>
              <h2 className="font-semibold">Quote</h2>
              {r.quote.addOnName && <p className="text-sm text-ink-muted">{r.quote.addOnName}</p>}
              <dl className="mt-3 grid grid-cols-2 gap-y-1 text-sm">
                <dt>Amount</dt>
                <dd className="text-right">{formatINR(r.quote.amountPaise)}</dd>
                <dt>GST 18%</dt>
                <dd className="text-right">{formatINR(r.quote.gstPaise)}</dd>
                <dt className="font-semibold">Total</dt>
                <dd className="text-right font-semibold">{formatINR(r.quote.totalPaise)}</dd>
                {r.quote.timeline && (
                  <>
                    <dt>Timeline</dt>
                    <dd className="text-right">{r.quote.timeline}</dd>
                  </>
                )}
              </dl>
              {r.status === "quoted" &&
                (r.can.approveQuote ? (
                  <div className="mt-4 grid gap-2">
                    <p className="text-xs text-ink-muted">Approving is your written go-ahead. We start once the invoice is paid.</p>
                    <Button disabled={busy} onClick={() => run(() => api.client.approveQuote(id))}>
                      Approve quote
                    </Button>
                    <input className="border border-border bg-surface px-3 py-1.5 text-sm" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (optional)" />
                    <Button variant="secondary" disabled={busy} onClick={() => run(() => api.client.declineQuote(id, reason || undefined))}>
                      Decline
                    </Button>
                  </div>
                ) : (
                  <p className="mt-3 text-xs text-ink-muted">Only your account owner can approve extra costs. We&apos;ve let them know.</p>
                ))}
              {r.approval && (
                <p className="mt-3 text-xs text-ink-muted">
                  Approved by {r.approval.by} on {when.format(new Date(r.approval.at))}
                </p>
              )}
            </Card>
          )}
          {r.invoice && (
            <Card>
              <h2 className="font-semibold">Invoice {r.invoice.number}</h2>
              <p className="mt-1 text-sm">{formatINR(r.invoice.totalPaise)}</p>
              {r.invoice.status === "paid" ? (
                <p className="mt-2 text-sm font-semibold">Paid ✓ Work is scheduled.</p>
              ) : (
                <PayButton className="mt-3" invoiceId={r.invoice.id} amountPaise={r.invoice.totalPaise} onPaid={() => run(() => api.client.request(id))} />
              )}
              <Link href={`/client/billing/${r.invoice.id}`} className="mt-2 block text-xs underline">
                View tax invoice
              </Link>
            </Card>
          )}
          {r.status === "done" && (
            <Card className={r.rating ? "" : "border-green"}>
              <h2 className="font-semibold">How did we do?</h2>
              {r.rating ? (
                <p className="mt-2 text-sm" data-testid="request-rating">
                  You rated this {r.rating.value === "up" ? "👍 thumbs up" : "👎 thumbs down"}
                  {r.rating.comment ? `: “${r.rating.comment}”` : ""}. Thank you!
                </p>
              ) : (
                <p className="mt-1 text-xs text-ink-muted">Your rating goes straight to your Account Manager and our quality review.</p>
              )}
              {r.can.rate && (
                <div className="mt-3 grid gap-2">
                  <textarea className="w-full border border-border bg-surface px-3 py-2 text-sm" rows={2} value={rateNote} onChange={(e) => setRateNote(e.target.value)} placeholder="Anything to add? (optional)" maxLength={1000} />
                  <div className="flex gap-2">
                    <Button disabled={busy} onClick={() => run(() => api.service.rateRequest(id, { rating: "up", comment: rateNote || undefined }))} aria-label="Thumbs up">
                      👍 Happy
                    </Button>
                    <Button variant="secondary" disabled={busy} onClick={() => run(() => api.service.rateRequest(id, { rating: "down", comment: rateNote || undefined }))} aria-label="Thumbs down">
                      👎 Not happy
                    </Button>
                  </div>
                </div>
              )}
              {r.can.reopen && (
                <div className="mt-4 border-t border-border pt-3">
                  {reopening ? (
                    <form
                      className="grid gap-2"
                      onSubmit={(e) => {
                        e.preventDefault();
                        run(() => api.service.reopenRequest(id, reopenWhy)).then(() => (setReopening(false), setReopenWhy("")));
                      }}
                    >
                      <textarea className="w-full border border-border bg-surface px-3 py-2 text-sm" rows={2} value={reopenWhy} onChange={(e) => setReopenWhy(e.target.value)} placeholder="What still needs fixing?" required minLength={3} />
                      <div className="flex gap-2">
                        <Button type="submit" variant="secondary" disabled={busy}>
                          Reopen request
                        </Button>
                        <Button type="button" variant="ghost" onClick={() => setReopening(false)}>
                          Cancel
                        </Button>
                      </div>
                    </form>
                  ) : (
                    <p className="text-xs text-ink-muted">
                      Not quite right?{" "}
                      <button className="underline" onClick={() => setReopening(true)}>
                        Reopen it
                      </button>{" "}
                      until {r.reopenUntil ? when.format(new Date(r.reopenUntil)) : "7 days after it was done"}.
                    </p>
                  )}
                </div>
              )}
            </Card>
          )}
          {!!r.reopenCount && r.status !== "done" && <p className="text-xs text-ink-muted">Reopened {r.reopenCount === 1 ? "once" : `${r.reopenCount} times`}. Your Account Manager is on it.</p>}
          {error && <p className="text-sm text-red">{error}</p>}
        </div>
      </div>
    </>
  );
}
