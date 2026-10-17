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
export type AttendanceCell = "present" | "late" | "missed_out" | "leave" | "absent" | "holiday" | "weekend" | "future" | "none";

/** v30: a check-in after start + grace counts as late (default 15 minutes). */
export const ATTENDANCE_GRACE_DEFAULT = 15;

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
  workingHours: { start: string; end: string; days: number[]; graceMinutes: number };
  board: AttendanceBoardRow[];
  days: { date: string; kind: "working" | "weekend" | "holiday"; label: string | null }[];
  grid: { user: PersonRef; cells: AttendanceCell[]; present: number; leave: number; absent: number; missedOut?: number }[];
  late: { user: PersonRef; date: string; checkIn: string; minutesLate: number }[];
  balances: { user: PersonRef; casualUsed: number; sickUsed: number; casualLeft: number; sickLeft: number; otherUsed: number }[];
  /** v30: whose attendance this is: everyone (Founder, Branch Manager, HR) or a Department Head's own department(s). */
  scope?: { all: boolean; departments: string[] };
  /** v30: the attendance records sheet (Founder, HR; Department Heads for their team) and its download (Founder, HR). */
  canRecords?: boolean;
  canDownload?: boolean;
  /** v30: may decide attendance correction requests. */
  canCorrections?: boolean;
};

// v30: the attendance records sheet, by department, with each person's designation.
export type AttendanceRecordStatus = "present" | "late" | "missed_out" | "late_missed_out" | "leave" | "absent" | "holiday" | "weekend" | "worked_off_day" | "not_tracked" | "future";
export const attendanceStatusLabels: Record<AttendanceRecordStatus, string> = {
  present: "Present",
  late: "Late",
  missed_out: "Missed check-out",
  late_missed_out: "Late, missed check-out",
  leave: "On leave",
  absent: "Absent",
  holiday: "Holiday",
  weekend: "Weekly off",
  worked_off_day: "Worked on a day off",
  not_tracked: "Not tracked yet",
  future: "",
};
export type AttendanceRecordDay = {
  date: string;
  kind: "working" | "weekend" | "holiday";
  /** Holiday name. */
  label: string | null;
  checkIn: string | null;
  checkOut: string | null;
  hours: number;
  status: AttendanceRecordStatus;
  /** Minutes after the start time, when late. */
  lateMinutes: number;
  /** Times changed through an approved correction request. */
  corrected: boolean;
  leaveType?: string | null;
};
export type AttendanceRecordTotals = { workingDays: number; present: number; late: number; missedOut: number; leave: number; absent: number; hours: number };
export type AttendanceRecordPerson = { user: PersonRef & { email: string }; designation: string; days: AttendanceRecordDay[]; totals: AttendanceRecordTotals };
export type AttendanceRecordDepartment = { id: string | null; name: string; branch: string | null; people: AttendanceRecordPerson[]; totals: AttendanceRecordTotals };
export type AttendanceRecords = {
  from: string;
  to: string;
  generatedAt: string;
  workingHours: { start: string; end: string; days: number[]; graceMinutes: number };
  departments: AttendanceRecordDepartment[];
  /** Departments the viewer may pick from. */
  departmentOptions: { id: string; name: string }[];
  canDownload: boolean;
};

/** v30: today by department, for the Founder's and HR's dashboards (Department Heads: their own). */
export type AttendanceTodayDept = { id: string | null; name: string; total: number; in: number; late: number; onLeave: number; notIn: number; notYet: number; checkedOut: number };
export type AttendanceTodaySummary = {
  today: string;
  todayKind: { kind: "working" | "weekend" | "holiday"; label: string | null };
  workingHours: { start: string; end: string; graceMinutes: number };
  departments: AttendanceTodayDept[];
  totals: Omit<AttendanceTodayDept, "id" | "name">;
  /** People who checked in but did not check out on the last working day. */
  missedCheckOutYesterday: number;
  scope: { all: boolean; departments: string[] };
};

// v30: attendance corrections: the employee asks (missed check-in / check-out, wrong time); their manager or HR decides.
export const ATTENDANCE_CORRECTION_DAYS = 30;
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM");
export const attendanceCorrectionSchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose the day"),
    checkIn: hhmm,
    checkOut: hhmm,
    reason: z.string().trim().min(5, "Give a short reason (at least 5 characters)").max(500),
  })
  .refine((v) => v.checkOut > v.checkIn, { message: "Check-out must be after check-in", path: ["checkOut"] });
export type AttendanceCorrectionInput = z.infer<typeof attendanceCorrectionSchema>;
export type AttendanceCorrectionRow = {
  id: string;
  user: PersonRef;
  date: string;
  /** What was recorded before (null = nothing). */
  recorded: { checkIn: string | null; checkOut: string | null };
  requested: { checkIn: string; checkOut: string };
  reason: string;
  status: "pending" | "approved" | "rejected" | "cancelled";
  decidedBy: PersonRef | null;
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
  canDecide: boolean;
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
