// Command Centre "Organisation", "Clients" and "Catalogue" admin screens (admin-org area).
import { z } from "zod";

export type PersonRef = { id: string; name: string };

// ---------------------------------------------------------------------------
// Organisation: branches, departments, teams

export type OrgTeamView = { id: string; name: string; lead: PersonRef | null; members: PersonRef[] };
export type OrgDepartmentView = {
  id: string;
  name: string;
  head: PersonRef | null;
  headcount: number;
  teams: OrgTeamView[];
  /** People in the department who are not in any team. */
  unassigned: PersonRef[];
};
export type OrgBranchView = { id: string; name: string; city: string; headcount: number; departments: OrgDepartmentView[] };
export type OrgStaffMember = PersonRef & { branchId: string | null; departmentId: string | null; teamId: string | null; roles: string[] };
export type OrgStructureView = { branches: OrgBranchView[]; staff: OrgStaffMember[]; canEdit: boolean };

const name = z.string().trim().min(2, "Use at least 2 characters").max(80);
export const branchInputSchema = z.object({ name, city: z.string().trim().min(2, "Enter the city").max(80) });
export const branchUpdateSchema = branchInputSchema.partial();
export const departmentInputSchema = z.object({ branchId: z.string().min(1), name });
export const departmentUpdateSchema = z.object({ name: name.optional(), headUserId: z.string().min(1).nullable().optional() });
export const teamInputSchema = z.object({ departmentId: z.string().min(1), name, leadUserId: z.string().min(1).nullable().optional() });
export const teamUpdateSchema = z.object({ name: name.optional(), leadUserId: z.string().min(1).nullable().optional() });
/** Move a person into a team (teamId) or out of teams within a department (teamId null + departmentId). */
export const moveMemberSchema = z.object({ userId: z.string().min(1), teamId: z.string().min(1).nullable(), departmentId: z.string().min(1).nullable().optional() });
export type BranchInput = z.infer<typeof branchInputSchema>;
export type DepartmentInput = z.infer<typeof departmentInputSchema>;
export type DepartmentUpdate = z.infer<typeof departmentUpdateSchema>;
export type TeamInput = z.infer<typeof teamInputSchema>;
export type TeamUpdate = z.infer<typeof teamUpdateSchema>;
export type MoveMember = z.infer<typeof moveMemberSchema>;

// ---------------------------------------------------------------------------
// Attendance & leave

export const LEAVE_ALLOWANCE = { casual: 12, sick: 12 } as const;

export type AttendanceToday = "checked_in" | "checked_out" | "absent" | "on_leave" | "holiday" | "day_off" | "not_yet";
export type AttendanceCell = "present" | "late" | "leave" | "absent" | "holiday" | "weekend" | "future" | "none";

export type AttendanceBoardRow = {
  user: PersonRef & { department: string | null };
  status: AttendanceToday;
  checkIn: string | null;
  checkOut: string | null;
  late: boolean;
};
export type AttendanceView = {
  today: string;
  /** What kind of day today is, e.g. a holiday with its name. */
  todayKind: { kind: "working" | "weekend" | "holiday"; label: string | null };
  month: string;
  workingHours: { start: string; end: string; days: number[] };
  board: AttendanceBoardRow[];
  days: { date: string; kind: "working" | "weekend" | "holiday"; label: string | null }[];
  grid: { user: PersonRef; cells: AttendanceCell[]; present: number; leave: number; absent: number }[];
  late: { user: PersonRef; date: string; checkIn: string; minutesLate: number }[];
  balances: { user: PersonRef; casualUsed: number; sickUsed: number; casualLeft: number; sickLeft: number; otherUsed: number }[];
};

export type LeaveRow = {
  id: string;
  user: PersonRef;
  from: string;
  to: string;
  type: string;
  reason: string | null;
  status: "pending" | "approved" | "rejected" | "cancelled";
  workingDays: number;
  decidedBy: PersonRef | null;
  decidedAt: string | null;
  createdAt: string;
  canDecide: boolean;
  /** v10 approval chain: who decides next ("manager" or "hr"); "done" once decided. */
  stage?: "manager" | "hr" | "done";
  managerDecidedBy?: PersonRef | null;
  decisionNote?: string | null;
  /** Open tasks of this person due while they are away. */
  tasksDuringLeave?: number;
};
export const decideLeaveSchema = z.object({ decision: z.enum(["approve", "reject"]), note: z.string().trim().max(500).optional() });
export type DecideLeave = z.infer<typeof decideLeaveSchema>;

// ---------------------------------------------------------------------------
// Clients: engagements, CM assignment, offboarding

export type AdminEngagementRow = {
  id: string;
  client: PersonRef;
  serviceName: string;
  tier: string;
  billingType: string;
  status: string;
  currentGate: string;
  am: PersonRef | null;
  startDate: string | null;
  createdAt: string;
};

export type AmWorkloadView = {
  ams: (PersonRef & { role: string; clients: number; activeEngagements: number })[];
  clients: { id: string; name: string; am: PersonRef | null; activeEngagements: number; health: string }[];
  canEdit: boolean;
};
export const reassignAmSchema = z.object({ amUserId: z.string().min(1, "Choose a client manager") });

export const OFFBOARDING_CHECKS = [
  { key: "access_returned", label: "Client access returned (logins, ad accounts, pages)" },
  { key: "final_files", label: "Final files delivered" },
  { key: "final_invoice", label: "Final invoice paid" },
  { key: "feedback", label: "Feedback requested" },
] as const;
export type OffboardingCheckKey = (typeof OFFBOARDING_CHECKS)[number]["key"];

export type OffboardingRow = AdminEngagementRow & {
  filesReleased: boolean | null;
  unpaidInvoices: { id: string; number: string; status: string; totalPaise: number }[];
  checklist: Record<OffboardingCheckKey, { done: boolean; by: string | null; at: string | null }>;
  lastChange: { action: string; reason: string | null; by: string | null; at: string } | null;
  can: { pause: boolean; offboard: boolean; close: boolean; reactivate: boolean };
  closeBlockedReason: string | null;
};
export const engagementLifecycleSchema = z
  .object({ action: z.enum(["pause", "offboard", "close", "reactivate"]), reason: z.string().trim().max(500).optional() })
  .refine((v) => v.action !== "close" || (v.reason?.length ?? 0) >= 3, { message: "Give a reason for closing", path: ["reason"] });
export type EngagementLifecycle = z.infer<typeof engagementLifecycleSchema>;
export const offboardingTickSchema = z.object({
  key: z.enum(OFFBOARDING_CHECKS.map((c) => c.key) as [OffboardingCheckKey, ...OffboardingCheckKey[]]),
  done: z.boolean(),
});

// ---------------------------------------------------------------------------
// Catalogue

export type DiscountApprovalRow = {
  id: string;
  lead: string;
  extraDiscountPct: number;
  discountPaise: number;
  totalPaise: number;
  status: string;
  createdBy: string | null;
  approvedBy: string | null;
  createdAt: string;
};
