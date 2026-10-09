import { formatINR, sellPaymentPlan, type ProposalLine } from "@bmu/shared";

type Totals = {
  lines: ProposalLine[];
  subtotalPaise: number;
  bundleDiscountPaise: number;
  extraDiscountPct: number;
  discountPaise: number;
  gstPaise: number;
  totalPaise: number;
  firstPayment: { netPaise: number; gstPaise: number; totalPaise: number };
};

const billing = (b: string) => (b === "monthly" ? "per month" : "one time");

/** Line items and totals, shared by the builder, the team view and the client's proposal link. */
export function ProposalSummary({ p, bundleName }: { p: Totals; bundleName?: string | null }) {
  const extra = p.discountPaise - p.bundleDiscountPaise;
  return (
    <div>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-ink-muted">
            <th className="py-2 font-normal">Item</th>
            <th className="py-2 text-right font-normal">Price</th>
            <th className="py-2 text-right font-normal">You pay</th>
          </tr>
        </thead>
        <tbody>
          {p.lines.map((l) => (
            <tr key={`${l.kind}-${l.key}`} className="border-b border-border">
              <td className="py-2">
                {l.name}
                {l.qty > 1 && ` × ${l.qty}`}
                <span className="block text-xs capitalize text-ink-muted">
                  {l.tier ? `${l.tier} · ` : ""}
                  {billing(l.billingType)}
                </span>
              </td>
              <td className="py-2 text-right">{formatINR(l.grossPaise)}</td>
              <td className="py-2 text-right">{formatINR(l.netPaise)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <dl className="mt-3 space-y-1 text-sm">
        <Row label="Subtotal" value={formatINR(p.subtotalPaise)} />
        {p.bundleDiscountPaise > 0 && <Row label={`Bundle saving${bundleName ? ` (${bundleName})` : ""}`} value={`−${formatINR(p.bundleDiscountPaise)}`} />}
        {extra > 0 && <Row label={`Special discount (${p.extraDiscountPct}%)`} value={`−${formatINR(extra)}`} />}
        <Row label="GST (18%)" value={formatINR(p.gstPaise)} />
        <Row label="Total (monthly services counted once)" value={formatINR(p.totalPaise)} strong />
      </dl>
      <div className="mt-4 bg-charcoal p-4 text-ivory">
        <p className="text-sm text-grey">Due now to start</p>
        <p className="font-display text-2xl" data-testid="due-now">{formatINR(p.firstPayment.totalPaise)}</p>
        <p className="text-xs text-grey">
          {formatINR(p.firstPayment.netPaise)} + {formatINR(p.firstPayment.gstPaise)} GST. Retainers are billed monthly in advance; projects 50% now and 50% before handover.
        </p>
      </div>
      <PaymentPlan lines={p.lines} />
    </div>
  );
}

/** The payment schedule: what is paid now, and what comes later (project balance, monthly retainer). */
export function PaymentPlan({ lines }: { lines: ProposalLine[] }) {
  const plan = sellPaymentPlan(lines);
  if (!plan.later.length) return null;
  return (
    <div className="mt-3 border border-border p-4 text-sm" aria-label="Payment plan">
      <p className="mb-2 font-semibold">Payment plan</p>
      <ul className="space-y-2">
        <li className="flex justify-between gap-3">
          <span>
            {plan.now.label}
            <span className="block text-xs text-ink-muted">{plan.now.when}</span>
          </span>
          <span className="text-right">{formatINR(plan.now.totalPaise)}</span>
        </li>
        {plan.later.map((x) => (
          <li key={x.label} className="flex justify-between gap-3">
            <span>
              {x.label}
              <span className="block text-xs text-ink-muted">{x.when}</span>
            </span>
            <span className="text-right">
              {formatINR(x.totalPaise)}
              <span className="block text-xs text-ink-muted">incl. GST</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex justify-between gap-3 ${strong ? "font-semibold" : ""}`}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
