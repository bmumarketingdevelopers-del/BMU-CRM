"use client";

import { useState } from "react";
import Link from "next/link";
import type { Checkout, PublicProposal as Data } from "@bmu/shared";
import { formatINR } from "@bmu/shared";
import { ProposalSummary } from "@/components/proposal-summary";
import { Button, Card, Input, LoadState } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

type RazorpayCheckout = Extract<Checkout, { mode: "razorpay" }>;
type RazorpayResponse = { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string };
declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => { open: () => void };
  }
}

function loadRazorpay(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://checkout.razorpay.com/v1/checkout.js";
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Could not load the payment window"));
    document.body.appendChild(s);
  });
}

const date = new Intl.DateTimeFormat("en-IN", { dateStyle: "long", timeZone: "Asia/Kolkata" });

export function PublicProposal({ token, preview = false }: { token: string; preview?: boolean }) {
  const loaded = useLoad(() => api.publicProposal.view(token, preview));
  const [asking, setAsking] = useState(false);
  const [sentChanges, setSentChanges] = useState(false);
  const [data, setData] = useState<Data>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const view = data ?? loaded.data;

  async function run(fn: () => Promise<Data | void>) {
    setBusy(true);
    setError(undefined);
    try {
      const next = await fn();
      if (next) setData(next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function accept(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await run(() =>
      api.publicProposal.accept(token, {
        signerName: String(f.get("signerName")),
        signerEmail: String(f.get("signerEmail")),
        signerDesignation: String(f.get("signerDesignation") || "") || undefined,
        agree: f.get("agree") === "on" ? true : (false as unknown as true),
      }),
    );
  }

  async function requestChanges(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await run(async () => {
      const next = await api.sell.requestChanges(token, { name: String(f.get("name")), email: String(f.get("email") || "") || undefined, comment: String(f.get("comment")) });
      setAsking(false);
      setSentChanges(true);
      return next;
    });
  }

  async function pay() {
    await run(async () => {
      const c = await api.publicProposal.checkout(token);
      if (c.mode === "test") return api.publicProposal.payTest(token);
      if (c.mode === "razorpay") return openRazorpay(c);
      if (c.mode === "paid") return api.publicProposal.view(token);
      throw new Error("Online payment isn't set up yet. Your account manager will share payment details.");
    });
  }

  async function openRazorpay(c: RazorpayCheckout): Promise<Data> {
    await loadRazorpay();
    return new Promise((resolve, reject) => {
      const rzp = new window.Razorpay!({
        key: c.keyId,
        order_id: c.orderId,
        amount: c.amountPaise,
        currency: "INR",
        name: "BMU Marketing",
        description: `Invoice ${c.invoiceNumber}`,
        prefill: c.prefill,
        theme: { color: "#121F2F" },
        handler: (r: RazorpayResponse) => api.publicProposal.verify(token, r).then(resolve, reject),
        modal: { ondismiss: () => reject(new Error("Payment was cancelled")) },
      });
      rzp.open();
    });
  }

  if (!view) return <LoadState loading={loaded.loading} error={loaded.error} />;
  const p = view.proposal;
  const openChanges = (p.changeRequests ?? []).filter((c) => !c.resolvedAt);

  if (p.status === "superseded") {
    return (
      <Card>
        <p className="text-sm text-ink-muted">Proposal for {p.client.company || p.client.name}</p>
        <h1 className="mt-1 font-display text-2xl">This version has been replaced</h1>
        <p className="mt-2 text-sm">BMU has sent you an updated proposal (based on your feedback). Please review and sign the latest version.</p>
        {p.latestToken ? (
          <Link href={`/p/${p.latestToken}`} className="mt-4 inline-block bg-green px-5 py-2 text-sm font-semibold text-charcoal">
            Open the latest version
          </Link>
        ) : (
          <p className="mt-3 text-sm text-ink-muted">Your account manager will share the new link shortly.</p>
        )}
      </Card>
    );
  }

  return (
    <>
      <p className="text-sm text-ink-muted">Proposal for</p>
      <h1 className="font-display text-3xl">{p.client.company || p.client.name}</h1>
      <p className="mt-1 text-sm text-ink-muted">
        Prepared by BMU Marketing · {p.version > 1 ? `version ${p.version} · ` : ""}valid until {date.format(new Date(p.validUntil))}
      </p>
      {preview && <p className="mt-3 border border-amber bg-amber/10 px-3 py-2 text-xs">Team preview: this visit is not counted as a client view.</p>}
      {p.changeNote && p.version > 1 && <p className="mt-3 text-sm">What changed: {p.changeNote}</p>}
      {view.documents?.intro && <p className="mt-6 max-w-2xl whitespace-pre-wrap text-ink-muted">{view.documents.intro}</p>}

      <Card className="mt-8">
        <ProposalSummary p={p} />
      </Card>

      {view.documents && (
        <details className="mt-6 border border-border bg-surface-raised px-5 py-4 text-sm">
          <summary className="cursor-pointer font-semibold">Terms and service agreement</summary>
          <p className="mt-3 whitespace-pre-wrap text-ink-muted">{view.documents.terms}</p>
          <p className="mt-3 whitespace-pre-wrap text-ink-muted">{view.documents.agreement}</p>
        </details>
      )}

      {error && <p className="mt-4 border border-red bg-red/10 px-4 py-2 text-sm">{error}</p>}

      {p.status === "expired" && (
        <Card className="mt-6">
          <p>This proposal has expired. Contact BMU and we&apos;ll send you an updated one.</p>
        </Card>
      )}

      {(p.status === "sent" || p.status === "expired") && (
        <Card className="mt-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-semibold">Want something changed?</h2>
            {!asking && (
              <Button variant="secondary" onClick={() => setAsking(true)}>
                Request changes
              </Button>
            )}
          </div>
          {sentChanges && <p className="mt-2 border border-green bg-green/10 px-3 py-2 text-sm">Thanks, we&apos;ve got your request. Your BMU contact will send an updated proposal.</p>}
          {openChanges.length > 0 && !asking && (
            <ul className="mt-2 space-y-1 text-sm text-ink-muted">
              {openChanges.map((c) => (
                <li key={c.id}>
                  You asked: “{c.comment}”
                </li>
              ))}
            </ul>
          )}
          {asking && (
            <form onSubmit={requestChanges} className="mt-3 grid gap-3">
              <textarea name="comment" required minLength={5} rows={3} aria-label="What would you like changed?" placeholder="e.g. Can we start with the Growth tier and add the website next quarter?" className="w-full border border-border bg-surface-raised px-3 py-2" />
              <div className="grid gap-3 sm:grid-cols-2">
                <Input name="name" placeholder="Your name" defaultValue={p.client.name} required aria-label="Your name" />
                <Input name="email" type="email" placeholder="Email (optional)" defaultValue={p.client.email} aria-label="Your email" />
              </div>
              <div className="flex gap-2">
                <Button type="submit" disabled={busy}>
                  {busy ? "Sending…" : "Send request"}
                </Button>
                <Button type="button" variant="ghost" onClick={() => setAsking(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          )}
        </Card>
      )}

      {p.status === "sent" && (
        <Card className="mt-6">
          <h2 className="font-semibold">Accept and sign</h2>
          <p className="mt-1 text-sm text-ink-muted">
            Typing your name below is your electronic signature on the service agreement for the items above. We record the time and your IP address.
          </p>
          <form onSubmit={accept} className="mt-4 grid gap-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Input name="signerName" placeholder="Full name" aria-label="Full name" defaultValue={p.client.name} required />
              <Input name="signerDesignation" placeholder="Designation, e.g. Owner, Director" aria-label="Designation" required />
            </div>
            <Input name="signerEmail" type="email" placeholder="Email" aria-label="Email" defaultValue={p.client.email} required />
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" name="agree" className="mt-1 size-4 accent-[#8BB72C]" required />
              <span>
                I accept this proposal and BMU&apos;s terms: scope as listed, retainers billed monthly in advance, projects 50% on confirmation and 50% before handover, and final files handed over once payment is complete.
              </span>
            </label>
            <Button type="submit" disabled={busy}>
              {busy ? "Signing…" : "Accept and sign"}
            </Button>
          </form>
        </Card>
      )}

      {p.status === "accepted" && (
        <p className="mt-6 text-sm">
          {p.signer ? `Signed by ${p.signer.name}${p.signer.designation ? `, ${p.signer.designation}` : ""} on ${date.format(new Date(p.signer.at))}. ` : ""}
          <Link href={`/p/${token}/agreement`} className="underline" target="_blank">
            View or download your signed agreement
          </Link>
        </p>
      )}

      {p.status === "accepted" && !p.paid && (
        <Card className="mt-6">
          <h2 className="font-semibold">Signed. One step left</h2>
          <p className="mt-1 text-sm">
            Invoice {p.invoice?.number}: <strong>{formatINR(p.invoice?.totalPaise ?? 0)}</strong> including GST.
          </p>
          <Button className="mt-4" onClick={pay} disabled={busy}>
            {busy ? "Processing…" : view.payments.razorpay ? "Pay securely (UPI, card, netbanking)" : "Pay now"}
          </Button>
          {view.payments.testMode && (
            <p className="mt-2 text-xs text-ink-muted">Test mode: no real money moves. Add Razorpay keys to apps/api/.env to take real payments.</p>
          )}
        </Card>
      )}

      {p.paid && (
        <Card className="mt-6 border-green">
          <h2 className="font-display text-xl">Welcome to BMU!</h2>
          <p className="mt-2 text-sm">
            {p.kind === "renewal"
              ? `Payment received for invoice ${p.invoice?.number}. Your services continue without a break. Thank you for staying with us!`
              : `Payment received for invoice ${p.invoice?.number}. Your account is ready and your Account Manager will be in touch to start onboarding.`}
          </p>
          <Link href="/sign-in" className="mt-4 inline-block bg-green px-5 py-2 text-sm font-semibold text-charcoal">
            Open your client app
          </Link>
          <p className="mt-2 text-xs text-ink-muted">Sign in with {p.client.email ?? "the email or number you gave us"}.</p>
        </Card>
      )}
    </>
  );
}
