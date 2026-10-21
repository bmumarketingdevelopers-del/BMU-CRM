// Workspace area: Client 360, calendar, capacity, SOP library, profile & leave, creators, client reports/team.
import { z } from "zod";
import type { GateTrack } from "./workflow.js";

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a valid date");

// ---------------------------------------------------------------------------
// Client 360 (team)

export type Client360 = {
  client: { id: string; name: string; industry: string | null; health: string; since: string; am: { id: string; name: string; email: string | null } | null };
  stats: { activeServices: number; openRequests: number; draftsWaiting: number; outstandingPaise: number | null; lastContactAt: string | null };
  services: { id: string; serviceName: string; tier: string; billingType: string; status: string; currentGate: string; track: GateTrack; approved: number; total: number }[];
  deliverables: { id: string; title: string; status: string; dueAt: string | null; serviceName: string; overdue: boolean }[];
  requests: { id: string; type: string; description: string; status: string; createdAt: string }[];
  invoices: { outstandingPaise: number; paidPaise: number; recent: { id: string; number: string; status: string; totalPaise: number; paidPaise: number; dueDate: string }[] } | null;
  messages: { id: string; threadId: string; author: string; fromClient: boolean; body: string; internal: boolean; at: string }[];
  files: { id: string; name: string; kind: string; url: string; at: string }[];
  users: { id: string; name: string; email: string | null; role: string; status: string }[];
  activity: { id: string; action: string; entity: string; actor: string | null; at: string }[];
};

// ---------------------------------------------------------------------------
// Calendar (team)

/** v34: meetings and scheduled / published social posts are on the calendar too. */
export type CalendarItemKind = "task" | "deliverable" | "draft_due" | "holiday" | "leave" | "meeting" | "post";
/** time: "HH:MM" (IST) for meetings and posts. */
export type CalendarItem = { id: string; date: string; kind: CalendarItemKind; title: string; sub?: string; href?: string; done?: boolean; overdue?: boolean; time?: string };
export type CalendarView = { month: string; view: "mine" | "team"; today: string; items: CalendarItem[] };

// ---------------------------------------------------------------------------
// Capacity (team)

export type TeamCapacityPerson = {
  id: string;
  name: string;
  department: string | null;
  open: number;
  dueThisWeek: number;
  overdue: number;
  blocked: number;
  loadPct: number;
  onLeave: boolean;
};
export type TeamCapacityView = {
  scope: "all" | "department" | "team";
  scopeLabel: string;
  week: { from: string; to: string };
  hoursPerTask: number;
  weekHours: number;
  me: TeamCapacityPerson;
  people: TeamCapacityPerson[];
  unassigned: { id: string; title: string; deadline: string | null; client: string | null; department: string | null; href: string | null }[];
};

// ---------------------------------------------------------------------------
// SOP library (all staff, read-only)

export type SopRow = { id: string; title: string; version: number; department: { id: string; name: string }; excerpt: string };
export type SopDetail = SopRow & { body: string; /** v10: version this person acknowledged with "I have read this" (null if never). */ acknowledgedVersion?: number | null; acknowledgedAt?: string | null };

// ---------------------------------------------------------------------------
// Profile, attendance & leave (team)

// v31: work from home uses the same request and approvals (Department Head, then HR); the person still checks in and out.
export const LEAVE_TYPES = ["casual", "sick", "unpaid", "wfh"] as const;
export type LeaveType = (typeof LEAVE_TYPES)[number];
export const leaveTypeLabels: Record<LeaveType, string> = { casual: "Casual leave", sick: "Sick leave", unpaid: "Unpaid leave", wfh: "Work from home" };
/** v31: approved requests of these types mean the person is away (not work from home). */
export const isAwayLeave = (type: string) => type !== "wfh";

/** v31: paid leave: 1 casual and 1 sick day build up each month; unused days carry over within the calendar year. */
export const PAID_LEAVE_PER_MONTH = { casual: 1, sick: 1 } as const;

/** v31: the message the employee sees once their request is finally decided (never who decided, or the steps in between). */
export function leaveDecisionMessage(type: string, status: "approved" | "rejected", range: string, split?: { paid: number; unpaid: number }): { title: string; body: string } {
  const unpaid = split && split.unpaid > 0 ? ` ${split.paid ? `${split.paid} paid day${split.paid === 1 ? "" : "s"} and ` : ""}${split.unpaid} unpaid day${split.unpaid === 1 ? "" : "s"} (loss of pay).` : "";
  if (status === "approved") {
    if (type === "sick") return { title: `Your sick leave (${range}) is approved`, body: `Take all the rest you need and get well soon. The team looks forward to having you back.${unpaid}` };
    if (type === "casual") return { title: `Your casual leave (${range}) is approved`, body: `Enjoy your time off and come back refreshed.${unpaid}` };
    if (type === "wfh") return { title: `Your work from home (${range}) is approved`, body: "Please check in and out from My Day as usual, and stay reachable during working hours." };
    return { title: `Your unpaid leave (${range}) is approved`, body: `Take care, and see you when you are back.${unpaid}` };
  }
  if (type === "sick") return { title: `Your sick leave request (${range}) was not approved`, body: "Please speak to HR if you are unwell, and take care of yourself." };
  if (type === "casual") return { title: `Your casual leave request (${range}) was not approved`, body: "Please speak to HR if you would like to plan other dates." };
  if (type === "wfh") return { title: `Your work from home request (${range}) was not approved`, body: "Please plan to work from the office on those days." };
  return { title: `Your unpaid leave request (${range}) was not approved`, body: "Please speak to HR if you would like to plan other dates." };
}

export const leaveRequestSchema = z
  .object({
    from: isoDay,
    to: isoDay,
    type: z.enum(LEAVE_TYPES),
    reason: z.string().trim().max(500).optional(),
  })
  .refine((v) => v.to >= v.from, { message: "The end date must be on or after the start date", path: ["to"] });
export type LeaveRequestInput = z.infer<typeof leaveRequestSchema>;

/** v31: the employee sees only the final result: no stages, approvers or their notes. */
export type LeaveRequestView = {
  id: string;
  from: string;
  to: string;
  type: LeaveType;
  reason: string | null;
  status: "pending" | "approved" | "rejected" | "cancelled";
  days: number;
  /** v31: working days paid from the leave balance and unpaid (loss of pay). */
  paidDays?: number;
  unpaidDays?: number;
  createdAt: string;
  decidedAt: string | null;
};

export type MyProfile = {
  user: { id: string; name: string; email: string | null; phone: string | null; department: string | null; team: string | null; manager: { name: string; email: string | null } | null; roles: string[]; specialty?: string | null; canRename?: boolean };
  attendance: { month: string; days: { date: string; checkIn: string | null; checkOut: string | null; hours: number }[]; totalHours: number; daysPresent: number; workingDaysSoFar: number };
  eod: { date: string; completed: string[]; pending: string[]; blocked: string[]; waiting: string[] }[];
  leave: {
    year: number;
    /** v31: allowed = paid days built up so far this year (1 a month per type, carried over). */
    balance: { type: "casual" | "sick"; allowed: number; used: number; pending: number; left: number }[];
    unpaidUsed: number;
    /** v31: approved work-from-home days this year. */
    wfhDays?: number;
    /** v31: Founders don't request leave. */
    canApply?: boolean;
    requests: LeaveRequestView[];
  };
  holidays: { date: string; name: string }[];
};

export const updateMeSchema = z.object({
  name: z.string().trim().min(2, "Enter your name").max(120),
  phone: z
    .string()
    .trim()
    .max(20)
    .refine((v) => v === "" || /^(\+?91)?[6-9]\d{9}$/.test(v.replace(/[\s-]/g, "")), { message: "Enter a 10-digit Indian mobile number" })
    .optional(),
});
export type UpdateMe = z.infer<typeof updateMeSchema>;

// ---------------------------------------------------------------------------
// Creators (team manages, creator portal)

export type CreatorRate = { label: string; pricePaise: number };
export const BRIEF_STATUSES = ["offered", "accepted", "declined", "submitted", "revision", "approved", "paid", "cancelled"] as const;
export type BriefStatus = (typeof BRIEF_STATUSES)[number];
export const briefStatusLabels: Record<BriefStatus, string> = {
  offered: "Offered",
  accepted: "In progress",
  declined: "Declined",
  submitted: "Submitted for review",
  revision: "Needs revision",
  approved: "Approved",
  paid: "Paid",
  cancelled: "Cancelled",
};

export type CreatorRow = {
  id: string;
  userId: string;
  name: string;
  email: string | null;
  phone: string | null;
  niche: string[];
  rates: CreatorRate[];
  rating: number | null;
  activeBriefs: number;
  approvedBriefs: number;
  pendingPayoutPaise: number;
};

export type BriefRow = {
  id: string;
  title: string;
  status: BriefStatus;
  feePaise: number;
  dueAt: string | null;
  creator: { id: string; name: string };
  client: { id: string; name: string } | null;
  submissions: number;
  updatedAt: string;
};

export type SubmissionView = {
  id: string;
  number: number;
  url: string | null;
  fileUrl: string | null;
  fileName: string | null;
  note: string | null;
  feedback: string | null;
  approved: boolean | null;
  reviewedAt: string | null;
  createdAt: string;
};

export type PayoutView = {
  id: string;
  briefId: string | null;
  briefTitle: string | null;
  amountPaise: number;
  tdsPaise: number;
  netPaise: number;
  status: "pending" | "paid" | "on_hold";
  paidAt: string | null;
  createdAt: string;
};

export type BriefDetail = BriefRow & {
  brief: string;
  deliverables: string[];
  engagement: { id: string; serviceName: string } | null;
  createdBy: string | null;
  createdAt: string;
  submissionList: SubmissionView[];
  payout: PayoutView | null;
};

export type BriefOptions = {
  creators: { id: string; name: string; niche: string[] }[];
  clients: { id: string; name: string; engagements: { id: string; serviceName: string }[] }[];
};

export const createBriefSchema = z.object({
  creatorId: z.string().min(1, "Choose a creator"),
  title: z.string().trim().min(3, "Give the brief a title").max(160),
  brief: z.string().trim().min(10, "Describe what you need (at least 10 characters)").max(8000),
  deliverables: z.array(z.string().trim().min(1).max(200)).min(1, "List at least one deliverable").max(30),
  dueAt: isoDay.optional(),
  feeRupees: z.number().int("Use whole rupees").min(0).max(10_000_000),
  clientOrgId: z.string().optional(),
  engagementId: z.string().optional(),
});
export type CreateBrief = z.infer<typeof createBriefSchema>;

export const briefFeedbackSchema = z.object({ feedback: z.string().trim().min(3, "Tell the creator what to change").max(4000) });
export const submissionLinkSchema = z.object({ url: z.string().url("Paste a full link starting with https://"), note: z.string().trim().max(2000).optional() });

export type CreatorPayouts = { totals: { pendingPaise: number; paidPaise: number; tdsPaise: number }; items: PayoutView[] };

export type CreatorProfile = { name: string; email: string | null; phone: string | null; niche: string[]; rates: CreatorRate[]; rating: number | null };
export const creatorProfileSchema = z.object({
  niche: z.array(z.string().trim().min(1).max(40)).max(12),
  rates: z.array(z.object({ label: z.string().trim().min(1).max(60), pricePaise: z.number().int().min(0).max(1_000_000_000) })).max(12),
});
export type UpdateCreatorProfile = z.infer<typeof creatorProfileSchema>;

// ---------------------------------------------------------------------------
// Client reports and client team

export type ClientReport = {
  period: string;
  periodLabel: string;
  client: { name: string };
  stats: { deliverablesApproved: number; draftsReviewed: number; avgApprovalHours: number | null; requestsResolved: number; onTimeFirstReplyPct: number | null };
  approved: { id: string; title: string; serviceName: string; version: number | null; approvedAt: string }[];
  requests: { opened: number; resolved: number; byType: { type: string; count: number }[]; items: { id: string; type: string; description: string; status: string; createdAt: string }[] };
  spend: { invoicedPaise: number; paidPaise: number; invoices: { id: string; number: string; totalPaise: number; status: string; createdAt: string }[] } | null;
  services: { id: string; serviceName: string; tier: string; status: string; track: GateTrack; approved: number; total: number }[];
};

export const CLIENT_TEAM_ROLES = ["client_owner", "client_approver", "client_finance", "client_viewer"] as const;
export type ClientTeamRole = (typeof CLIENT_TEAM_ROLES)[number];
export const clientRoleLabels: Record<ClientTeamRole, { name: string; can: string }> = {
  client_owner: { name: "Owner", can: "Everything: approve work and quotes, pay, manage team users" },
  client_approver: { name: "Approver", can: "Review and approve creative, raise requests" },
  client_finance: { name: "Finance", can: "View and pay invoices, download receipts" },
  client_viewer: { name: "Viewer", can: "See progress, files and reports; comment only" },
};

export type ClientTeamMember = { id: string; name: string; email: string | null; phone: string | null; role: ClientTeamRole; status: "invited" | "active" | "suspended"; isMe: boolean };
export type ClientTeamView = { canManage: boolean; members: ClientTeamMember[] };

export const inviteClientUserSchema = z.object({
  name: z.string().trim().min(2, "Enter their name").max(120),
  email: z.email("Enter a valid email").transform((v) => v.trim().toLowerCase()),
  role: z.enum(CLIENT_TEAM_ROLES),
});
export type InviteClientUser = z.infer<typeof inviteClientUserSchema>;
export const updateClientUserSchema = z.object({ role: z.enum(CLIENT_TEAM_ROLES).optional(), active: z.boolean().optional() });
export type UpdateClientUser = z.infer<typeof updateClientUserSchema>;
