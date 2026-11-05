"use client";

// v45: BMU's quotation on A4. Page 1: header, from / prepared for / project, the cost breakdown, totals
// and amount in words. Page 2 (only when added): what's included and the timeline. v46, last page, in this order: the
// payment box with a UPI QR, the fixed terms, the two signature lines and the thank-you card. Fixed colours so the app theme never changes the
// document; the print copy sits directly under <body> so "Save as PDF" gives only the quotation.
import { useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import QRCode from "qrcode";
import { formatINR, type QuoteView } from "@bmu/shared";

const INK = "#121619";
const GREEN = "#8cb63c";
const PAPER = "#f7f6f2";
const day = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata" });
const fmt = (iso: string) => day.format(new Date(iso.length === 10 ? `${iso}T00:00:00+05:30` : iso));
const money = (p: number) => formatINR(p).replace(/\.00$/, "");

const CSS = `
.qd { font-family: var(--font-albert-sans), "Segoe UI", Arial, sans-serif; color: ${INK}; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.qd .num { font-variant-numeric: tabular-nums; white-space: nowrap; }
.qd-sheet { width: 210mm; max-width: 100%; min-height: 297mm; background: ${PAPER}; box-shadow: 0 1px 3px rgba(0,0,0,.14); margin: 0 auto 24px; padding: 12mm 15mm 0; display: flex; flex-direction: column; box-sizing: border-box; position: relative; overflow: hidden; }
.qd-sheet::after { content: ""; position: absolute; left: 0; right: 0; bottom: 0; height: 3.2mm; background: ${GREEN}; }
.qd-label { font-size: 8.5px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; color: ${GREEN}; }
.qd-card { background: #fff; border-radius: 6px; border: 1px solid #e7e5df; }
.qd-bar { background: #fff; border-left: 3px solid ${GREEN}; border-radius: 0 4px 4px 0; }
@media screen { .qd-print-root { display: none; } }
@media screen and (max-width: 820px) { .qd-sheet { min-height: 0; padding: 20px 20px 28px; } }
@media print {
  @page { size: A4; margin: 0; }
  html, body { background: #fff !important; }
  body > *:not(.qd-print-root) { display: none !important; }
  .qd-print-root { display: block !important; }
  .qd-sheet { box-shadow: none; margin: 0; width: 210mm; height: 297mm; min-height: 0; break-after: page; page-break-after: always; }
  .qd-sheet:last-child { break-after: auto; page-break-after: auto; }
  /* A long cost breakdown runs on to the next page instead of being cut off. */
  .qd-flow { height: auto; min-height: 296.5mm; overflow: visible; }
  .qd-flow tr { break-inside: avoid; }
}`;

function Logo({ white, h = 14 }: { white?: boolean; h?: number }) {
  // eslint-disable-next-line @next/next/no-img-element -- a static brand image in /public
  return <img src={white ? "/bmu-logo-white.png" : "/bmu-logo.png"} alt="BMU Marketing" style={{ height: `${h}mm`, width: "auto" }} />;
}

function Footer({ q, page }: { q: QuoteView; page: number }) {
  return (
    <footer className="mt-auto flex items-center justify-between pb-[6mm] pt-3 text-[9px] text-[#6b7280]">
      <span>{q.seller.website.replace(/^https?:\/\/(www\.)?/, "")}</span>
      <span className="num">{String(page).padStart(2, "0")}</span>
    </footer>
  );
}

function SmallHeader({ q }: { q: QuoteView }) {
  return (
    <header className="flex items-center justify-between border-b border-[#dcdad3] pb-2.5">
      <Logo h={7} />
      <span className="text-[9px] text-[#6b7280]">Quotation · {q.number}</span>
    </header>
  );
}

function Qr({ uri }: { uri: string | null }) {
  const [src, setSrc] = useState<string>();
  useEffect(() => {
    if (!uri) return;
    QRCode.toDataURL(uri, { margin: 0, width: 220, color: { dark: INK, light: "#ffffff" } }).then(setSrc, () => setSrc(undefined));
  }, [uri]);
  if (!uri || !src) return null;
  return (
    <div className="text-center">
      {/* eslint-disable-next-line @next/next/no-img-element -- a generated data URL */}
      <img src={src} alt="UPI QR code" className="mx-auto h-[20mm] w-[20mm]" />
      <p className="mt-1 text-[8px] text-[#6b7280]">Scan to pay via UPI</p>
    </div>
  );
}

function PageOne({ q }: { q: QuoteView }) {
  const c = q.content;
  return (
    <section className="qd-sheet qd-flow" data-testid="quote-page-1">
      <header className="flex items-start justify-between gap-6">
        <Logo h={11} />
        <div className="text-right">
          <p className="text-[20px] font-bold leading-none tracking-[0.04em]">QUOTATION</p>
          <dl className="mt-2 grid grid-cols-[auto_auto] justify-end gap-x-5 gap-y-0.5 text-[9.5px]">
            <dt className="text-[#6b7280]">Quote No.</dt>
            <dd className="num">{q.number}</dd>
            <dt className="text-[#6b7280]">Date</dt>
            <dd>{fmt(q.date)}</dd>
            <dt className="text-[#6b7280]">Valid until</dt>
            <dd>{fmt(q.validUntil)}</dd>
          </dl>
        </div>
      </header>
      <div className="mt-4 grid grid-cols-3 gap-6 border-t border-[#dcdad3] pt-4 text-[10px] leading-snug">
        <div>
          <p className="qd-label mb-1.5">From</p>
          <p className="font-semibold">{q.seller.name}</p>
          {q.seller.addressLines.map((l) => (
            <p key={l}>{l}</p>
          ))}
          <p>{q.seller.website}</p>
          {q.seller.gstin && <p className="mt-1 text-[#6b7280]">GSTIN {q.seller.gstin}</p>}
        </div>
        <div>
          <p className="qd-label mb-1.5">Prepared for</p>
          <p className="font-semibold">{q.client.name}</p>
          {q.client.preparedFor.map((l) => (
            <p key={l}>{l}</p>
          ))}
        </div>
        <div>
          <p className="qd-label mb-1.5">Project</p>
          <p className="font-semibold">{c.title}</p>
          {c.projectLines.map((l) => (
            <p key={l}>{l}</p>
          ))}
          {q.services.some((n) => !c.title.includes(n)) && <p className="mt-1 text-[#4b5563]" data-testid="quote-services-printed">{q.services.join(" · ")}</p>}
        </div>
      </div>
      <h2 className="mt-6 text-[12px] font-bold">Cost breakdown</h2>
      <table className="mt-2 w-full border-collapse text-[10px]" data-testid="quote-lines">
        <thead>
          <tr className="text-left text-[8.5px] font-bold uppercase tracking-[0.1em] text-white" style={{ background: INK }}>
            <th className="w-[9mm] px-3 py-2">#</th>
            <th className="px-3 py-2">Description</th>
            <th className="px-3 py-2">Qty</th>
            <th className="px-3 py-2">Rate</th>
            <th className="px-3 py-2 text-right">Amount</th>
          </tr>
        </thead>
        <tbody className="bg-white">
          {c.lines.map((l, i) => (
            <tr key={i} className="border-b border-[#e7e5df] align-top">
              <td className="num px-3 py-2">{String(i + 1).padStart(2, "0")}</td>
              <td className="px-3 py-2">
                <p className="font-semibold">{l.title}</p>
                {l.details && <p className="mt-0.5 text-[9.5px] leading-snug text-[#4b5563]">{l.details}</p>}
              </td>
              <td className="num px-3 py-2">{l.kind === "percent" ? `${l.pct}%` : l.qty}</td>
              <td className="num px-3 py-2">{l.kind === "percent" ? "on fees" : money(l.unitPricePaise)}</td>
              <td className="num px-3 py-2 text-right">{money(q.amounts[i] ?? 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-3 ml-auto w-[72mm] text-[10px]">
        <div className="flex justify-between border-b border-[#e7e5df] bg-white px-3 py-1.5">
          <span>Subtotal</span>
          <span className="num">{money(q.subtotalPaise)}</span>
        </div>
        <div className="flex justify-between border-b border-[#e7e5df] bg-white px-3 py-1.5">
          <span>GST @ {q.gstRatePct}%</span>
          <span className="num">{money(q.gstPaise)}</span>
        </div>
        <div className="mt-1 flex justify-between rounded-[4px] px-3 py-1.5 text-[11.5px] font-bold" style={{ background: GREEN }}>
          <span>Grand total</span>
          <span className="num">{money(q.totalPaise)}</span>
        </div>
      </div>
      <p className="mt-2 text-right text-[9px] text-[#4b5563]">Amount in words: {q.amountInWords}.</p>
      <Footer q={q} page={1} />
    </section>
  );
}

function PageTwo({ q }: { q: QuoteView }) {
  const c = q.content;
  if (!c.scope.length && !c.timeline.length) return null;
  return (
    <section className="qd-sheet qd-flow" data-testid="quote-page-2">
      <SmallHeader q={q} />
      {c.scope.length > 0 && (
        <>
          <p className="qd-label mt-4">Scope of work</p>
          <h2 className="mt-0.5 text-[16px] font-bold">What&apos;s included</h2>
          <div className="mt-3 grid grid-cols-2 gap-3">
            {c.scope.map((s) => (
              <div key={s.title} className="qd-card border-t-2 px-4 py-3" style={{ borderTopColor: GREEN }}>
                <p className="text-[11px] font-bold">{s.title}</p>
                <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-[9.5px] leading-snug text-[#374151]">
                  {s.bullets.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </>
      )}
      {c.timeline.length > 0 && (
        <>
          <h2 className="mt-6 text-[12px] font-bold">Timeline</h2>
          <div className="mt-2 grid gap-2" style={{ gridTemplateColumns: `repeat(${Math.min(4, c.timeline.length)}, minmax(0, 1fr))` }}>
            {c.timeline.map((t) => (
              <div key={t.label + t.title} className="rounded-[6px] px-3.5 py-3 text-white" style={{ background: INK }}>
                <p className="text-[8.5px] font-bold uppercase tracking-[0.14em]" style={{ color: GREEN }}>
                  {t.label}
                </p>
                <p className="mt-1 text-[11px] font-bold leading-snug">{t.title}</p>
                {t.text && <p className="mt-1 text-[9.5px] leading-snug text-white/75">{t.text}</p>}
              </div>
            ))}
          </div>
        </>
      )}
      <Footer q={q} page={2} />
    </section>
  );
}

function PageThree({ q, page }: { q: QuoteView; page: number }) {
  const c = q.content;
  const pay = q.payment;
  const rows: [string, string | null][] = [
    ["Account name", pay.accountName],
    ["Account number", pay.accountNumber],
    ["IFSC", pay.ifsc],
    ["SWIFT code", pay.swift],
    ["Bank", pay.bank],
    ["UPI ID", pay.upiId],
  ];
  const shown = rows.filter((r): r is [string, string] => !!r[1]);
  return (
    <section className="qd-sheet" data-testid="quote-page-3">
      <SmallHeader q={q} />
      {(shown.length > 0 || pay.upiUri) && (
        <div className="qd-card mt-4 flex items-center gap-6 border-l-[3px] px-5 py-3" style={{ borderLeftColor: GREEN }} data-testid="quote-payment">
          <div className="min-w-0 flex-1">
            <p className="qd-label mb-1">Payment details</p>
            <dl className="grid grid-cols-[30mm_1fr] gap-y-0.5 text-[10px]">
              {shown.map(([k, v]) => (
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
      <p className="qd-label mt-5">Terms</p>
      <h2 className="mt-0.5 text-[16px] font-bold leading-tight">Terms &amp; conditions</h2>
      <div className="mt-3 grid grid-cols-2 gap-2.5">
        {c.terms.map((t) => (
          <div key={t.title} className="qd-bar px-3.5 py-2">
            <p className="text-[10.5px] font-bold">{t.title}</p>
            <p className="mt-0.5 text-[9.5px] leading-snug text-[#374151]">{t.text}</p>
          </div>
        ))}
      </div>
      <div className="mt-7 grid grid-cols-2 gap-10">
        <div>
          <p className="qd-label">Accepted by client</p>
          <div className="mt-9 border-b" style={{ borderColor: INK }}>
            {q.acceptedName && (
              <p className="pb-1 text-[11px] font-semibold" data-testid="quote-accepted-by">
                {q.acceptedName}
                {q.acceptedAt ? <span className="ml-2 text-[9.5px] font-normal text-[#4b5563]">accepted in the app on {fmt(q.acceptedAt)}</span> : null}
              </p>
            )}
          </div>
          <p className="mt-1 text-[9px] text-[#6b7280]">Name, signature &amp; date</p>
        </div>
        <div>
          <p className="qd-label">For {q.seller.name}</p>
          <div className="mt-9 border-b" style={{ borderColor: INK }} />
          <p className="mt-1 text-[9px] text-[#6b7280]">{q.seller.signatory}</p>
        </div>
      </div>
      <div className="mt-8 flex items-center gap-5 rounded-[6px] px-5 py-3 text-white" style={{ background: INK }}>
        <Logo white h={8} />
        <div>
          <p className="text-[12.5px] font-bold leading-tight" style={{ color: GREEN }}>
            Thank you.
          </p>
          {c.footerLine && <p className="mt-0.5 text-[9.5px] text-white/85">{c.footerLine}</p>}
          <p className="text-[9.5px] text-white/85">{q.seller.website.replace(/^https?:\/\/(www\.)?/, "")}</p>
        </div>
      </div>
      <Footer q={q} page={page} />
    </section>
  );
}

/** The pages alone (the print copy, and for checks). */
export function QuotationPages({ q }: { q: QuoteView }) {
  const two = q.content.scope.length > 0 || q.content.timeline.length > 0;
  return (
    <div className="qd">
      <PageOne q={q} />
      {two && <PageTwo q={q} />}
      <PageThree q={q} page={two ? 3 : 2} />
    </div>
  );
}

const noop = () => () => {};

/** The printable quotation. "Download PDF" opens the print window: choose "Save as PDF". */
export function QuotationDocument({ q, actions }: { q: QuoteView; actions?: React.ReactNode }) {
  const mounted = useSyncExternalStore(noop, () => true, () => false);
  return (
    <>
      <style>{CSS}</style>
      <div className="no-print mb-4 flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => window.print()} className="bg-charcoal px-4 py-2 text-sm font-medium text-ivory" data-testid="quote-pdf">
          Download PDF
        </button>
        {actions}
        <span className="text-xs text-ink-muted">A4 pages. In the print window choose “Save as PDF” and turn off “Headers and footers”.</span>
      </div>
      <div className="overflow-x-auto bg-[#e7e6e1] py-6" data-testid="quotation">
        <QuotationPages q={q} />
      </div>
      {mounted &&
        createPortal(
          <div className="qd-print-root" aria-hidden="true">
            <QuotationPages q={q} />
          </div>,
          document.body,
        )}
    </>
  );
}
