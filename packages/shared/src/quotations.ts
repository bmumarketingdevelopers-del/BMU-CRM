// v45 quotations: the Client Manager makes a quotation for a client (from a template per service, then edited), sends
// it, and the client accepts it in the app; the advance invoice is then created on its own, and the CM raises the
// balance invoice later. The document follows BMU's quotation design (cost breakdown, scope, timeline, terms).
import { z } from "zod";

export const QUOTE_STATUSES = ["draft", "sent", "accepted", "declined", "cancelled"] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number] | "expired";
export const quoteStatusLabels: Record<QuoteStatus, { team: string; client: string }> = {
  draft: { team: "Draft", client: "Draft" },
  sent: { team: "Waiting for the client", client: "Waiting for you" },
  accepted: { team: "Accepted", client: "Accepted" },
  declined: { team: "Declined", client: "Declined" },
  cancelled: { team: "Cancelled", client: "Cancelled" },
  expired: { team: "Expired", client: "Expired" },
};

const text = (max: number) => z.string().trim().max(max);
/** A cost line: quantity × rate, or a percentage of the quantity × rate lines (e.g. "15% on fees"). */
export const quoteLineSchema = z.object({
  title: text(160).min(1, "Name each line"),
  details: text(600).optional().default(""),
  kind: z.enum(["unit", "percent"]).default("unit"),
  qty: z.number().min(0).max(100000).default(1),
  /** Rate in paise (unit lines). */
  unitPricePaise: z.number().int().min(0).max(10_000_000_000).default(0),
  /** Percentage of the unit lines (percent lines). */
  pct: z.number().min(0).max(100).default(0),
});
export type QuoteLine = z.infer<typeof quoteLineSchema>;

/** What a template and a quotation share: the project wording, the cost lines and pages 2 and 3. */
export const quoteContentSchema = z.object({
  title: text(160).min(2, "Name the project, e.g. Bengaluru Influencer Campaign"),
  /** Up to three lines under the project name, e.g. "6 micro-influencers". */
  projectLines: z.array(text(120)).max(3).default([]),
  /** Up to three highlights beside the total, e.g. { value: "4 wks", label: "Campaign" }. */
  stats: z.array(z.object({ value: text(24).min(1), label: text(40).min(1) })).max(3).default([]),
  lines: z.array(quoteLineSchema).min(1, "Add at least one cost line").max(30),
  scope: z.array(z.object({ title: text(80).min(1), bullets: z.array(text(240)).max(10).default([]) })).max(6).default([]),
  timeline: z.array(z.object({ label: text(24).min(1), title: text(60).min(1), text: text(240).default("") })).max(8).default([]),
  terms: z.array(z.object({ title: text(60).min(1), text: text(600).min(1) })).max(12).default([]),
  /** Advance invoiced when the client accepts (the rest is the balance invoice). */
  advancePct: z.number().int().min(0).max(100).default(50),
  footerLine: text(160).optional().default(""),
});
export type QuoteContent = z.infer<typeof quoteContentSchema>;
export type QuoteContentInput = z.input<typeof quoteContentSchema>;

export const quoteTemplateSchema = quoteContentSchema.extend({
  name: text(80).min(2, "Name the template"),
  /** The service it is for (catalogue key), or none. */
  serviceKey: text(60).optional().nullable(),
});
export type QuoteTemplateInput = z.input<typeof quoteTemplateSchema>;

export const quoteSaveSchema = quoteContentSchema.extend({
  clientOrgId: z.string().min(1, "Pick the client"),
  engagementId: z.string().optional().nullable(),
  templateId: z.string().optional().nullable(),
  /** "Prepared for" lines under the client's name, e.g. "Real Estate Developer", "Bengaluru, Karnataka". */
  preparedFor: z.array(text(120)).max(3).default([]),
  validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick the date it is valid until"),
});
export type QuoteSaveInput = z.input<typeof quoteSaveSchema>;

export const quoteDecisionSchema = z
  .object({ decision: z.enum(["accept", "decline"]), name: text(120).optional(), reason: text(1000).optional() })
  .refine((d) => d.decision === "decline" || (d.name ?? "").length >= 2, { message: "Type your name to accept", path: ["name"] });
export type QuoteDecisionInput = z.input<typeof quoteDecisionSchema>;

/** Each line's amount: quantity × rate, or the percentage of the quantity × rate lines. */
export function quoteLineAmounts(lines: Pick<QuoteLine, "kind" | "qty" | "unitPricePaise" | "pct">[]) {
  const base = lines.filter((l) => l.kind !== "percent").reduce((s, l) => s + Math.round((l.qty || 0) * (l.unitPricePaise || 0)), 0);
  return lines.map((l) => (l.kind === "percent" ? Math.round((base * (l.pct || 0)) / 100) : Math.round((l.qty || 0) * (l.unitPricePaise || 0))));
}

export function quoteTotals(lines: Pick<QuoteLine, "kind" | "qty" | "unitPricePaise" | "pct">[], gstRatePct: number) {
  const amounts = quoteLineAmounts(lines);
  const subtotalPaise = amounts.reduce((s, a) => s + a, 0);
  const gstPaise = Math.round((subtotalPaise * gstRatePct) / 100);
  return { amounts, subtotalPaise, gstPaise, totalPaise: subtotalPaise + gstPaise };
}

export type QuoteView = {
  id: string;
  number: string;
  status: QuoteStatus;
  date: string;
  validUntil: string;
  seller: { name: string; addressLines: string[]; website: string; gstin: string | null; signatory: string };
  client: { id: string; name: string; preparedFor: string[] };
  engagementId: string | null;
  templateId: string | null;
  content: QuoteContent;
  amounts: number[];
  subtotalPaise: number;
  gstRatePct: number;
  gstPaise: number;
  totalPaise: number;
  amountInWords: string;
  payment: { accountName: string | null; accountNumber: string | null; ifsc: string | null; swift: string | null; bank: string | null; upiId: string | null; upiUri: string | null };
  acceptedAt: string | null;
  acceptedName: string | null;
  declinedAt: string | null;
  declineReason: string | null;
  advanceInvoice: { id: string; number: string; status: string; totalPaise: number } | null;
  balanceInvoice: { id: string; number: string; status: string; totalPaise: number } | null;
  createdBy: string | null;
  can: { edit: boolean; send: boolean; cancel: boolean; raiseBalance: boolean; decide: boolean };
};

export type QuoteRow = { id: string; number: string; title: string; client: { id: string; name: string }; status: QuoteStatus; totalPaise: number; date: string; validUntil: string; createdBy: string | null };
export type QuoteTemplateRow = QuoteContent & { id: string; name: string; serviceKey: string | null; updatedAt: string };
/** The document part of a template (to start a quotation from it). */
export const quoteTemplateContent = (t: QuoteTemplateRow): QuoteContent => ({
  title: t.title,
  projectLines: t.projectLines,
  stats: t.stats,
  lines: t.lines,
  scope: t.scope,
  timeline: t.timeline,
  terms: t.terms,
  advancePct: t.advancePct,
  footerLine: t.footerLine,
});

/** The starting template (from BMU's influencer-campaign quotation). */
export const DEFAULT_QUOTE_TEMPLATE: QuoteTemplateInput = {
  name: "Influencer Campaign",
  serviceKey: null,
  title: "Bengaluru Influencer Campaign",
  projectLines: ["6 micro-influencers", "10K–50K followers each"],
  stats: [
    { value: "6", label: "Influencers" },
    { value: "10K–50K", label: "Followers each" },
    { value: "4 wks", label: "Campaign" },
  ],
  lines: [
    { title: "Influencer fees", details: "Bengaluru-based micro-influencers (10K–50K followers). Per influencer: 1 Reel + 3 Stories, collab post with brand handle.", kind: "unit", qty: 6, unitPricePaise: 1_000_000, pct: 0 },
    { title: "Campaign management", details: "Influencer research and shortlisting, negotiation, briefing, site-visit coordination, content approval, posting schedule and reporting.", kind: "percent", qty: 0, unitPricePaise: 0, pct: 15 },
  ],
  scope: [
    { title: "Influencer profile", bullets: ["Based in Bengaluru, with a mostly local audience", "10K–50K Instagram followers", "Niches: lifestyle, family, home décor, finance and local Bengaluru content", "Engagement checked; fake-follower audit before shortlisting"] },
    { title: "Deliverables per influencer", bullets: ["1 Instagram Reel (30–60 sec) shot at the project site", "3 Instagram Stories with link sticker or enquiry CTA", "Collab post with the client's Instagram handle", "30 days usage rights for the client to repost and boost"] },
    { title: "Content ideas", bullets: ['"Come house-hunting with me" site walkthrough', "Amenities tour: clubhouse, pool, kids' area", '"What ₹X gets you in Bengaluru" price reveal', "Commute check: distance to IT hubs and metro"] },
    { title: "Campaign reach (estimated)", bullets: ["Combined follower base: 60K–3 lakh", "6 Reels and 18 Stories across Bengaluru audiences", "Final reach depends on influencer mix and content performance"] },
  ],
  timeline: [
    { label: "Week 1", title: "Shortlist & approve", text: "We share 10 profiles; client approves 6." },
    { label: "Week 2", title: "Brief & site visits", text: "Influencers visit the site and shoot content." },
    { label: "Week 3", title: "Approve & publish", text: "Client approves content; posts go live on schedule." },
    { label: "Week 4", title: "Report", text: "Reach, views, engagement and enquiries report." },
  ],
  terms: [
    { title: "Payment", text: "50% advance on confirmation. Remaining 50% before content goes live." },
    { title: "Validity", text: "This quotation is valid for 15 days from the date of issue." },
    { title: "Travel", text: "Influencer travel to the site within Bengaluru is included. Outstation travel is billed separately." },
    { title: "Approvals", text: "One round of revisions per Reel. Client feedback within 48 hours keeps the schedule on track." },
    { title: "Paid boosting", text: "Ad spend to boost influencer content is not included and can be quoted separately." },
    { title: "Replacements", text: "If an approved influencer drops out, we replace them with a similar profile at no extra cost." },
    { title: "Results", text: "Reach and engagement figures are estimates. Organic performance can't be guaranteed." },
    { title: "Compliance", text: "All posts carry a paid partnership or #ad tag as per ASCI guidelines. RERA number shown where required." },
  ],
  advancePct: 50,
  footerLine: "Let's put your project in front of Bengaluru's home buyers.",
};
