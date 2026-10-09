"use client";

import { formatINR, paymentMethodLabels, type ServiceTaxInvoice } from "@bmu/shared";
import { Button } from "@/components/ui";

const day = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" });
const d = (iso: string) => day.format(new Date(iso));

/** Only the invoice is printed: the app shell, menus and buttons are hidden by these print styles. */
const PRINT_CSS = `
@media print {
  @page { size: A4; margin: 12mm; }
  body * { visibility: hidden !important; }
  #tax-invoice, #tax-invoice * { visibility: visible !important; }
  #tax-invoice { position: absolute; left: 0; top: 0; width: 100%; border: 0 !important; padding: 0 !important; box-shadow: none !important; }
  .no-print { display: none !important; }
}`;

export function PrintButton({ label = "Download PDF" }: { label?: string }) {
  return (
    <Button type="button" onClick={() => window.print()} className="no-print">
      {label}
    </Button>
  );
}

const statusText: Record<string, string> = { paid: "Paid", partially_paid: "Part paid", issued: "Due", overdue: "Overdue", void: "Cancelled", credit_noted: "Credited", draft: "Draft" };

/** Printable GST tax invoice. Browser "Save as PDF" gives a clean A4 PDF. */
export function TaxInvoice({ t, actions }: { t: ServiceTaxInvoice; actions?: React.ReactNode }) {
  const half = t.ratePct / 2;
  return (
    <>
      <style>{PRINT_CSS}</style>
      <div className="no-print mb-4 flex flex-wrap items-center gap-3">
        <PrintButton />
        {actions}
        <span className="text-xs text-ink-muted">Tip: in the print window choose “Save as PDF”.</span>
      </div>
      <article id="tax-invoice" className="mx-auto max-w-3xl border border-border bg-surface-raised p-5 text-[13px] leading-relaxed text-ink sm:p-8" data-testid="tax-invoice">
        <header className="flex flex-wrap items-start justify-between gap-4 border-b-2 border-charcoal pb-4">
          <div className="min-w-0">
            <p className="text-lg font-semibold">{t.seller.legalName}</p>
            {t.seller.address && <p className="whitespace-pre-line text-ink-muted">{t.seller.address}</p>}
            <p className="text-ink-muted">
              {t.seller.gstin ? <>GSTIN <strong className="text-ink">{t.seller.gstin}</strong> · </> : <>GSTIN not set (Command Centre → GST Settings) · </>}
              State {t.seller.state} ({t.seller.stateCode})
            </p>
            {(t.seller.email || t.seller.phone) && <p className="text-ink-muted">{[t.seller.email, t.seller.phone, t.seller.website].filter(Boolean).join(" · ")}</p>}
          </div>
          <div className="text-right">
            <p className="text-xl font-semibold tracking-wide">TAX INVOICE</p>
            <p>
              No. <strong>{t.number}</strong>
            </p>
            <p>Date {d(t.date)}</p>
            <p>Due {d(t.dueDate)}</p>
            <p className={`mt-1 inline-block border px-2 py-0.5 text-xs font-semibold ${t.status === "paid" ? "border-green text-[#5f8a12]" : t.balancePaise > 0 && new Date(t.dueDate) < new Date() ? "border-red text-red" : "border-border"}`}>{statusText[t.status] ?? t.status}</p>
          </div>
        </header>

        <section className="grid gap-4 border-b border-border py-4 sm:grid-cols-2">
          <div className="min-w-0">
            <p className="text-[11px] uppercase tracking-[0.12em] text-ink-muted">Billed to</p>
            <p className="font-semibold">{t.buyer.legalName}</p>
            {t.buyer.legalName !== t.buyer.name && <p className="text-ink-muted">({t.buyer.name})</p>}
            {t.buyer.address && <p className="whitespace-pre-line">{t.buyer.address}</p>}
            <p>GSTIN {t.buyer.gstin ?? <span className="text-ink-muted">Unregistered</span>}</p>
            {t.buyer.email && <p className="text-ink-muted">{t.buyer.email}</p>}
          </div>
          <div className="sm:text-right">
            <p className="text-[11px] uppercase tracking-[0.12em] text-ink-muted">Place of supply</p>
            <p>
              {t.buyer.placeOfSupplyName} ({t.buyer.placeOfSupply})
            </p>
            <p className="text-ink-muted">{t.interState ? "Inter-state supply: IGST" : "Intra-state supply: CGST + SGST"}</p>
            <p className="text-ink-muted">Reverse charge: No</p>
          </div>
        </section>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[28rem] border-collapse">
            <thead>
              <tr className="border-b border-charcoal text-left text-[11px] uppercase tracking-[0.1em] text-ink-muted">
                <th className="py-2 pr-2 font-normal">#</th>
                <th className="py-2 pr-2 font-normal">Description of service</th>
                <th className="py-2 pr-2 font-normal">SAC</th>
                <th className="py-2 text-right font-normal">Taxable value</th>
              </tr>
            </thead>
            <tbody>
              {t.lines.map((l, i) => (
                <tr key={i} className="border-b border-border">
                  <td className="py-2 pr-2 align-top">{i + 1}</td>
                  <td className="py-2 pr-2">{l.label}</td>
                  <td className="py-2 pr-2 align-top">{l.sac}</td>
                  <td className="py-2 text-right align-top">{formatINR(l.taxablePaise)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <section className="flex flex-wrap justify-between gap-6 py-4">
          <div className="max-w-sm min-w-0 flex-1">
            <p className="text-[11px] uppercase tracking-[0.12em] text-ink-muted">Amount in words</p>
            <p className="font-medium">{t.amountInWords}</p>
          </div>
          <dl className="grid w-full max-w-xs grid-cols-[1fr_auto] gap-x-6 gap-y-1">
            <dt>Taxable value</dt>
            <dd className="text-right">{formatINR(t.taxablePaise)}</dd>
            {t.interState ? (
              <>
                <dt>IGST {t.ratePct}%</dt>
                <dd className="text-right">{formatINR(t.igstPaise)}</dd>
              </>
            ) : (
              <>
                <dt>CGST {half}%</dt>
                <dd className="text-right">{formatINR(t.cgstPaise)}</dd>
                <dt>SGST {half}%</dt>
                <dd className="text-right">{formatINR(t.sgstPaise)}</dd>
              </>
            )}
            <dt className="border-t border-charcoal pt-1 font-semibold">Invoice total</dt>
            <dd className="border-t border-charcoal pt-1 text-right font-semibold">{formatINR(t.totalPaise)}</dd>
            {t.paidPaise > 0 && (
              <>
                <dt className="text-ink-muted">Paid</dt>
                <dd className="text-right text-ink-muted">− {formatINR(t.paidPaise)}</dd>
              </>
            )}
            {t.creditedPaise > 0 && (
              <>
                <dt className="text-ink-muted">Credit notes</dt>
                <dd className="text-right text-ink-muted">− {formatINR(t.creditedPaise)}</dd>
              </>
            )}
            {(t.paidPaise > 0 || t.creditedPaise > 0 || t.balancePaise > 0) && (
              <>
                <dt className="font-semibold">Balance due</dt>
                <dd className="text-right font-semibold">{formatINR(t.balancePaise)}</dd>
              </>
            )}
          </dl>
        </section>

        {t.balancePaise > 0 && (
          <section className="grid gap-3 border-t border-border py-4 sm:grid-cols-2">
            <div>
              <p className="text-[11px] uppercase tracking-[0.12em] text-ink-muted">How to pay</p>
              <p>Online: open this invoice in BMU Hub → Billing and press Pay.</p>
              {t.payment.upiId && (
                <p>
                  UPI: <strong>{t.payment.upiId}</strong> ({t.payment.payeeName})
                  {t.payment.upiUri && (
                    <a href={t.payment.upiUri} className="no-print ml-2 underline">
                      Open UPI app
                    </a>
                  )}
                </p>
              )}
            </div>
            {t.payment.bank && (
              <div>
                <p className="text-[11px] uppercase tracking-[0.12em] text-ink-muted">Bank transfer</p>
                <p>{t.payment.bank.name}</p>
                <p>A/c {t.payment.bank.account}</p>
                <p>IFSC {t.payment.bank.ifsc}{t.payment.bank.branch ? ` · ${t.payment.bank.branch}` : ""}</p>
                <p className="text-ink-muted">Please quote {t.number} as the reference.</p>
              </div>
            )}
          </section>
        )}

        {(t.payments.length > 0 || t.creditNotes.length > 0) && (
          <section className="border-t border-border py-4">
            <p className="text-[11px] uppercase tracking-[0.12em] text-ink-muted">Received against this invoice</p>
            <ul>
              {t.payments.map((p, i) => (
                <li key={i}>
                  {d(p.at)} · {formatINR(p.amountPaise)} · {paymentMethodLabels[p.method] ?? p.method}
                  {p.ref ? ` · ref ${p.ref}` : ""}
                </li>
              ))}
              {t.creditNotes.map((c) => (
                <li key={c.number}>
                  {d(c.at)} · Credit note {c.number} · {formatINR(c.totalPaise)} · {c.reason}
                </li>
              ))}
            </ul>
          </section>
        )}

        <footer className="border-t border-border pt-4 text-[11px] text-ink-muted">
          <p>This is a computer-generated invoice and does not need a signature. Prices are exclusive of GST; GST is charged at {t.ratePct}% under SAC {t.sacCode}.</p>
          <p className="mt-2 text-right text-[13px] text-ink">For {t.seller.legalName}</p>
        </footer>
      </article>
    </>
  );
}
