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
  /** v47: the sub-service this line came from, so unticking its service takes it away again. A plan line uses `plan:<service id>`. */
  subServiceId: z.string().optional(),
  /** v52 shared form: the item's service (group, or "Bundle") and billing; the GST rate it was saved with. */
  service: text(120).optional(),
  billing: z.enum(["", "monthly", "one_time", "per_unit"]).optional(),
  gstRatePct: z.number().int().min(0).max(28).optional(),
  /** Invoices: "service" carries GST; ad spend, creator fees and other pass-through costs are billed at cost, no GST. */
  costKind: z.enum(["service", "ad_spend", "creator_fee", "other_pass_through"]).optional(),
});
/** A pass-through item (ad spend, creator fee…) is billed at cost with no GST. */
export const isPassThroughLine = (l: { costKind?: string }) => !!l.costKind && l.costKind !== "service";
/** v52: one GST rate for the whole document; 0 = no GST. */
export const QUOTE_GST_RATES = [5, 12, 18, 28] as const;
export const docGstRateSchema = z.union([z.literal(0), z.literal(5), z.literal(12), z.literal(18), z.literal(28)]);
export const itemBillingLabels: Record<string, string> = { "": "Not stated", monthly: "Monthly", one_time: "One-time project", per_unit: "Per unit" };
export type QuoteLine = z.infer<typeof quoteLineSchema>;

export const QUOTE_OVERVIEW_MAX = 400;
const ymd = /^\d{4}-\d{2}-\d{2}$/;
/** "Bill to" on one quotation: filled from the client's billing details, changed here for this document only. */
export const quoteBillToSchema = z.object({
  name: text(200).default(""),
  gstin: text(15).default(""),
  /** GST state code, e.g. "29" for Karnataka. */
  placeOfSupply: text(2).default(""),
  address: text(600).default(""),
});
export type QuoteBillTo = z.infer<typeof quoteBillToSchema>;
/** Left empty, "valid until" is this many days after the quotation date. */
export const QUOTE_DEFAULT_VALID_DAYS = 30;
/** What a template and a quotation share: the project wording, the cost lines and pages 2 and 3. */
export const quoteContentSchema = z.object({
  title: text(160).min(2, "Name the project, e.g. Bengaluru Influencer Campaign"),
  /** Up to three lines under the project name, e.g. "6 micro-influencers". */
  projectLines: z.array(text(120)).max(3).default([]),
  /** Up to three highlights beside the total, e.g. { value: "4 wks", label: "Campaign" }. */
  stats: z.array(z.object({ value: text(24).min(1), label: text(40).min(1) })).max(3).default([]),
  lines: z.array(quoteLineSchema).min(1, "Add at least one cost line").max(100, "Up to 100 items"),
  scope: z.array(z.object({ title: text(80).min(1), bullets: z.array(text(240)).max(10).default([]) })).max(6).default([]),
  timeline: z.array(z.object({ label: text(24).min(1), title: text(60).min(1), text: text(240).default("") })).max(8).default([]),
  terms: z.array(z.object({ title: text(60).min(1), text: text(600).min(1) })).max(12).default([]),
  /** v49: about two lines on page 1 on what BMU will do for the client (written by AI or by the manager). */
  overview: text(QUOTE_OVERVIEW_MAX).optional().default(""),
  /** v49: printed under the project name. */
  planType: z.enum(["", "one_time", "monthly", "mixed"]).optional(),
  /** Advance invoiced first (the rest is the balance invoice). */
  advancePct: z.number().int().min(0).max(100).default(50),
  footerLine: text(160).optional().default(""),
  /** The date printed on the quotation (YYYY-MM-DD); older quotations use the day they were sent. */
  quoteDate: z.string().regex(ymd, "Pick the quotation date").optional(),
  billTo: quoteBillToSchema.optional(),
  /** "mine": signed with the sender's signature; "blank": the line is left to sign by hand. */
  signWith: z.enum(["mine", "blank"]).optional().default("mine"),
  /** Add the company seal under the signature. */
  seal: z.boolean().optional().default(true),
  /** Printed on the document above the terms. */
  notes: text(1000).optional().default(""),
  /** v52: one GST rate for every item (0 = no GST); missing = the GST setting. */
  gstRatePct: docGstRateSchema.optional(),
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
  /** v46: the client's services this quotation is for (any number, or none). */
  engagementIds: z.array(z.string().min(1)).max(20).default([]),
  templateId: z.string().optional().nullable(),
  /** "Prepared for" lines under the client's name, e.g. "Real Estate Developer", "Bengaluru, Karnataka". */
  preparedFor: z.array(text(120)).max(3).default([]),
  /** Empty: QUOTE_DEFAULT_VALID_DAYS after the quotation date. */
  validUntil: z.union([z.literal(""), z.string().regex(ymd, "Pick the date it is valid until")]).optional().default(""),
});
export type QuoteSaveInput = z.input<typeof quoteSaveSchema>;

/**
 * v49: accepting needs the client's name and either their signature (and seal, if they have one) or the signed copy.
 * "changes" sends the quotation back to the manager with what to change.
 */
export const quoteDecisionSchema = z
  .object({
    decision: z.enum(["accept", "decline", "changes"]),
    name: text(120).optional(),
    reason: text(1000).optional(),
    signatureFileId: z.string().optional(),
    sealFileId: z.string().optional(),
    signedCopyFileId: z.string().optional(),
  })
  .refine((d) => d.decision !== "accept" || (d.name ?? "").length >= 2, { message: "Type your name to accept", path: ["name"] })
  .refine((d) => d.decision !== "accept" || !!d.signatureFileId || !!d.signedCopyFileId, { message: "Add your signature, or upload the signed quotation", path: ["signatureFileId"] })
  .refine((d) => d.decision !== "changes" || (d.reason ?? "").length >= 3, { message: "Say what should change", path: ["reason"] });
export type QuoteDecisionInput = z.input<typeof quoteDecisionSchema>;

export const QUOTE_ACCEPT_FILE_KINDS = ["signature", "seal", "signed_copy"] as const;
/** v49: asks AI for the project overview from the project and its cost lines. */
export const quoteOverviewSchema = z.object({ clientOrgId: z.string().optional(), title: text(160).optional().default(""), lines: z.array(z.object({ title: text(160), details: text(600).optional().default("") })).max(30).default([]) });
export type QuoteOverviewInput = z.input<typeof quoteOverviewSchema>;

export type QuoteAcceptFileKind = (typeof QUOTE_ACCEPT_FILE_KINDS)[number];
/** The signed copy goes through the normal upload request, which Vercel limits to 4.5 MB. */
export const QUOTE_SIGNED_COPY_MAX_BYTES = 4 * 1024 * 1024;

/** v49: the client tells the team they have paid; the team confirms it when sending the invoice. */
export const quotePaidSchema = z.object({ amountPaise: z.number().int().positive("Enter the amount paid").max(2_000_000_000), reference: text(120).min(3, "Add the payment reference (UTR, cheque number…)") });
export type QuotePaidInput = z.input<typeof quotePaidSchema>;
export type QuotePaymentNote = { amountPaise: number; reference: string; at: string; by: string };

export type QuotePlan = NonNullable<QuoteContent["planType"]>;
export const quotePlanLabels: Record<Exclude<QuotePlan, "">, string> = { one_time: "One-time project", monthly: "Monthly project", mixed: "Monthly and one-time project" };

/** Each line's amount: quantity × rate, or the percentage of the quantity × rate lines. */
export function quoteLineAmounts(lines: Pick<QuoteLine, "kind" | "qty" | "unitPricePaise" | "pct">[]) {
  const base = lines.filter((l) => l.kind !== "percent").reduce((s, l) => s + Math.round((l.qty || 0) * (l.unitPricePaise || 0)), 0);
  return lines.map((l) => (l.kind === "percent" ? Math.round((base * (l.pct || 0)) / 100) : Math.round((l.qty || 0) * (l.unitPricePaise || 0))));
}

export function quoteTotals(lines: (Pick<QuoteLine, "kind" | "qty" | "unitPricePaise" | "pct"> & { costKind?: string })[], gstRatePct: number) {
  const amounts = quoteLineAmounts(lines);
  const subtotalPaise = amounts.reduce((s, a) => s + a, 0);
  // v52: tax per item, round(taxable × rate / 100), then added up; pass-through items (at cost) carry no GST.
  const gstPaise = amounts.reduce((s, a, i) => s + (isPassThroughLine(lines[i]) ? 0 : Math.round((a * gstRatePct) / 100)), 0);
  const passThroughPaise = amounts.reduce((s, a, i) => s + (isPassThroughLine(lines[i]) ? a : 0), 0);
  return { amounts, subtotalPaise, taxablePaise: subtotalPaise - passThroughPaise, passThroughPaise, gstPaise, totalPaise: subtotalPaise + gstPaise };
}

/** v52: the terms line that follows the "Valid until" field, e.g. "This quotation is valid until 17 December 2026." */
export const quoteValidUntilText = (ymdDate: string) => `This quotation is valid until ${new Date(`${ymdDate}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })}.`;
export const QUOTE_VALID_UNTIL_RE = /^This quotation is valid until .+\.$/;
/** BMU's standard terms with the valid-until line for this date. */
export const quoteDefaultTerms = (validUntil: string) => [...QUOTE_FIXED_TERMS, { title: String(QUOTE_FIXED_TERMS.length + 1), text: quoteValidUntilText(validUntil) }];
/** Moves the automatic valid-until line to a new date (a line the manager rewrote by hand is left alone). */
export function quoteTermsWithValidUntil(terms: { title: string; text: string }[], validUntil: string) {
  return terms.map((t) => (QUOTE_VALID_UNTIL_RE.test(t.text.trim()) ? { ...t, text: quoteValidUntilText(validUntil) } : t));
}

/**
 * v52: the project overview, written by rules (not AI) from the client and items, e.g. "BMU Marketing is pleased to submit
 * this quotation for the monthly marketing of Akhil Productions. We propose two Growth packages, built for steady,
 * consistent growth across the channel: SEO and Social Media Management. Akhil Productions may take either package, or
 * both together for a complete online presence." At most 400 characters.
 */
export function quoteOverviewText(input: { company: string; client: string; kind: "quotation" | "invoice"; lines: Pick<QuoteLine, "title" | "billing">[] }): string {
  const items = input.lines.filter((l) => l.title.trim());
  if (!items.length || !input.client.trim()) return "";
  const plans = [...new Set(items.map((l) => /\((Starter|Growth|Premium) plan\)/.exec(l.title)?.[1]).filter(Boolean))] as string[];
  const names = [...new Set(items.map((l) => l.title.replace(/\s*\((Starter|Growth|Premium) plan\)\s*$/, "").trim()))];
  const monthly = items.every((l) => l.billing === "monthly");
  const words = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
  const count = names.length <= 10 ? words[names.length] : String(names.length);
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  const what = monthly ? "the monthly marketing" : "the project work";
  const pkg = plans.length === 1 ? `${plans[0]} package${names.length > 1 ? "s" : ""}` : `package${names.length > 1 ? "s" : ""}`;
  const verb = input.kind === "invoice" ? "This invoice covers" : `${input.company} is pleased to submit this quotation for`;
  const lead = `${verb} ${what} of ${input.client}.`;
  const body = names.length === 1 ? `We propose one ${pkg}: ${list}.` : `We propose ${count} ${pkg}, built for steady, consistent growth across the channel: ${list}.`;
  const close = input.kind === "quotation" && names.length > 1 ? ` ${input.client} may take either package, or both together for a complete online presence.` : "";
  const text = `${lead} ${body}${close}`;
  return text.length <= QUOTE_OVERVIEW_MAX ? text : `${lead} ${body}`.slice(0, QUOTE_OVERVIEW_MAX);
}

/**
 * Same rule as tax invoices: inside the seller's state the GST is split into CGST and SGST (half each); anywhere else it is IGST.
 * No place of supply: the client's GSTIN state, else the seller's own state.
 */
export function quoteGstSplit(gstPaise: number, sellerStateCode: string, placeOfSupply?: string | null, clientGstin?: string | null) {
  const pos = placeOfSupply || (clientGstin && /^\d{2}/.test(clientGstin) ? clientGstin.slice(0, 2) : "") || sellerStateCode;
  const interState = pos !== sellerStateCode;
  const cgstPaise = interState ? 0 : Math.round(gstPaise / 2);
  return { placeOfSupply: pos, interState, cgstPaise, sgstPaise: interState ? 0 : gstPaise - cgstPaise, igstPaise: interState ? gstPaise : 0 };
}

/** "Valid until" when left empty: QUOTE_DEFAULT_VALID_DAYS after the quotation date. */
export const quoteDefaultValidUntil = (quoteDate: string) => new Date(Date.parse(`${quoteDate}T00:00:00Z`) + QUOTE_DEFAULT_VALID_DAYS * 86_400_000).toISOString().slice(0, 10);

export type QuoteView = {
  id: string;
  number: string;
  status: QuoteStatus;
  date: string;
  validUntil: string;
  seller: { name: string; addressLines: string[]; website: string; gstin: string | null; signatory: string };
  /** v48: company, owner, email and address come from the client's record (kept as they were when it was sent). */
  client: { id: string; name: string; preparedFor: string[] } & QuoteClientDetails;
  /** v49: who signs for BMU: the person who sent it, with their signature and the company seal. */
  signer: { name: string; role: string; signatureUrl: string | null; sealUrl: string | null };
  /** v49: what the client added when accepting. */
  acceptance: { signatureUrl: string | null; sealUrl: string | null; signedCopyUrl: string | null };
  /** v49: what the client asked to change (cleared when it is sent again). */
  changeRequest: string | null;
  paymentNotes: QuotePaymentNote[];
  engagementIds: string[];
  /** v46: names of those services, printed under the project. */
  services: string[];
  templateId: string | null;
  content: QuoteContent;
  amounts: number[];
  subtotalPaise: number;
  gstRatePct: number;
  gstPaise: number;
  /** CGST + SGST inside the seller's state, IGST elsewhere (from the place of supply). */
  tax: { placeOfSupplyName: string | null; interState: boolean; cgstPaise: number; sgstPaise: number; igstPaise: number };
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
  can: { edit: boolean; send: boolean; cancel: boolean; raiseAdvance: boolean; raiseBalance: boolean; confirmPayment: boolean; decide: boolean; notifyPaid: boolean };
};

export type QuoteRow = { id: string; number: string; title: string; client: { id: string; name: string }; status: QuoteStatus; totalPaise: number; date: string; validUntil: string; createdBy: string | null };
export type QuoteTemplateRow = QuoteContent & { id: string; name: string; serviceKey: string | null; updatedAt: string };
/** The document part of a template (to start a quotation from it). */
export const quoteTemplateContent = (t: QuoteTemplateRow): QuoteContent => ({
  title: t.title,
  overview: t.overview ?? "",
  projectLines: t.projectLines,
  stats: t.stats,
  lines: t.lines,
  scope: t.scope,
  timeline: t.timeline,
  terms: t.terms,
  advancePct: t.advancePct,
  footerLine: t.footerLine,
  signWith: "mine",
  seal: true,
  notes: "",
});

/** v46: BMU's terms & conditions: fixed, added to every quotation by the server, and not editable. */
export const QUOTE_FIXED_TERMS: { title: string; text: string }[] = [
  { title: "1", text: "Prices are quoted in Indian Rupees per month. GST and any applicable taxes will be charged additionally as per prevailing law." },
  { title: "2", text: "The monthly fee is payable in advance. Work for a month begins only after that month's payment is received." },
  { title: "3", text: "Deliverables are per month and do not carry forward if unused. Content is shared for approval according to the monthly calendar." },
  { title: "4", text: "Further revisions and work outside the scope of the selected package(s) will be quoted separately." },
  { title: "5", text: "The client will provide brand assets, product details, product samples and timely approvals, and will give BMU Marketing access to the social media accounts and the Google Business Profile. Delays may affect the posting schedule." },
  { title: "6", text: "Local SEO and engagement activities improve visibility, but specific rankings, reach or sales results are not guaranteed." },
  { title: "7", text: "Paid advertising budgets, ad spends and third-party tool costs are not included and are borne by the client." },
  { title: "8", text: "Either party may end this engagement with 30 days' written notice." },
];

export type QuoteTerm = { title: string; text: string };
/** Same wording, ignoring spaces and case; two automatic valid-until lines count as the same whatever their dates. */
const sameText = (a?: string, b?: string) =>
  (QUOTE_VALID_UNTIL_RE.test((a ?? "").trim()) && QUOTE_VALID_UNTIL_RE.test((b ?? "").trim())) || (a ?? "").replace(/\s+/g, " ").trim().toLowerCase() === (b ?? "").replace(/\s+/g, " ").trim().toLowerCase();

/** One term per line, numbered 1, 2, 3… ("1. " at the start of a line is dropped). At most 12, as the schema allows. */
export const quoteTermsFromText = (text: string): QuoteTerm[] =>
  text
    .split("\n")
    .map((l) => l.replace(/^\s*\d+[.)]\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 12)
    .map((t, i) => ({ title: String(i + 1), text: t.slice(0, 600) }));
export const quoteTermsToText = (terms: QuoteTerm[]) => terms.map((t, i) => `${i + 1}. ${t.text}`).join("\n");

/** Which terms differ from BMU's standard terms, by number: changed, added (past the end) and removed. */
export function quoteTermsChanges(terms: QuoteTerm[], standard: QuoteTerm[] = quoteDefaultTerms("2000-01-01")) {
  const changed: number[] = [];
  terms.forEach((t, i) => i < standard.length && !sameText(t.text, standard[i].text) && changed.push(i + 1));
  const added = terms.slice(standard.length).map((_, i) => standard.length + i + 1);
  const removed = standard.slice(terms.length).map((_, i) => terms.length + i + 1);
  return { changed, added, removed, any: changed.length + added.length + removed.length > 0 };
}

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
  terms: QUOTE_FIXED_TERMS,
  advancePct: 50,
  footerLine: "Let's put your project in front of Bengaluru's home buyers.",
};

/** Older sent quotations have no GSTIN or place of supply stamped. */
export type QuoteClientDetails = { company: string; owner: string | null; email: string | null; address: string | null; gstin?: string | null; placeOfSupply?: string | null };

/**
 * v47: a service ticked on a quotation, with its sub-services. A price-book service (Starter / Growth / Premium) also
 * carries its plan: today's price from the active price book and the catalogue note.
 */
export type QuoteServicePick = { id?: string; name: string; billingType?: string; subServices: { id: string; name: string; covers: string }[]; plan?: { tier: string; pricePaise: number; note: string | null } };
export const quoteServicesTitle = (picks: QuoteServicePick[]) => picks.map((p) => p.name).join(", ").slice(0, 160);

const planLineKey = (id: string) => `plan:${id}`;
const tierName = (tier: string) => tier.charAt(0).toUpperCase() + tier.slice(1);

/**
 * v47: the project name becomes the ticked service names (unless the manager typed their own), and the cost lines start
 * with the ticked sub-services and what they cover, ready to edit and price. Lines already there keep their edits.
 * A ticked plan service starts one line at its plan price.
 */
export function applyQuoteServices<C extends { title: string; lines: QuoteLine[]; planType?: QuotePlan }>(c: C, picks: QuoteServicePick[], autoTitles: string[] = []): C {
  const subs = picks.flatMap((p) => p.subServices);
  const plans = picks.flatMap((p) => (p.plan && p.id && !p.subServices.length ? [{ key: planLineKey(p.id), name: p.name, ...p.plan }] : []));
  const ids = new Set([...subs.map((s) => s.id), ...plans.map((p) => p.key)]);
  const kept = c.lines.filter((l) => !l.subServiceId || ids.has(l.subServiceId));
  const fromPlans = plans.map((p) => kept.find((l) => l.subServiceId === p.key) ?? { title: `${p.name} (${tierName(p.tier)} plan)`.slice(0, 160), details: (p.note ?? "").slice(0, 600), kind: "unit" as const, qty: 1, unitPricePaise: p.pricePaise, pct: 0, subServiceId: p.key });
  const fromSubs = [...fromPlans, ...subs.map((s) => kept.find((l) => l.subServiceId === s.id) ?? { title: s.name.slice(0, 160), details: s.covers.slice(0, 600), kind: "unit" as const, qty: 1, unitPricePaise: 0, pct: 0, subServiceId: s.id })];
  const others = kept.filter((l) => !l.subServiceId && (l.title.trim() || l.details.trim() || l.unitPricePaise || l.pct));
  const lines = [...fromSubs, ...others].slice(0, 30);
  const title = !c.title.trim() || autoTitles.includes(c.title) ? quoteServicesTitle(picks) : c.title;
  const kinds = new Set(picks.map((p) => p.billingType).filter(Boolean));
  const planType: QuotePlan | undefined = !kinds.size ? c.planType : kinds.size > 1 ? "mixed" : kinds.has("monthly") ? "monthly" : "one_time";
  return { ...c, title, planType, lines: lines.length ? lines : [{ title: "", details: "", kind: "unit", qty: 1, unitPricePaise: 0, pct: 0 }] };
}

// ---------------------------------------------------------------------------------------------------------------- v52 invoices
/** Left empty, the due date is this many days after the invoice date. */
export const INVOICE_DEFAULT_DUE_DAYS = 15;
/** The invoice side of the shared quotation / invoice form (save_invoice). */
export const invoiceDocSaveSchema = z.object({
  clientOrgId: z.string().min(1, "Pick the client"),
  /** The client's project (optional). */
  engagementId: z.string().optional().nullable(),
  invoiceDate: z.string().regex(ymd, "Pick the invoice date"),
  dueDate: z.union([z.literal(""), z.string().regex(ymd, "Pick the due date")]).optional().default(""),
  overview: text(QUOTE_OVERVIEW_MAX).optional().default(""),
  billTo: quoteBillToSchema.optional(),
  lines: z.array(quoteLineSchema).min(1, "Add at least one item").max(100, "Up to 100 items"),
  gstRatePct: docGstRateSchema.default(18),
  signWith: z.enum(["mine", "blank"]).default("mine"),
  seal: z.boolean().default(true),
  notes: text(1000).optional().default(""),
  terms: z.array(z.object({ title: text(60).min(1), text: text(600).min(1) })).max(12).default([]),
});
export type InvoiceDocSaveInput = z.input<typeof invoiceDocSaveSchema>;
export type InvoiceDocView = {
  id: string;
  number: string;
  status: string;
  client: { id: string; name: string } | null;
  engagementId: string | null;
  invoiceDate: string;
  dueDate: string;
  overview: string;
  billTo: QuoteBillTo;
  lines: QuoteLine[];
  gstRatePct: number;
  /** Older items had different GST rates; saving applies this one to all of them. */
  mixedRates: boolean;
  signWith: "mine" | "blank";
  seal: boolean;
  notes: string;
  terms: { title: string; text: string }[];
  amounts: number[];
  subtotalPaise: number;
  gstPaise: number;
  totalPaise: number;
  tax: { placeOfSupplyName: string | null; interState: boolean; cgstPaise: number; sgstPaise: number; igstPaise: number };
  paidPaise: number;
  balancePaise: number;
  /** Drafts only: an issued invoice is locked. */
  canEdit: boolean;
};
