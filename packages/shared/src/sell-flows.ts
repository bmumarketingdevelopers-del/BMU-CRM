import { z } from "zod";
import { rupeesToPaise } from "./money.js";
import { GST_RATE } from "./money.js";
import type { ProposalLine } from "./proposals.js";
import type { LeadRow, LeadStage } from "./crm.js";

// v10 sell flows: lead detail + activity timeline, follow-ups, duplicates, proposal negotiation (revisions,
// change requests, expiry), multi-step discount approval, renewals and the payment plan.

// ------------------------------------------------------------------ Lead score

export type SellScorePart = { label: string; points: number; max: number };

/** Lead score (0-100) with the reasons behind it: budget band, services asked for, complete details. */
export function sellLeadScore(budgetPaise: number | null, serviceCount: number, hasCompany: boolean): { score: number; parts: SellScorePart[] } {
  const budget = budgetPaise ?? 0;
  const budgetPts = budget >= rupeesToPaise(100000) ? 50 : budget >= rupeesToPaise(50000) ? 35 : budget >= rupeesToPaise(25000) ? 20 : budget > 0 ? 10 : 0;
  const budgetLabel =
    budget >= rupeesToPaise(100000)
      ? "Budget ₹1 lakh or more a month"
      : budget >= rupeesToPaise(50000)
        ? "Budget ₹50,000 or more a month"
        : budget >= rupeesToPaise(25000)
          ? "Budget ₹25,000 or more a month"
          : budget > 0
            ? "Budget under ₹25,000 a month"
            : "No budget given";
  const servicePts = Math.min(serviceCount, 4) * 10;
  const parts: SellScorePart[] = [
    { label: budgetLabel, points: budgetPts, max: 50 },
    { label: serviceCount ? `Asked for ${serviceCount} service${serviceCount === 1 ? "" : "s"}` : "No services picked", points: servicePts, max: 40 },
    { label: hasCompany ? "Gave a business name" : "No business name", points: hasCompany ? 10 : 0, max: 10 },
  ];
  return { score: Math.min(100, budgetPts + servicePts + (hasCompany ? 10 : 0)), parts };
}

// ------------------------------------------------------------------ Lead activity

export const SELL_ACTIVITY_KINDS = ["call", "meeting", "note", "email", "whatsapp"] as const;
export type SellActivityKind = (typeof SELL_ACTIVITY_KINDS)[number];
export const sellActivityLabels: Record<string, string> = {
  call: "Call",
  meeting: "Meeting",
  note: "Note",
  email: "Email",
  whatsapp: "WhatsApp",
  enquiry: "Website enquiry",
  system: "Update",
};
export const SELL_OUTCOMES = ["connected", "no_answer", "interested", "not_interested", "callback", "meeting_booked", "proposal_requested"] as const;
export const sellOutcomeLabels: Record<string, string> = {
  connected: "Spoke to them",
  no_answer: "No answer",
  interested: "Interested",
  not_interested: "Not interested",
  callback: "Asked to call back",
  meeting_booked: "Meeting booked",
  proposal_requested: "Wants a proposal",
};

export const sellActivitySchema = z.object({
  kind: z.enum(SELL_ACTIVITY_KINDS),
  outcome: z.enum(SELL_OUTCOMES).optional(),
  body: z.string().trim().min(2, "Write a short note about what happened").max(4000),
  at: z.iso.datetime({ offset: true }).optional(),
  nextFollowUpAt: z.iso.datetime({ offset: true }).nullable().optional(),
});
export type SellActivityInput = z.infer<typeof sellActivitySchema>;

export const sellFollowUpSchema = z.object({ nextFollowUpAt: z.iso.datetime({ offset: true }).nullable() });

export type SellTimelineItem = {
  id: string;
  /** activity kinds, plus: stage, proposal, payment, assigned */
  kind: string;
  title: string;
  body: string | null;
  outcome: string | null;
  at: string;
  by: string | null;
  nextFollowUpAt: string | null;
  href: string | null;
};

export type SellLeadProposal = {
  id: string;
  version: number;
  status: string;
  totalPaise: number;
  sentAt: string | null;
  viewCount: number;
  createdAt: string;
  discountStatus: string;
};

export type SellLeadDetail = {
  lead: LeadRow;
  nextFollowUpAt: string | null;
  followUpDue: boolean;
  lastActivityAt: string | null;
  score: { score: number; parts: SellScorePart[] };
  duplicateOf: { id: string; name: string; stage: LeadStage; createdAt: string } | null;
  duplicates: { id: string; name: string; stage: LeadStage; createdAt: string }[];
  proposals: SellLeadProposal[];
  timeline: SellTimelineItem[];
  client: { id: string; name: string } | null;
  canAssign: boolean;
};

export type SellFollowUp = { leadId: string; name: string; stage: LeadStage; nextFollowUpAt: string; overdue: boolean; owner: string | null };

// ------------------------------------------------------------------ Proposal negotiation

export const sellReviseSchema = z.object({
  lines: z.array(z.object({ serviceKey: z.string(), tier: z.enum(["starter", "growth", "premium"]) })).min(1, "Add at least one service"),
  addOns: z.array(z.object({ addOnId: z.string(), qty: z.number().int().min(1).max(20) })).default([]),
  extraDiscountPct: z.number().int().min(0).max(50).default(0),
  validDays: z.number().int().min(1).max(60).default(14),
  changeNote: z.string().trim().max(1000).optional(),
});
export type SellReviseInput = z.infer<typeof sellReviseSchema>;

export const sellExtendSchema = z.object({ days: z.number().int().min(1).max(60) });

export const sellChangeRequestSchema = z.object({
  name: z.string().trim().min(2, "Tell us your name"),
  email: z.email("Enter a valid email").optional().or(z.literal("").transform(() => undefined)),
  comment: z.string().trim().min(5, "Tell us what you would like changed").max(2000),
});
export type SellChangeRequestInput = z.infer<typeof sellChangeRequestSchema>;

export type SellChangeRequest = { id: string; comment: string; byName: string; byEmail: string | null; at: string; resolvedAt: string | null; revisionId: string | null; version: number };

export type SellVersion = { id: string; version: number; status: string; totalPaise: number; createdAt: string; sentAt: string | null; changeNote: string | null };

// ------------------------------------------------------------------ Discount approval

export type SellApprovalLevel = "manager" | "founder";
export const sellApprovalLevelLabels: Record<SellApprovalLevel, string> = { manager: "Sales manager", founder: "Founder" };

/**
 * Who must approve an extra discount, in order. Within the creator's own limit: nobody.
 * Over it: a sales manager first (skipped when the creator is a manager or admin), then the Founder when the
 * discount is above the admin limit. Founders never need approval.
 */
export function sellApprovalChain(input: { pct: number; creatorRoles: string[]; limits: Record<string, number> }): SellApprovalLevel[] {
  const { pct, creatorRoles, limits } = input;
  if (pct <= 0 || creatorRoles.includes("founder")) return [];
  const own = Math.max(0, ...creatorRoles.map((r) => limits[r] ?? 0));
  if (pct <= own) return [];
  const adminLimit = limits.admin ?? 0;
  const isManager = creatorRoles.some((r) => r === "sales_manager" || r === "admin");
  const chain: SellApprovalLevel[] = [];
  if (!isManager || pct <= adminLimit) chain.push("manager");
  if (pct > adminLimit) chain.push("founder");
  return chain;
}

export type SellApprovalStep = {
  id: string;
  step: number;
  level: SellApprovalLevel;
  status: "waiting" | "pending" | "approved" | "rejected" | "cancelled";
  decider: string | null;
  note: string | null;
  decidedAt: string | null;
};

export const sellDecisionSchema = z.object({ note: z.string().trim().max(1000).optional() });
export const sellRejectSchema = z.object({ note: z.string().trim().min(3, "Say why, so sales can fix it") });

export type SellApprovalItem = {
  stepId: string;
  proposalId: string;
  client: string;
  version: number;
  extraDiscountPct: number;
  discountPaise: number;
  totalPaise: number;
  createdBy: string | null;
  level: SellApprovalLevel;
  step: number;
  steps: SellApprovalStep[];
  status: SellApprovalStep["status"];
  requestedAt: string;
  decidedAt: string | null;
  note: string | null;
  canDecide: boolean;
};

export type SellApprovalInbox = { pending: SellApprovalItem[]; decided: SellApprovalItem[]; limits: Record<string, number> };

/** One special discount the signed-in person asked for on their own proposal (Sales Executive's Approvals page). */
export type SellMyDiscount = {
  proposalId: string;
  client: string;
  version: number;
  /** Proposal status: draft, sent, accepted… (an approved discount on a draft is ready to send). */
  proposalStatus: string;
  extraDiscountPct: number;
  /** The special discount only (bundle discount excluded). */
  extraDiscountPaise: number;
  totalPaise: number;
  discountStatus: "pending" | "approved" | "rejected";
  /** For a pending discount: whose decision it is waiting on. */
  waitingFor: SellApprovalLevel | null;
  steps: SellApprovalStep[];
  requestedAt: string;
  /** When the final decision was made (last approval, or the rejection). */
  decidedAt: string | null;
  sentAt: string | null;
};

/** Only the person's own proposals. Approved = every approved discount; history = approved and rejected, newest decision first. */
export type SellMyDiscounts = { pending: SellMyDiscount[]; approved: SellMyDiscount[]; history: SellMyDiscount[] };

// ------------------------------------------------------------------ Payment plan

export type SellPaymentPart = { label: string; when: string; netPaise: number; gstPaise: number; totalPaise: number };
export type SellPaymentPlan = { now: SellPaymentPart; later: SellPaymentPart[] };

const gst = (p: number) => Math.round(p * GST_RATE);

/** What the client pays and when: retainers monthly in advance, projects and add-ons 50% now and 50% before handover. */
export function sellPaymentPlan(lines: ProposalLine[]): SellPaymentPlan {
  const dueNow = lines.reduce((s, l) => s + l.dueNowPaise, 0);
  const monthly = lines.filter((l) => l.billingType === "monthly").reduce((s, l) => s + l.netPaise, 0);
  const balance = lines.filter((l) => l.billingType !== "monthly").reduce((s, l) => s + (l.netPaise - l.dueNowPaise), 0);
  const later: SellPaymentPart[] = [];
  if (balance > 0) later.push({ label: "Project balance (50%)", when: "Before final files are handed over", netPaise: balance, gstPaise: gst(balance), totalPaise: balance + gst(balance) });
  if (monthly > 0) later.push({ label: "Monthly retainer", when: "Every month after the first, billed in advance", netPaise: monthly, gstPaise: gst(monthly), totalPaise: monthly + gst(monthly) });
  return {
    now: { label: "First payment", when: "On acceptance, to start work", netPaise: dueNow, gstPaise: gst(dueNow), totalPaise: dueNow + gst(dueNow) },
    later,
  };
}

/** Short label for an invoice line of the first payment. */
export function sellFirstPaymentNote(line: Pick<ProposalLine, "billingType">): string {
  return line.billingType === "monthly" ? "First month, in advance" : "50% advance";
}

// ------------------------------------------------------------------ Renewals

export type SellRenewal = {
  engagementId: string;
  clientOrgId: string;
  client: string;
  service: string;
  serviceKey: string;
  tier: string;
  billingType: string;
  startDate: string | null;
  endDate: string | null;
  monthsActive: number;
  dueDate: string;
  reason: string;
  urgency: "overdue" | "soon" | "upcoming";
  monthlyPaise: number | null;
  am: string | null;
  openProposal: { id: string; status: string; version: number } | null;
  renewalCount: number;
};

export const sellRenewalCreateSchema = z.object({ clientOrgId: z.string(), engagementIds: z.array(z.string()).min(1, "Pick at least one service to renew") });

/** Months a renewal extends a monthly retainer by. */
export const SELL_RENEWAL_MONTHS = 12;
