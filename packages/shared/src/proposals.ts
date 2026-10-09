import { z } from "zod";
import type { Tier } from "./catalogue.js";
import { GST_RATE } from "./money.js";
import type { SellApprovalStep, SellChangeRequest, SellPaymentPlan, SellVersion } from "./sell-flows.js";

export type BillingType = "monthly" | "one_time" | "per_unit";

export type PricedService = { key: string; name: string; billingType: BillingType | string; tiers: { tier: string; pricePaise: number }[] };
export type PricedAddOn = { id: string; name: string; pricePaise: number | null; isCustomQuote: boolean };
export type PricedBundle = { key: string; name: string; serviceKeys: string[]; discountPct: number };

export type ProposalLine = {
  kind: "service" | "addon";
  key: string;
  name: string;
  tier: Tier | null;
  billingType: string;
  unitPaise: number;
  qty: number;
  grossPaise: number;
  bundleDiscountPaise: number;
  extraDiscountPaise: number;
  netPaise: number;
  /** What the client pays now: retainers one month in advance, projects 50% on confirmation. */
  dueNowPaise: number;
};

export type ProposalPricing = {
  lines: ProposalLine[];
  bundle: PricedBundle | null;
  subtotalPaise: number;
  bundleDiscountPaise: number;
  extraDiscountPct: number;
  extraDiscountPaise: number;
  discountPaise: number;
  taxablePaise: number;
  gstPaise: number;
  totalPaise: number;
  firstPayment: { netPaise: number; gstPaise: number; totalPaise: number };
};

const gstOn = (paise: number) => Math.round(paise * GST_RATE);

/**
 * Prices a proposal from the active price book (catalogue_seed rules):
 * bundle saving on a complete bundle's services, then any extra discount on everything,
 * GST 18% shown separately, and the first payment per payment_terms.
 */
export function priceProposal(input: {
  services: PricedService[];
  addOns: PricedAddOn[];
  bundles: PricedBundle[];
  serviceLines: { serviceKey: string; tier: Tier }[];
  addOnLines: { addOnId: string; qty: number }[];
  extraDiscountPct: number;
}): ProposalPricing {
  const keys = input.serviceLines.map((l) => l.serviceKey);
  const bundle =
    [...input.bundles].sort((a, b) => b.serviceKeys.length - a.serviceKeys.length).find((b) => b.serviceKeys.every((k) => keys.includes(k))) ?? null;

  const lines: ProposalLine[] = [];
  for (const l of input.serviceLines) {
    const s = input.services.find((x) => x.key === l.serviceKey);
    const price = s?.tiers.find((t) => t.tier === l.tier)?.pricePaise;
    if (!s || price === undefined) throw new Error(`Unknown service or tier: ${l.serviceKey} ${l.tier}`);
    const bundleDiscountPaise = bundle?.serviceKeys.includes(s.key) ? Math.round((price * bundle.discountPct) / 100) : 0;
    lines.push({ kind: "service", key: s.key, name: s.name, tier: l.tier, billingType: s.billingType, unitPaise: price, qty: 1, grossPaise: price, bundleDiscountPaise, extraDiscountPaise: 0, netPaise: 0, dueNowPaise: 0 });
  }
  for (const l of input.addOnLines) {
    const a = input.addOns.find((x) => x.id === l.addOnId);
    if (!a || a.isCustomQuote || a.pricePaise === null) throw new Error("Add-on is custom-quote only");
    const gross = a.pricePaise * l.qty;
    lines.push({ kind: "addon", key: a.id, name: a.name, tier: null, billingType: "one_time", unitPaise: a.pricePaise, qty: l.qty, grossPaise: gross, bundleDiscountPaise: 0, extraDiscountPaise: 0, netPaise: 0, dueNowPaise: 0 });
  }

  for (const line of lines) {
    const afterBundle = line.grossPaise - line.bundleDiscountPaise;
    line.extraDiscountPaise = Math.round((afterBundle * input.extraDiscountPct) / 100);
    line.netPaise = afterBundle - line.extraDiscountPaise;
    line.dueNowPaise = line.billingType === "monthly" ? line.netPaise : Math.round(line.netPaise / 2);
  }

  const sum = (f: (l: ProposalLine) => number) => lines.reduce((s, l) => s + f(l), 0);
  const subtotalPaise = sum((l) => l.grossPaise);
  const bundleDiscountPaise = sum((l) => l.bundleDiscountPaise);
  const extraDiscountPaise = sum((l) => l.extraDiscountPaise);
  const taxablePaise = sum((l) => l.netPaise);
  const dueNow = sum((l) => l.dueNowPaise);

  return {
    lines,
    bundle,
    subtotalPaise,
    bundleDiscountPaise,
    extraDiscountPct: input.extraDiscountPct,
    extraDiscountPaise,
    discountPaise: bundleDiscountPaise + extraDiscountPaise,
    taxablePaise,
    gstPaise: gstOn(taxablePaise),
    totalPaise: taxablePaise + gstOn(taxablePaise),
    firstPayment: { netPaise: dueNow, gstPaise: gstOn(dueNow), totalPaise: dueNow + gstOn(dueNow) },
  };
}

export const createProposalSchema = z.object({
  leadId: z.string(),
  lines: z.array(z.object({ serviceKey: z.string(), tier: z.enum(["starter", "growth", "premium"]) })).min(1, "Add at least one service"),
  addOns: z.array(z.object({ addOnId: z.string(), qty: z.number().int().min(1).max(20) })).default([]),
  extraDiscountPct: z.number().int().min(0).max(50).default(0),
  validDays: z.number().int().min(1).max(60).default(14),
});
export type CreateProposal = z.infer<typeof createProposalSchema>;

export const acceptProposalSchema = z.object({
  signerName: z.string().trim().min(2, "Type your full name to sign"),
  signerEmail: z.email("Enter a valid email"),
  signerDesignation: z.string().trim().max(80).optional(),
  agree: z.literal(true, { error: "Tick the box to accept the terms" }),
});

export type ProposalStatus = "draft" | "sent" | "accepted" | "rejected" | "expired" | "superseded";

export type ProposalView = {
  id: string;
  status: ProposalStatus;
  publicToken: string;
  version: number;
  client: { name: string; company?: string; email?: string; phone?: string };
  lines: ProposalLine[];
  subtotalPaise: number;
  bundleDiscountPaise: number;
  extraDiscountPct: number;
  discountPaise: number;
  gstPaise: number;
  totalPaise: number;
  firstPayment: { netPaise: number; gstPaise: number; totalPaise: number };
  validUntil: string;
  discountNeedsApproval: boolean;
  discountApproved: boolean;
  sentAt: string | null;
  viewedAt: string | null;
  acceptedAt: string | null;
  createdAt: string;
  leadId: string;
  invoice: { id: string; number: string; status: string; totalPaise: number } | null;
  paid: boolean;
  // v10 sell
  kind?: "new" | "renewal";
  rootId?: string | null;
  supersededById?: string | null;
  changeNote?: string | null;
  viewCount?: number;
  lastViewedAt?: string | null;
  discountStatus?: "none" | "pending" | "approved" | "rejected";
  paymentPlan?: SellPaymentPlan;
  /** Staff view only: version history, change requests, approval steps, signature. */
  versions?: SellVersion[];
  changeRequests?: SellChangeRequest[];
  approvalSteps?: SellApprovalStep[];
  signer?: { name: string; email: string; designation?: string; ip?: string; at: string } | null;
  latestToken?: string | null;
  owner?: { id: string; name: string } | null;
};

/** Indian financial year label, e.g. 2026-27 for dates from April 2026 to March 2027. */
export function financialYear(d: Date): string {
  const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  return `${y}-${String((y + 1) % 100).padStart(2, "0")}`;
}
