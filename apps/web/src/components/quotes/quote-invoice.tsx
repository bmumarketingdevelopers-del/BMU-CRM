"use client";

// v49: an invoice raised from a quotation, in the quotation's design: same header, table, payment box, signature and
// footer, with no client acceptance. Other invoices keep the classic tax invoice.
import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { formatINR, type ServiceTaxInvoice } from "@bmu/shared";
import { DocFooter, GREEN, INK, Logo, Qr, QD_CSS, SignBox } from "./quotation-document";

const day = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata" });
const fmt = (iso: string) => day.format(new Date(iso));
const money = (p: number) => formatINR(p).replace(/\.00$/, "");

function Row({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return (
    <div className={`flex justify-between border-b border-[#e7e5df] bg-white px-3 py-1.5 ${strong ? "font-semibold" : ""}`}>
      <span>{k}</span>
      <span className="num">{v}</span>
    </div>
  );
}

function Pages({ t }: { t: ServiceTaxInvoice }) {
  const q = t.quote!;
  const pay = t.payment;
  const bank: [string, string | null | undefined][] = [
    ["Account name", pay.payeeName],
    ["Account number", pay.bank?.account],
    ["IFSC", pay.bank?.ifsc],
    ["Bank", [pay.bank?.name, pay.bank?.branch].filter(Boolean).join(", ")],
    ["UPI ID", pay.upiId],
  ];
  const signer = t.signing.signed || !q.signedBy ? { name: t.signatory.name, role: t.signatory.designation } : q.signedBy;
  return (
    <div className="qd">
      <section className="qd-sheet qd-flow" data-testid="quote-invoice">
        <header className="flex items-start justify-between gap-6">
          <Logo h={11} />
          <div className="text-right">
            <p className="text-[20px] font-bold leading-none tracking-[0.04em]">TAX INVOICE</p>
            <dl className="mt-2 grid grid-cols-[auto_auto] justify-end gap-x-5 gap-y-0.5 text-[9.5px]">
              <dt className="text-[#6b7280]">Invoice No.</dt>
              <dd className="num">{t.number}</dd>
              <dt className="text-[#6b7280]">Date</dt>
              <dd>{fmt(t.date)}</dd>
              <dt className="text-[#6b7280]">Due date</dt>
              <dd>{fmt(t.dueDate)}</dd>
              <dt className="text-[#6b7280]">Quotation</dt>
              <dd className="num">{q.number}</dd>
            </dl>
          </div>
        </header>
        <div className="mt-4 grid grid-cols-3 gap-6 border-t border-[#dcdad3] pt-4 text-[10px] leading-snug">
          <div>
            <p className="qd-label mb-1.5">From</p>
            <p className="font-semibold">{t.seller.legalName}</p>
            <p className="whitespace-pre-line">{t.seller.address}</p>
            {t.seller.gstin && <p className="mt-1 text-[#6b7280]">GSTIN {t.seller.gstin}</p>}
          </div>
          <div>
            <p className="qd-label mb-1.5">Billed to</p>
            <p className="font-semibold">{t.buyer.legalName}</p>
            {q.owner && <p>{q.owner}</p>}
            {t.buyer.email && <p className="break-words">{t.buyer.email}</p>}
            {t.buyer.address && <p className="whitespace-pre-line">{t.buyer.address}</p>}
            {t.buyer.gstin && <p className="mt-1 text-[#6b7280]">GSTIN {t.buyer.gstin}</p>}
          </div>
          <div>
            <p className="qd-label mb-1.5">Project</p>
            <p className="font-semibold">{q.title}</p>
            {q.plan && <p data-testid="invoice-plan">{q.plan}</p>}
            <p className="mt-1 text-[#6b7280]">Place of supply: {t.buyer.placeOfSupplyName}</p>
          </div>
        </div>
        <table className="mt-6 w-full border-collapse text-[10px]">
          <thead>
            <tr className="text-left text-[8.5px] font-bold uppercase tracking-[0.1em] text-white" style={{ background: INK }}>
              <th className="w-[9mm] px-3 py-2">#</th>
              <th className="px-3 py-2">Description</th>
              <th className="px-3 py-2">SAC</th>
              <th className="px-3 py-2 text-right">Amount</th>
            </tr>
          </thead>
          <tbody className="bg-white">
            {t.lines.map((l, i) => (
              <tr key={i} className="border-b border-[#e7e5df] align-top">
                <td className="num px-3 py-2">{String(i + 1).padStart(2, "0")}</td>
                <td className="px-3 py-2">
                  <p className="font-semibold">{l.title}</p>
                  {l.details && <p className="mt-0.5 text-[9.5px] leading-snug text-[#4b5563]">{l.details}</p>}
                </td>
                <td className="num px-3 py-2">{l.sac}</td>
                <td className="num px-3 py-2 text-right">{money(l.taxablePaise)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-3 ml-auto w-[72mm] text-[10px]">
          <Row k="Taxable value" v={money(t.taxablePaise)} />
          {t.interState ? (
            <Row k={`IGST @ ${t.ratePct}%`} v={money(t.igstPaise)} />
          ) : (
            <>
              <Row k={`CGST @ ${t.ratePct / 2}%`} v={money(t.cgstPaise)} />
              <Row k={`SGST @ ${t.ratePct / 2}%`} v={money(t.sgstPaise)} />
            </>
          )}
          <div className="mt-1 flex justify-between rounded-[4px] px-3 py-1.5 text-[11.5px] font-bold" style={{ background: GREEN }}>
            <span>Invoice total</span>
            <span className="num">{money(t.totalPaise)}</span>
          </div>
          {t.paidPaise > 0 && <Row k="Paid" v={money(t.paidPaise)} />}
          {t.paidPaise > 0 && <Row k="Balance due" v={money(t.balancePaise)} strong />}
        </div>
        <p className="mt-2 text-right text-[9px] text-[#4b5563]">Amount in words: {t.amountInWords}.</p>

        <div className="flex flex-1 flex-col justify-between gap-5 pb-2 pt-5">
          {t.balancePaise > 0 && (
            <div className="qd-card flex items-center gap-6 border-l-[3px] px-5 py-3" style={{ borderLeftColor: GREEN }}>
              <div className="min-w-0 flex-1">
                <p className="qd-label mb-1">Payment details</p>
                <dl className="grid grid-cols-[30mm_1fr] gap-y-0.5 text-[10px]">
                  {bank
                    .filter((r) => !!r[1])
                    .map(([k, v]) => (
                      <div key={k} className="contents">
                        <dt className="text-[#6b7280]">{k}</dt>
                        <dd className="font-semibold">{v}</dd>
                      </div>
                    ))}
                </dl>
              </div>
              <Qr uri={pay.upiUri} />
            </div>
          )}
          <div>
            <p className="qd-label mb-1">Terms</p>
            <ul className="list-disc space-y-0.5 pl-4 text-[9.5px] leading-snug text-[#374151]">
              {t.terms.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          </div>
          <div className="ml-auto w-[80mm]" data-testid="invoice-signature">
            <p className="qd-label">For {t.seller.legalName}</p>
            <SignBox signature={t.signatory.signatureUrl} seal={t.signatory.sealUrl} />
            <p className="mt-1 text-[9px] text-[#6b7280]">{[signer.name, signer.role].filter(Boolean).join(", ")}</p>
          </div>
          <div className="flex items-center gap-5 rounded-[6px] px-5 py-3 text-white" style={{ background: INK }}>
            <Logo white h={8} />
            <p className="text-[12.5px] font-bold leading-tight" style={{ color: GREEN }}>
              Thank you.
            </p>
          </div>
        </div>
        <DocFooter website={t.seller.website || "www.bmumarketing.in"} page={1} />
      </section>
    </div>
  );
}

const noop = () => () => {};

export function QuoteInvoice({ t, actions }: { t: ServiceTaxInvoice; actions?: React.ReactNode }) {
  const mounted = useSyncExternalStore(noop, () => true, () => false);
  return (
    <>
      <style>{QD_CSS}</style>
      <div className="no-print mb-4 flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => window.print()} className="bg-charcoal px-4 py-2 text-sm font-medium text-ivory">
          Download PDF
        </button>
        {actions}
        <span className="text-xs text-ink-muted">In the print window choose “Save as PDF” and turn off “Headers and footers”.</span>
      </div>
      <div className="overflow-x-auto bg-[#e7e6e1] py-6" id="tax-invoice" data-testid="tax-invoice">
        <Pages t={t} />
      </div>
      {mounted &&
        createPortal(
          <div className="qd-print-root" aria-hidden="true">
            <Pages t={t} />
          </div>,
          document.body,
        )}
    </>
  );
}
