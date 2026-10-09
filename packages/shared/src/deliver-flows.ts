// v10 deliver: retainer cycles, content calendar, multi-approver approvals, delivery SLA and the handover pack.
import { z } from "zod";

// ---------------------------------------------------------------------------
// Multi-approver client approvals

export const DELIVER_APPROVAL_MODES = ["any", "owner", "all"] as const;
export type DeliverApprovalMode = (typeof DELIVER_APPROVAL_MODES)[number];

export const deliverApprovalModeLabels: Record<DeliverApprovalMode, { label: string; help: string }> = {
  any: { label: "Any one approver", help: "The first owner or approver who approves gives the go-ahead." },
  owner: { label: "The owner must approve", help: "Approvers can approve too, but the work moves on only once an account owner approves." },
  all: { label: "Every approver", help: "The work moves on once every owner and approver on your account has approved." },
};

export const deliverApprovalModeSchema = z.object({ mode: z.enum(DELIVER_APPROVAL_MODES) });

export type DeliverApprover = {
  userId: string;
  name: string;
  role: "owner" | "approver";
  /** Must this person approve before the work moves on? */
  required: boolean;
  approvedAt: string | null;
};

export type DeliverApprovalStatus = {
  mode: DeliverApprovalMode;
  modeLabel: string;
  satisfied: boolean;
  approvers: DeliverApprover[];
  /** Names still needed, in plain words. */
  pending: string[];
  /** e.g. "Approved by Asha. Waiting for Ravi." */
  summary: string;
};

export type DeliverApprovalSettings = {
  clientOrgId: string;
  mode: DeliverApprovalMode;
  approvers: { userId: string; name: string; role: "owner" | "approver" }[];
  canEdit: boolean;
};

export const deliverRemindSchema = z.object({ target: z.enum(["deliverable", "plan"]), id: z.string().min(1) });

// ---------------------------------------------------------------------------
// Monthly retainer cycles

export type DeliverQuotaItem = { type: string; label: string; count: number };

/**
 * Monthly quota per retainer tier, used when the catalogue tier has no deliverables listed.
 * A catalogue tier can override it with lines like "12 post: Feed posts" or "4 x reel".
 */
const social = (posts: number, reels: number, stories = 0): DeliverQuotaItem[] =>
  [
    { type: "post", label: "Feed posts", count: posts },
    { type: "reel", label: "Reels", count: reels },
    { type: "story", label: "Stories", count: stories },
  ].filter((q) => q.count > 0);

export const DELIVER_RETAINER_QUOTAS: Record<string, Record<"starter" | "growth" | "premium", DeliverQuotaItem[]>> = {
  smm: { starter: social(8, 2), growth: social(12, 4, 4), premium: social(16, 8, 8) },
  smm_brands: { starter: social(8, 2), growth: social(12, 4, 4), premium: social(16, 8, 8) },
  smm_influencers: { starter: social(6, 4), growth: social(10, 6), premium: social(14, 10, 6) },
  personal_branding: { starter: social(6, 2), growth: social(10, 4), premium: social(14, 8) },
  digital_marketing: {
    starter: [...social(8, 2), { type: "ad", label: "Ad creatives", count: 2 }],
    growth: [...social(12, 4), { type: "ad", label: "Ad creatives", count: 4 }, { type: "blog", label: "Blog articles", count: 1 }],
    premium: [...social(16, 8), { type: "ad", label: "Ad creatives", count: 8 }, { type: "blog", label: "Blog articles", count: 2 }],
  },
  graphic_design: {
    starter: [{ type: "post", label: "Designs", count: 10 }],
    growth: [{ type: "post", label: "Designs", count: 20 }, { type: "carousel", label: "Carousels", count: 4 }],
    premium: [{ type: "post", label: "Designs", count: 30 }, { type: "carousel", label: "Carousels", count: 8 }],
  },
  video_editing: {
    starter: [{ type: "reel", label: "Edited reels", count: 4 }],
    growth: [{ type: "reel", label: "Edited reels", count: 8 }, { type: "video", label: "Long videos", count: 1 }],
    premium: [{ type: "reel", label: "Edited reels", count: 12 }, { type: "video", label: "Long videos", count: 2 }],
  },
  seo: {
    starter: [{ type: "blog", label: "Blog articles", count: 2 }],
    growth: [{ type: "blog", label: "Blog articles", count: 4 }, { type: "page", label: "Page optimisations", count: 2 }],
    premium: [{ type: "blog", label: "Blog articles", count: 8 }, { type: "page", label: "Page optimisations", count: 4 }],
  },
  gbp: {
    starter: [{ type: "post", label: "Google posts", count: 4 }],
    growth: [{ type: "post", label: "Google posts", count: 8 }],
    premium: [{ type: "post", label: "Google posts", count: 12 }],
  },
  chatgpt_ads: {
    starter: [{ type: "ad", label: "Ad creatives", count: 2 }],
    growth: [{ type: "ad", label: "Ad creatives", count: 4 }],
    premium: [{ type: "ad", label: "Ad creatives", count: 8 }],
  },
};
const UGC: Record<"starter" | "growth" | "premium", DeliverQuotaItem[]> = {
  starter: [{ type: "reel", label: "UGC videos", count: 3 }],
  growth: [{ type: "reel", label: "UGC videos", count: 6 }],
  premium: [{ type: "reel", label: "UGC videos", count: 12 }],
};
for (const k of ["ugc_ads", "ugc_content", "ugc_outsourcing", "ugc_promotions"]) DELIVER_RETAINER_QUOTAS[k] = UGC;

/** Quota for a service tier: catalogue lines first ("12 post: Feed posts"), then the defaults above. */
export function deliverQuotaFor(serviceKey: string, tier: string, catalogueLines: string[] = []): DeliverQuotaItem[] {
  const parsed = catalogueLines
    .map((l) => /^\s*(\d+)\s*(?:x\s*)?([a-z_]+)\s*(?::\s*(.+))?$/i.exec(l))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ type: m[2].toLowerCase(), label: m[3]?.trim() || m[2], count: Number(m[1]) }));
  if (parsed.length) return parsed;
  const t = (["starter", "growth", "premium"].includes(tier) ? tier : "starter") as "starter" | "growth" | "premium";
  return DELIVER_RETAINER_QUOTAS[serviceKey]?.[t] ?? [{ type: "post", label: "Monthly deliverables", count: t === "premium" ? 12 : t === "growth" ? 8 : 4 }];
}

/** "2026-10" → "2026-11" */
export function deliverNextPeriod(period: string): string {
  const [y, m] = period.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

export function deliverPeriodLabel(period: string): string {
  if (!/^\d{4}-\d{2}$/.test(period)) return period === "project" ? "Project" : period;
  return new Date(`${period}-01T00:00:00Z`).toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
}

export type DeliverCycleSummary = {
  id: string;
  period: string;
  label: string;
  status: string;
  startedBy: string | null;
  startedAt: string;
  planStatus: string | null;
  invoice: { id: string; number: string; status: string; totalPaise: number } | null;
  quota: (DeliverQuotaItem & { planned: number; approved: number })[];
  carriedOver: { type: string; count: number; fromPeriod: string }[];
  /** Quota not used this month (planned below quota): rolls over to the next month. */
  unused: { type: string; count: number }[];
  deliverables: { total: number; approved: number; inProgress: number };
  /** Work from this month that is not approved yet (still being produced or with the client). */
  openDeliverables: { id: string; title: string; type: string; status: string; dueAt: string | null }[];
  /** Production is held because the client has an overdue invoice (Gate rules). */
  heldForPayment: string | null;
};

export type DeliverCyclesView = {
  engagementId: string;
  billingType: string;
  isRetainer: boolean;
  cycles: DeliverCycleSummary[];
  nextPeriod: string | null;
  can: { startNext: boolean };
  /** Why the AM can't start the next month right now (plain words), if so. */
  startNextBlocked: string | null;
};

export type DeliverRetainerRun = { created: { engagementId: string; client: string; period: string; invoiceNumber: string | null }[]; skipped: number };

// ---------------------------------------------------------------------------
// Content calendar

export const DELIVER_SOCIAL_TYPES = ["post", "carousel", "story", "reel", "video", "ad"] as const;
export const DELIVER_CHANNELS = ["instagram", "facebook", "linkedin", "youtube", "x", "google_business", "website", "other"] as const;
export type DeliverChannel = (typeof DELIVER_CHANNELS)[number];
export const deliverChannelLabels: Record<DeliverChannel, string> = {
  instagram: "Instagram",
  facebook: "Facebook",
  linkedin: "LinkedIn",
  youtube: "YouTube",
  x: "X (Twitter)",
  google_business: "Google Business",
  website: "Website",
  other: "Other",
};

export const deliverScheduleSchema = z.object({
  scheduledAt: z.string().datetime({ offset: true }),
  channel: z.enum(DELIVER_CHANNELS),
});
export const deliverPublishSchema = z.object({ liveUrl: z.string().url("Paste the live post link (https://…)") });

export type DeliverCalendarItem = {
  deliverableId: string;
  title: string;
  type: string;
  status: string;
  client: { id: string; name: string };
  engagementId: string;
  serviceName: string;
  scheduledAt: string | null;
  channel: DeliverChannel | null;
  publishedAt: string | null;
  liveUrl: string | null;
  preview: { kind: string; url: string } | null;
  /** v16: post text, whether the client approved it, whether it is past its time and not yet out, and its results. */
  caption?: string | null;
  approved?: boolean;
  dueToPublish?: boolean;
  metrics?: { reach: number; impressions: number; engagement: number; clicks: number; spendPaise: number; at: string } | null;
};

export type DeliverCalendarView = {
  from: string;
  to: string;
  items: DeliverCalendarItem[];
  /** Approved social work that has no date yet (team only). */
  unscheduled: DeliverCalendarItem[];
  canSchedule: boolean;
  /** v16: scheduled posts whose time has passed and are not marked published yet. */
  dueToPublish?: DeliverCalendarItem[];
};

// ---------------------------------------------------------------------------
// Delivery SLA

export type DeliverSlaItem = {
  key: string;
  state: "overdue" | "at_risk";
  kind: "deliverable" | "task";
  title: string;
  step: string | null;
  client: { id: string; name: string };
  engagementId: string;
  deliverableId: string | null;
  taskId: string | null;
  owner: string | null;
  department: string | null;
  dueAt: string;
  /** Working days late (overdue) or 0. */
  workingDaysLate: number;
  escalated: boolean;
};

export type DeliverSlaView = { overdue: number; atRisk: number; escalated: number; items: DeliverSlaItem[] };

// ---------------------------------------------------------------------------
// Handover pack and feedback

export const DELIVER_HANDOVER_KINDS = ["link", "credential", "note"] as const;
export const deliverHandoverItemSchema = z.object({
  kind: z.enum(DELIVER_HANDOVER_KINDS),
  label: z.string().trim().min(2, "Give it a name").max(120),
  value: z.string().trim().min(1, "Add the link, login or note").max(2000),
});
export type DeliverHandoverItemInput = z.infer<typeof deliverHandoverItemSchema>;

export const deliverFeedbackSchema = z.object({
  score: z.number().int().min(0).max(10),
  comment: z.string().trim().max(2000).optional(),
});

export type DeliverHandoverView = {
  engagementId: string;
  client: { id: string; name: string };
  serviceName: string;
  status: string;
  released: boolean;
  signedOffAt: string | null;
  files: { deliverableId: string; deliverable: string; type: string; version: number; fileId: string; name: string; kind: string; url: string; downloadUrl: string | null; sizeBytes: number | null }[];
  links: { label: string; url: string; source: "deliverable" | "handover" }[];
  items: { id: string; kind: (typeof DELIVER_HANDOVER_KINDS)[number]; label: string; value: string; addedBy: string; at: string }[];
  zipUrl: string | null;
  feedback: { mine: { score: number; comment: string | null; at: string } | null; all: { name: string; score: number; comment: string | null; at: string }[]; average: number | null };
  can: { addItems: boolean; giveFeedback: boolean; download: boolean };
};

export const deliverNpsBand = (score: number) => (score >= 9 ? "promoter" : score >= 7 ? "passive" : "detractor");
