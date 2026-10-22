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
  /** Why the CM can't start the next month right now (plain words), if so. */
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

// ---------------------------------------------------------------------------
// v37 manual hand-off: Client Manager → Department Head → people

/** not_sent: the Client Manager has not sent it yet · waiting: sent, the Department Head has not picked everyone · assigned */
export type HandoffStatus = "not_sent" | "waiting" | "assigned";
export const handoffStatusLabels: Record<HandoffStatus, string> = { not_sent: "Not sent", waiting: "Waiting for head", assigned: "Assigned" };

export type HandoffStep = {
  taskId: string;
  key: string | null;
  name: string;
  /** work: made by the department · qc: a QC reviewer or the Department Head · client_review: the Client Manager */
  kind: "work" | "qc" | "client_review" | "planning";
  owner: { id: string; name: string } | null;
  deadline: string | null;
  status: string;
  /** v40: hours the Department Head gave the step (counts on the person's 45h week until it is done). */
  hours: number | null;
};

export type HandoffDeliverable = {
  id: string;
  title: string;
  type: string;
  deliverableStatus: string;
  dueAt: string | null;
  project: { id: string; client: string; service: string; cm: { id: string; name: string } | null };
  department: { id: string; name: string } | null;
  head: { id: string; name: string } | null;
  status: HandoffStatus;
  sentAt: string | null;
  sentBy: { id: string; name: string } | null;
  note: string | null;
  assignedAt: string | null;
  steps: HandoffStep[];
  can: { send: boolean; assign: boolean };
};

export type ProjectHandoffView = {
  engagementId: string;
  deliverables: HandoffDeliverable[];
  /** Departments the Client Manager can send work to (those with a Department Head). */
  departments: { id: string; name: string; head: { id: string; name: string } | null }[];
  canSend: boolean;
};

/** The hand-off page: what a Department Head has to assign, and what a Client Manager is waiting for. */
export type HandoffInbox = {
  toAssign: HandoffDeliverable[];
  waitingForHeads: HandoffDeliverable[];
  notSent: HandoffDeliverable[];
  isHead: boolean;
  isSender: boolean;
};

export type HandoffPerson = { id: string; name: string; specialty: string | null; openTasks: number; onLeaveToday: boolean; why: string | null };
/** People a Department Head can put on a deliverable's steps. */
export type HandoffOptions = { makers: HandoffPerson[]; qc: HandoffPerson[] };

export const handoffSendSchema = z.object({
  items: z.array(z.object({ deliverableId: z.string().min(1), departmentId: z.string().min(1, "Pick a department") })).min(1, "Pick at least one deliverable").max(100),
  note: z.string().trim().max(2000).optional(),
});
export type HandoffSendInput = z.infer<typeof handoffSendSchema>;

export const handoffAssignSchema = z.object({
  steps: z
    .array(z.object({ taskId: z.string().min(1), ownerId: z.string().min(1), /** v40 */ hours: z.number().min(0.5, "At least half an hour").max(500, "At most 500 hours per step").optional() }))
    .min(1, "Pick a person for at least one step")
    .max(30),
});
export type HandoffAssignInput = z.infer<typeof handoffAssignSchema>;

// ---------------------------------------------------------------------------
// v40 project flow: the Client Manager asks Department Heads for a finish date, shares it with the client; Department
// Heads share each big finished part (a demo link or files) and the client approves it or asks for changes.

export type EstimateStatus = "waiting" | "estimated" | "shared";
export const estimateStatusLabels: Record<EstimateStatus, string> = { waiting: "Waiting for the head", estimated: "Date given", shared: "Shared with client" };

export type ProjectEstimateRow = {
  id: string;
  department: { id: string; name: string };
  head: { id: string; name: string } | null;
  requestedBy: string | null;
  requestNote: string | null;
  /** v41: requirement documents the Client Manager sent with the request */
  docs: MilestoneFile[];
  requestedAt: string;
  /** YYYY-MM-DD */
  finishBy: string | null;
  headNote: string | null;
  estimatedAt: string | null;
  sharedAt: string | null;
  status: EstimateStatus;
  can: { estimate: boolean; share: boolean };
};

export type MilestoneStatus = "shared" | "approved" | "changes_requested";
export const milestoneStatusLabels: Record<MilestoneStatus, string> = { shared: "Waiting for the client", approved: "Approved", changes_requested: "Changes asked" };

export type MilestoneFile = { id: string; name: string; url: string; kind: string; mimeType: string | null };

export type ProjectMilestoneRow = {
  id: string;
  title: string;
  note: string | null;
  department: { id: string; name: string } | null;
  sharedBy: string | null;
  sharedAt: string;
  status: MilestoneStatus;
  files: MilestoneFile[];
  clientComment: string | null;
  decidedAt: string | null;
  decidedBy: string | null;
  /** The task the Department Head got when the client asked for changes. */
  changeTaskId: string | null;
};

/** v41: one open (or recently done) task of the project, by department. */
export type ProjectTaskRow = {
  id: string;
  title: string;
  departmentId: string | null;
  owner: { id: string; name: string } | null;
  hours: number | null;
  /** YYYY-MM-DD */
  deadline: string | null;
  status: string;
  /** From the approved plan (a deliverable's step) rather than added by the head. */
  fromPlan: boolean;
};

export type ProjectFlowView = {
  engagementId: string;
  client: string;
  service: string;
  estimates: ProjectEstimateRow[];
  milestones: ProjectMilestoneRow[];
  /** v41: the project's tasks (open ones and those done in the last 30 days). */
  tasks: ProjectTaskRow[];
  /** v41: people a Department Head can give tasks to, per department they head (their team and themselves). */
  teams: { departmentId: string; people: { id: string; name: string; openHours: number; onLeaveToday: boolean }[] }[];
  /** Departments with a Department Head (to ask for a date). */
  departments: { id: string; name: string; head: { id: string; name: string } | null }[];
  can: {
    /** The project's Client Manager or leadership: ask heads for dates, share them with the client. */
    request: boolean;
    /** Departments this person may share finished parts for (their own as Department Head; all for leadership). */
    shareFor: { id: string; name: string }[];
  };
};

/** A Department Head's open date requests (Work hand-off page). */
export type EstimateInboxRow = ProjectEstimateRow & { project: { id: string; client: string; service: string; cm: string | null } };

export const estimateRequestSchema = z.object({
  departmentIds: z.array(z.string().min(1)).min(1, "Pick at least one department").max(20),
  note: z.string().trim().max(2000).optional(),
  /** v41: requirement documents (uploaded files or Drive links) */
  fileIds: z.array(z.string()).max(20).default([]),
});
export type EstimateRequestInput = z.infer<typeof estimateRequestSchema>;

/** v41: a Department Head adds a task for someone in their team on the project. */
export const projectTaskCreateSchema = z.object({
  departmentId: z.string().min(1, "Pick the department"),
  title: z.string().trim().min(3, "Say what to do").max(200),
  ownerId: z.string().min(1, "Pick who does it"),
  hours: z.number({ message: "Give the hours" }).min(0.5, "At least half an hour").max(500, "At most 500 hours"),
  deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick the deadline"),
  note: z.string().trim().max(2000).optional(),
});
export type ProjectTaskCreateInput = z.infer<typeof projectTaskCreateSchema>;

/** v41: a Department Head gives a task (e.g. a step from the plan) to someone, with hours. */
export const projectTaskAssignSchema = z.object({
  ownerId: z.string().min(1, "Pick who does it"),
  hours: z.number({ message: "Give the hours" }).min(0.5, "At least half an hour").max(500, "At most 500 hours"),
});
export type ProjectTaskAssignInput = z.infer<typeof projectTaskAssignSchema>;

export const estimateSubmitSchema = z.object({
  finishBy: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick the finish date"),
  note: z.string().trim().max(2000).optional(),
});
export type EstimateSubmitInput = z.infer<typeof estimateSubmitSchema>;

export const milestoneCreateSchema = z.object({
  departmentId: z.string().min(1, "Pick the department"),
  title: z.string().trim().min(3, "Name the part that is done, e.g. Login page").max(160),
  note: z.string().trim().max(2000).optional(),
  fileIds: z.array(z.string()).min(1, "Add a demo link or a file for the client").max(20),
});
export type MilestoneCreateInput = z.infer<typeof milestoneCreateSchema>;

export const milestoneDecisionSchema = z
  .object({ decision: z.enum(["approve", "changes"]), comment: z.string().trim().max(2000).optional() })
  .refine((d) => d.decision === "approve" || (d.comment ?? "").length >= 3, { message: "Tell the team what to change", path: ["comment"] });
export type MilestoneDecisionInput = z.input<typeof milestoneDecisionSchema>;

/** The client's Progress page: finish dates shared with them and finished parts to look at. */
export type ClientProgressView = {
  projects: {
    engagementId: string;
    service: string;
    estimates: { department: string; finishBy: string; note: string | null; sharedAt: string }[];
    milestones: (ProjectMilestoneRow & { canDecide: boolean })[];
  }[];
};
