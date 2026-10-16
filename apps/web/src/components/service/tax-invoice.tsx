"use client";

// v27: the two-page GST tax invoice. Page 1 is the tax invoice (letterhead, bill-to, line items with their printed
// wording, tax, total, amount in words, signature and company seal); page 2 is the payment receipt (paid, part paid),
// the credit note (credited) or how to pay (new subscription, due, overdue), with the terms. Fixed colours and type so
// the screen theme never changes the document; the print copy sits outside the app shell so the PDF is only the invoice.
import { useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { formatINR, paymentMethodLabels, serviceInvoiceVariantInfo, type ServiceInvoiceVariant, type ServiceTaxInvoice } from "@bmu/shared";
import { Button } from "@/components/ui";

const day = new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
const d = (iso: string) => day.format(new Date(iso));

const PRINT_CSS = `
.inv-doc { font-family: var(--font-albert-sans), "Segoe UI", Arial, sans-serif; color: #1c2430; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.inv-doc .num { font-variant-numeric: tabular-nums; white-space: nowrap; }
.inv-sheet { width: 210mm; max-width: 100%; min-height: 297mm; background: #ffffff; box-shadow: 0 1px 3px rgba(0,0,0,.12); margin: 0 auto 24px; padding: 14mm 14mm 12mm; display: flex; flex-direction: column; box-sizing: border-box; }
@media screen { .inv-print-root { display: none; } }
@media screen and (max-width: 820px) { .inv-sheet { min-height: 0; padding: 20px; } }
@media print {
  @page { size: A4; margin: 0; }
  html, body { background: #ffffff !important; }
  body > *:not(.inv-print-root) { display: none !important; }
  .inv-print-root { display: block !important; }
  .inv-sheet { box-shadow: none; margin: 0; width: 210mm; height: 297mm; min-height: 0; overflow: hidden; break-after: page; page-break-after: always; }
  .inv-sheet:last-child { break-after: auto; page-break-after: auto; }
}`;

const TONES: Record<"green" | "amber" | "red" | "blue" | "grey", { border: string; text: string; bg: string }> = {
  green: { border: "#5f8a12", text: "#4a6e0c", bg: "#f2f7e6" },
  amber: { border: "#b7791f", text: "#975a16", bg: "#fdf6e7" },
  red: { border: "#c53030", text: "#9b2c2c", bg: "#fdecec" },
  blue: { border: "#2b6cb0", text: "#2c5282", bg: "#ebf4fc" },
  grey: { border: "#718096", text: "#4a5568", bg: "#f2f3f5" },
};

const PAGE_TITLE: Record<ServiceInvoiceVariant, string> = {
  new_subscription: "Welcome and payment details",
  due: "Payment details",
  overdue: "Payment overdue",
  part_paid: "Payment receipt",
  paid: "Payment receipt",
  credited: "Credit note",
  draft: "Payment details (draft)",
  cancelled: "Invoice cancelled",
};

const noop = () => () => {};

export function PrintButton({ label = "Download PDF" }: { label?: string }) {
  return (
    <Button type="button" onClick={() => window.print()} className="no-print">
      {label}
    </Button>
  );
}

function Stamp({ v }: { v: ServiceInvoiceVariant }) {
  const info = serviceInvoiceVariantInfo[v];
  const c = TONES[info.tone];
  return (
    <span className="inline-block rounded-sm border-2 px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-[0.14em]" style={{ borderColor: c.border, color: c.text, background: c.bg }} data-testid="invoice-stamp">
      {info.stamp}
    </span>
  );
}

const Label = ({ children }: { children: ReactNode }) => <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#6b7280]">{children}</p>;

function Letterhead({ t, title }: { t: ServiceTaxInvoice; title: string }) {
  return (
    <header className="flex items-start justify-between gap-6 border-b-2 border-[#121f2f] pb-4">
      <div className="min-w-0 max-w-[60%]">
        <p className="text-[18px] font-semibold leading-tight text-[#121f2f]">{t.seller.legalName}</p>
        <p className="mt-1 text-[11.5px] leading-snug text-[#4b5563]">{t.seller.address}</p>
        <p className="mt-1 text-[11.5px] leading-snug text-[#4b5563]">
          {[t.seller.email, t.seller.phone].filter(Boolean).join("  ·  ")}
          {t.seller.website ? `  ·  ${t.seller.website.replace(/^https?:\/\//, "")}` : ""}
        </p>
        <p className="mt-1 text-[11.5px] text-[#4b5563]">
          GSTIN: <span className="font-medium text-[#1c2430]">{t.seller.gstin || "Not set"}</span>  ·  State: {t.seller.state} ({t.seller.stateCode})
        </p>
      </div>
      <div className="shrink-0 text-right">
        <p className="text-[20px] font-bold tracking-[0.08em] text-[#121f2f]">{title}</p>
        <div className="mt-1.5">
          <Stamp v={t.variant} />
        </div>
      </div>
    </header>
  );
}

function Footer({ t, page }: { t: ServiceTaxInvoice; page: 1 | 2 }) {
  return (
    <footer className="mt-auto flex items-end justify-between border-t border-[#e5e7eb] pt-2 text-[10px] text-[#6b7280]">
      <span>
        {t.seller.legalName}  ·  Invoice {t.number}
      </span>
      <span>Page {page} of 2</span>
    </footer>
  );
}

function Signature({ t }: { t: ServiceTaxInvoice }) {
  const s = t.signatory;
  return (
    <div className="w-[64mm] text-center" data-testid="invoice-signature">
      <p className="text-[11.5px] text-[#4b5563]">For {t.seller.legalName}</p>
      <div className="flex h-[28mm] items-end justify-center gap-0 pb-1">
        {/* eslint-disable-next-line @next/next/no-img-element -- signed-in image from the API, not optimisable */}
        {s.sealUrl && <img src={s.sealUrl} alt="Company seal" className="h-[24mm] w-[24mm] shrink-0 object-contain opacity-90" />}
        {/* eslint-disable-next-line @next/next/no-img-element -- signed-in image from the API, not optimisable */}
        {s.signatureUrl && <img src={s.signatureUrl} alt="Signature" className={`relative z-10 max-h-[16mm] max-w-[40mm] object-contain ${s.sealUrl ? "-ml-[4mm] mb-[1mm]" : ""}`} />}
      </div>
      <div className="border-t border-[#1c2430] pt-1">
        {s.name && <p className="text-[12px] font-semibold text-[#1c2430]">{s.name}</p>}
        <p className="text-[11px] text-[#4b5563]">{s.designation ? `${s.designation} · ` : ""}Authorised Signatory</p>
      </div>
    </div>
  );
}

function Row({ k, v, strong, muted }: { k: string; v: string; strong?: boolean; muted?: boolean }) {
  return (
    <div className={`flex justify-between gap-6 py-[3px] ${strong ? "border-t border-[#1c2430] pt-1.5 text-[13.5px] font-semibold" : "text-[12px]"} ${muted ? "text-[#6b7280]" : ""}`}>
      <span>{k}</span>
      <span className="num">{v}</span>
    </div>
  );
}

function PageOne({ t }: { t: ServiceTaxInvoice }) {
  const half = t.ratePct / 2;
  // GST is charged on services only; pass-through costs (ad spend, creator fees) are shown on their own.
  const passThrough = t.lines.filter((l) => l.passThrough).reduce((s, l) => s + l.taxablePaise, 0);
  const services = t.taxablePaise - passThrough;
  return (
    <section className="inv-sheet" data-testid="invoice-page-1">
      <Letterhead t={t} title="TAX INVOICE" />
      <div className="grid grid-cols-[1fr_auto] gap-6 border-b border-[#e5e7eb] py-4 text-[12px]">
        <div className="min-w-0">
          <Label>Billed to</Label>
          <p className="text-[13px] font-semibold text-[#1c2430]">{t.buyer.legalName}</p>
          {t.buyer.legalName !== t.buyer.name && <p className="text-[#4b5563]">{t.buyer.name}</p>}
          {t.buyer.address && <p className="whitespace-pre-line leading-snug text-[#4b5563]">{t.buyer.address}</p>}
          <p className="text-[#4b5563]">GSTIN: {t.buyer.gstin ?? "Unregistered"}</p>
          {t.buyer.email && <p className="text-[#4b5563]">{t.buyer.email}</p>}
        </div>
        <dl className="grid grid-cols-[auto_auto] gap-x-5 gap-y-[3px] self-start text-right">
          <dt className="text-left text-[#6b7280]">Invoice no.</dt>
          <dd className="font-semibold">{t.number}</dd>
          <dt className="text-left text-[#6b7280]">Invoice date</dt>
          <dd>{d(t.date)}</dd>
          <dt className="text-left text-[#6b7280]">Due date</dt>
          <dd>{d(t.dueDate)}</dd>
          <dt className="text-left text-[#6b7280]">Place of supply</dt>
          <dd>
            {t.buyer.placeOfSupplyName} ({t.buyer.placeOfSupply})
          </dd>
          <dt className="text-left text-[#6b7280]">Supply</dt>
          <dd>{t.interState ? "Inter-state (IGST)" : "Intra-state (CGST + SGST)"}</dd>
          <dt className="text-left text-[#6b7280]">Reverse charge</dt>
          <dd>No</dd>
        </dl>
      </div>

      <table className="mt-4 w-full border-collapse text-[12px]">
        <thead>
          <tr className="bg-[#121f2f] text-left text-[10px] uppercase tracking-[0.12em] text-white">
            <th className="w-8 px-2 py-2 font-semibold">#</th>
            <th className="px-2 py-2 font-semibold">Description of service</th>
            <th className="w-20 px-2 py-2 font-semibold">SAC</th>
            <th className="w-32 px-2 py-2 text-right font-semibold">Amount (₹)</th>
          </tr>
        </thead>
        <tbody>
          {t.lines.map((l, i) => (
            <tr key={i} className="border-b border-[#e5e7eb] align-top">
              <td className="px-2 py-2.5 text-[#6b7280]">{i + 1}</td>
              <td className="px-2 py-2.5">
                <p className="font-medium text-[#1c2430]">{l.title}</p>
                {l.details && <p className="mt-0.5 text-[11px] leading-snug text-[#6b7280]">{l.details}</p>}
              </td>
              <td className="px-2 py-2.5 text-[#4b5563]">{l.passThrough ? "—" : l.sac}</td>
              <td className="num px-2 py-2.5 text-right">{formatINR(l.taxablePaise)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="mt-4 grid grid-cols-[1fr_74mm] gap-8">
        <div className="min-w-0 text-[12px]">
          <Label>Amount in words</Label>
          <p className="font-medium leading-snug text-[#1c2430]">{t.amountInWords}</p>
          {t.notes && (
            <div className="mt-4">
              <Label>Note</Label>
              <p className="whitespace-pre-line leading-snug text-[#4b5563]">{t.notes}</p>
            </div>
          )}
        </div>
        <div>
          <Row k={passThrough ? "Taxable value (services)" : "Taxable value"} v={formatINR(services)} />
          {t.interState ? (
            <Row k={`IGST @ ${t.ratePct}%`} v={formatINR(t.igstPaise)} />
          ) : (
            <>
              <Row k={`CGST @ ${half}%`} v={formatINR(t.cgstPaise)} />
              <Row k={`SGST @ ${half}%`} v={formatINR(t.sgstPaise)} />
            </>
          )}
          {passThrough > 0 && <Row k="Pass-through (no GST)" v={formatINR(passThrough)} />}
          <Row k="Invoice total" v={formatINR(t.totalPaise)} strong />
          {t.paidPaise > 0 && <Row k="Received" v={`− ${formatINR(t.paidPaise)}`} muted />}
          {t.creditedPaise > 0 && <Row k="Credit notes" v={`− ${formatINR(t.creditedPaise)}`} muted />}
          {(t.paidPaise > 0 || t.creditedPaise > 0) && <Row k="Balance due" v={formatINR(t.balancePaise)} strong />}
        </div>
      </div>

      <div className="mt-8 flex justify-end">
        <Signature t={t} />
      </div>
      <p className="mt-6 text-[10px] text-[#9ca3af]">GST charged at {t.ratePct}% under SAC {t.sacCode} on service lines. Payment details and terms are on page 2.</p>
      <Footer t={t} page={1} />
    </section>
  );
}

function HowToPay({ t }: { t: ServiceTaxInvoice }) {
  return (
    <div className="grid grid-cols-2 gap-6 text-[12px]">
      <div>
        <Label>Pay online</Label>
        <p className="leading-snug text-[#4b5563]">Open this invoice in BMU Hub → Billing and press Pay (cards, UPI, net banking).</p>
        {t.payment.upiId && (
          <div className="mt-3">
            <Label>UPI</Label>
            <p className="font-semibold text-[#1c2430]">{t.payment.upiId}</p>
            <p className="text-[#4b5563]">Payee: {t.payment.payeeName}</p>
          </div>
        )}
      </div>
      {t.payment.bank ? (
        <div>
          <Label>Bank transfer</Label>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-[3px]">
            <dt className="text-[#6b7280]">Account name</dt>
            <dd>{t.payment.payeeName}</dd>
            <dt className="text-[#6b7280]">Bank</dt>
            <dd>{t.payment.bank.name}</dd>
            <dt className="text-[#6b7280]">Account no.</dt>
            <dd className="num">{t.payment.bank.account}</dd>
            <dt className="text-[#6b7280]">IFSC</dt>
            <dd>{t.payment.bank.ifsc}</dd>
            {t.payment.bank.branch && (
              <>
                <dt className="text-[#6b7280]">Branch</dt>
                <dd>{t.payment.bank.branch}</dd>
              </>
            )}
          </dl>
          <p className="mt-2 text-[11px] text-[#6b7280]">Please quote {t.number} as the payment reference.</p>
        </div>
      ) : (
        <div />
      )}
    </div>
  );
}

function PageTwo({ t }: { t: ServiceTaxInvoice }) {
  const v = t.variant;
  const receipt = v === "paid" || v === "part_paid";
  return (
    <section className="inv-sheet" data-testid="invoice-page-2">
      <Letterhead t={t} title={receipt ? "PAYMENT RECEIPT" : v === "credited" ? "CREDIT NOTE" : "PAYMENT DETAILS"} />
      <div className="flex items-baseline justify-between gap-4 border-b border-[#e5e7eb] py-4">
        <div>
          <p className="text-[15px] font-semibold text-[#121f2f]">{PAGE_TITLE[v]}</p>
          <p className="text-[12px] text-[#4b5563]">
            Against tax invoice {t.number} dated {d(t.date)}, billed to {t.buyer.legalName}.
          </p>
        </div>
        <div className="text-right">
          <p className="text-[10px] uppercase tracking-[0.14em] text-[#6b7280]">{receipt ? "Amount received" : v === "credited" ? "Credited" : "Amount due"}</p>
          <p className="num text-[20px] font-bold text-[#121f2f]">{formatINR(receipt ? t.paidPaise : v === "credited" ? t.creditedPaise : t.balancePaise || t.totalPaise)}</p>
          {!receipt && v !== "credited" && v !== "cancelled" && <p className="text-[11.5px] text-[#4b5563]">Due by {d(t.dueDate)}</p>}
        </div>
      </div>

      <div className="flex-1 space-y-6 py-5">
        {v === "new_subscription" && (
          <p className="text-[12.5px] leading-relaxed text-[#1c2430]">
            Welcome to {t.seller.legalName}. This is the first invoice for your new subscription. Work starts as soon as this payment is received; your Client Manager will share the
            plan and the next steps in BMU Hub.
          </p>
        )}
        {v === "overdue" && (
          <p className="rounded-sm border-l-4 border-[#c53030] bg-[#fdecec] px-3 py-2 text-[12.5px] leading-snug text-[#9b2c2c]">
            This invoice was due on {d(t.dueDate)} and is now overdue. Please pay {formatINR(t.balancePaise)} at the earliest so work continues without a pause. If you have already paid, please share the reference with us.
          </p>
        )}
        {v === "cancelled" && <p className="text-[12.5px] text-[#4b5563]">This invoice has been cancelled and nothing is payable against it.</p>}

        {(receipt || t.payments.length > 0) && (
          <div>
            <Label>Payments received</Label>
            <table className="w-full border-collapse text-[12px]" data-testid="invoice-receipt">
              <thead>
                <tr className="border-b border-[#1c2430] text-left text-[10px] uppercase tracking-[0.12em] text-[#6b7280]">
                  <th className="py-1.5 pr-2 font-semibold">Date</th>
                  <th className="py-1.5 pr-2 font-semibold">Method</th>
                  <th className="py-1.5 pr-2 font-semibold">Reference</th>
                  <th className="py-1.5 text-right font-semibold">Amount (₹)</th>
                </tr>
              </thead>
              <tbody>
                {t.payments.map((p, i) => (
                  <tr key={i} className="border-b border-[#e5e7eb]">
                    <td className="py-2 pr-2">{d(p.at)}</td>
                    <td className="py-2 pr-2">{paymentMethodLabels[p.method] ?? p.method}</td>
                    <td className="py-2 pr-2 text-[#4b5563]">{p.ref || "—"}</td>
                    <td className="num py-2 text-right">{formatINR(p.amountPaise)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="ml-auto mt-3 w-[74mm]">
              <Row k="Invoice total" v={formatINR(t.totalPaise)} />
              <Row k="Received" v={formatINR(t.paidPaise)} />
              {t.creditedPaise > 0 && <Row k="Credit notes" v={formatINR(t.creditedPaise)} />}
              <Row k={t.balancePaise > 0 ? "Balance due" : "Balance"} v={formatINR(t.balancePaise)} strong />
            </div>
            {v === "paid" && <p className="mt-3 text-[12.5px] font-medium text-[#4a6e0c]">Paid in full. Thank you for your payment.</p>}
          </div>
        )}

        {t.creditNotes.length > 0 && (
          <div>
            <Label>Credit notes</Label>
            <table className="w-full border-collapse text-[12px]">
              <thead>
                <tr className="border-b border-[#1c2430] text-left text-[10px] uppercase tracking-[0.12em] text-[#6b7280]">
                  <th className="py-1.5 pr-2 font-semibold">Credit note</th>
                  <th className="py-1.5 pr-2 font-semibold">Date</th>
                  <th className="py-1.5 pr-2 font-semibold">Reason</th>
                  <th className="py-1.5 text-right font-semibold">Amount (₹)</th>
                </tr>
              </thead>
              <tbody>
                {t.creditNotes.map((c) => (
                  <tr key={c.number} className="border-b border-[#e5e7eb] align-top">
                    <td className="py-2 pr-2 font-medium">{c.number}</td>
                    <td className="py-2 pr-2">{d(c.at)}</td>
                    <td className="py-2 pr-2 text-[#4b5563]">{c.reason}</td>
                    <td className="num py-2 text-right">{formatINR(c.totalPaise)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {t.balancePaise > 0 && v !== "cancelled" && (
          <div>
            <p className="mb-2 text-[13px] font-semibold text-[#121f2f]">{receipt ? `How to pay the balance of ${formatINR(t.balancePaise)}` : "How to pay"}</p>
            <HowToPay t={t} />
          </div>
        )}

        <div>
          <Label>Terms</Label>
          <ol className="list-decimal space-y-1 pl-4 text-[11px] leading-snug text-[#4b5563]">
            {t.terms.map((x, i) => (
              <li key={i}>{x}</li>
            ))}
          </ol>
        </div>
      </div>

      <div className="flex items-end justify-between gap-6">
        <p className="max-w-[55%] text-[11px] leading-snug text-[#6b7280]">
          Questions about this {receipt ? "receipt" : "invoice"}? Write to {t.seller.email}
          {t.seller.phone ? ` or call ${t.seller.phone}` : ""}.
        </p>
        {(receipt || v === "credited") && <Signature t={t} />}
      </div>
      <Footer t={t} page={2} />
    </section>
  );
}

function Document({ t }: { t: ServiceTaxInvoice }) {
  return (
    <div className="inv-doc">
      <PageOne t={t} />
      <PageTwo t={t} />
    </div>
  );
}

/** Printable two-page GST tax invoice. Browser "Save as PDF" gives a clean two-page A4 PDF. */
export function TaxInvoice({ t, actions }: { t: ServiceTaxInvoice; actions?: React.ReactNode }) {
  // true in the browser, false while rendering on the server (the print copy is added after hydration).
  const mounted = useSyncExternalStore(noop, () => true, () => false);
  return (
    <>
      <style>{PRINT_CSS}</style>
      <div className="no-print mb-4 flex flex-wrap items-center gap-3">
        <PrintButton />
        {actions}
        <span className="text-xs text-ink-muted">Two A4 pages. In the print window choose “Save as PDF”, and turn off “Headers and footers”.</span>
      </div>
      <div className="overflow-x-auto bg-[#eceef1] py-6" id="tax-invoice" data-testid="tax-invoice">
        <Document t={t} />
      </div>
      {/* The print copy lives directly under <body>, outside the app's menus, so only the invoice is printed. */}
      {mounted &&
        createPortal(
          <div className="inv-print-root" aria-hidden="true">
            <Document t={t} />
          </div>,
          document.body,
        )}
    </>
  );
}
