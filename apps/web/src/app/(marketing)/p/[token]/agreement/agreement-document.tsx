"use client";

import Link from "next/link";
import { formatINR } from "@bmu/shared";
import { PaymentPlan } from "@/components/proposal-summary";
import { Button, LoadState } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

const dt = new Intl.DateTimeFormat("en-IN", { dateStyle: "long", timeStyle: "short", timeZone: "Asia/Kolkata" });
const d = new Intl.DateTimeFormat("en-IN", { dateStyle: "long", timeZone: "Asia/Kolkata" });

/** Printable service agreement (Save as PDF from the browser's print dialog). */
export function AgreementDocument({ token }: { token: string }) {
  const a = useLoad(() => api.sell.agreement(token));
  if (!a.data) return <LoadState loading={a.loading} error={a.error} />;
  const { proposal: p, company, signed } = a.data;
  const signer = p.signer;
  return (
    <article className="agreement bg-surface-raised p-8 text-sm leading-relaxed print:p-0">
      <style>{`@media print { body header, body footer, .no-print, nextjs-portal { display: none !important; } @page { margin: 18mm; } .agreement { border: 0 !important; } }`}</style>
      <div className="no-print mb-6 flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
        <Link href={`/p/${token}`} className="underline">
          Back to proposal
        </Link>
        <Button onClick={() => window.print()}>Print or save as PDF</Button>
      </div>

      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-ink pb-4">
        <div>
          <p className="font-display text-2xl">Service agreement</p>
          <p className="text-ink-muted">
            Proposal v{p.version} · {signed && p.acceptedAt ? `signed ${d.format(new Date(p.acceptedAt))}` : "not signed yet"}
          </p>
        </div>
        <div className="text-right">
          <p className="font-semibold">{company.name}</p>
          {company.address && <p className="text-ink-muted">{company.address}</p>}
          {company.gstin && <p className="text-ink-muted">GSTIN {company.gstin}</p>}
        </div>
      </header>

      <section className="mt-6 grid gap-4 sm:grid-cols-2">
        <div>
          <p className="text-[11px] uppercase tracking-[0.12em] text-ink-muted">Service provider</p>
          <p>{company.name}</p>
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-[0.12em] text-ink-muted">Client</p>
          <p>{p.client.company || p.client.name}</p>
          <p className="text-ink-muted">{[p.client.name, p.client.email, p.client.phone].filter(Boolean).join(" · ")}</p>
        </div>
      </section>

      <section className="mt-6">
        <h2 className="mb-2 font-semibold">1. Services and fees</h2>
        <table className="w-full">
          <thead>
            <tr className="border-b border-border text-left text-ink-muted">
              <th className="py-1 font-normal">Service</th>
              <th className="py-1 font-normal">Billing</th>
              <th className="py-1 text-right font-normal">Fee (excl. GST)</th>
            </tr>
          </thead>
          <tbody>
            {p.lines.map((l) => (
              <tr key={`${l.kind}-${l.key}`} className="border-b border-border">
                <td className="py-1">
                  {l.name}
                  {l.qty > 1 ? ` × ${l.qty}` : ""} <span className="capitalize text-ink-muted">{l.tier ?? ""}</span>
                </td>
                <td className="py-1">{l.billingType === "monthly" ? "Monthly" : "One time"}</td>
                <td className="py-1 text-right">{formatINR(l.netPaise)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <dl className="mt-2 space-y-1">
          {p.discountPaise > 0 && (
            <div className="flex justify-between">
              <dt>Discounts applied</dt>
              <dd>−{formatINR(p.discountPaise)}</dd>
            </div>
          )}
          <div className="flex justify-between">
            <dt>GST (18%)</dt>
            <dd>{formatINR(p.gstPaise)}</dd>
          </div>
          <div className="flex justify-between font-semibold">
            <dt>Total (monthly services counted once)</dt>
            <dd>{formatINR(p.totalPaise)}</dd>
          </div>
        </dl>
      </section>

      <section className="mt-6">
        <h2 className="mb-2 font-semibold">2. Payment</h2>
        <p>
          First payment of {formatINR(p.firstPayment.totalPaise)} (incl. GST) on acceptance{p.invoice ? `, invoice ${p.invoice.number}` : ""}.
        </p>
        <PaymentPlan lines={p.lines} />
      </section>

      <section className="mt-6">
        <h2 className="mb-2 font-semibold">3. Terms</h2>
        <p className="whitespace-pre-wrap">{a.data.termsText}</p>
        <p className="mt-3 whitespace-pre-wrap">{a.data.agreementText}</p>
      </section>

      <section className="mt-8 grid gap-6 border-t border-ink pt-6 sm:grid-cols-2">
        <div>
          <p className="text-[11px] uppercase tracking-[0.12em] text-ink-muted">Signed for the client</p>
          {signer ? (
            <>
              <p className="mt-2 font-display text-2xl italic">{signer.name}</p>
              <p>
                {signer.name}
                {signer.designation ? `, ${signer.designation}` : ""}
              </p>
              <p className="text-ink-muted">{signer.email}</p>
              <p className="text-ink-muted">
                Electronically signed {dt.format(new Date(signer.at))} IST{signer.ip ? ` from IP address ${signer.ip}` : ""}
              </p>
            </>
          ) : (
            <p className="mt-2 text-ink-muted">Awaiting signature</p>
          )}
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-[0.12em] text-ink-muted">For {company.name}</p>
          <p className="mt-2">Authorised signatory</p>
          <p className="text-ink-muted">Proposal reference {p.id.slice(-8).toUpperCase()}</p>
        </div>
      </section>
      <p className="mt-6 text-xs text-ink-muted">
        This agreement was accepted electronically by typing the signer&apos;s name. BMU records the signer&apos;s name, designation, email, IP address and time of signing.
      </p>
    </article>
  );
}
