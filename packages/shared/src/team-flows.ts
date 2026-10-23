// v10 team flows: onboarding/offboarding, timesheets, leave cover, global search, activity feed.
import { z } from "zod";

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
type Ref = { id: string; name: string };

// ---------------------------------------------------------------------------
// Onboarding & offboarding

export const TEAM_PROCESS_GROUPS = ["documents", "equipment", "accounts", "induction", "buddy", "handover", "access"] as const;
export type TeamProcessGroup = (typeof TEAM_PROCESS_GROUPS)[number];
export const TEAM_PROCESS_GROUP_LABELS: Record<TeamProcessGroup, string> = {
  documents: "Documents",
  equipment: "Laptop & equipment",
  accounts: "Accounts & tools",
  induction: "Induction SOPs to read",
  buddy: "Buddy",
  handover: "Hand over work",
  access: "Access",
};

export type TeamProcessItem = {
  key: string;
  label: string;
  group: TeamProcessGroup;
  done: boolean;
  doneAt: string | null;
  doneBy: string | null;
  /** Induction items point at an SOP the new hire must acknowledge ("I have read"). */
  sopId?: string | null;
  sopVersion?: number | null;
  /** Ticked by the system (SOP acknowledged, work reassigned, access suspended). */
  auto?: boolean;
};

export type TeamOpenWork = {
  tasks: { id: string; title: string; deadline: string | null; client: string | null }[];
  clients: { id: string; name: string }[];
  leads: { id: string; name: string; stage: string }[];
};

export type TeamPeopleProcess = {
  id: string;
  kind: "onboarding" | "offboarding";
  status: "open" | "done" | "cancelled";
  user: Ref & { email: string | null; department: string | null; role: string | null; status: string };
  startedBy: string | null;
  buddy: Ref | null;
  startDate: string | null;
  lastDay: string | null;
  items: TeamProcessItem[];
  doneCount: number;
  progressPct: number;
  note: string | null;
  createdAt: string;
  completedAt: string | null;
  suspendedAt: string | null;
  /** Offboarding only: work still owned by the leaver. */
  openWork?: TeamOpenWork;
  canEdit: boolean;
  /** Onboarding history only: how the viewer is part of it ("Added by you", "Reports to you", "Your department"…). */
  involvement?: string[];
};

export type TeamPeopleOptions = {
  staff: (Ref & { roles: string[]; department: string | null })[];
  sops: { id: string; title: string; department: string; version: number }[];
  roles: { id: string; name: string }[];
  departments: Ref[];
};

export const teamStartOnboardingSchema = z
  .object({
    userId: z.string().min(1).optional(),
    newHire: z
      .object({
        name: z.string().trim().min(2).max(120),
        email: z.email().optional(),
        phone: z.string().trim().max(20).optional(),
        roleId: z.string().min(1),
        departmentId: z.string().min(1).optional(),
        managerId: z.string().min(1).optional(),
      })
      .optional(),
    buddyId: z.string().min(1).optional(),
    startDate: isoDay.optional(),
    sopIds: z.array(z.string().min(1)).max(20).default([]),
    note: z.string().trim().max(500).optional(),
  })
  .refine((v) => !!v.userId !== !!v.newHire, { message: "Pick an existing person or enter a new hire" })
  .refine((v) => !v.newHire || !!v.newHire.email || !!v.newHire.phone, { message: "Enter the new hire's email or mobile number" });
export type TeamStartOnboarding = z.input<typeof teamStartOnboardingSchema>;

export const teamStartOffboardingSchema = z.object({
  userId: z.string().min(1),
  lastDay: isoDay,
  note: z.string().trim().max(500).optional(),
});
export type TeamStartOffboarding = z.infer<typeof teamStartOffboardingSchema>;

export const teamTickSchema = z.object({ key: z.string().min(1), done: z.boolean() });
export const teamAddItemSchema = z.object({ label: z.string().trim().min(2).max(200), group: z.enum(TEAM_PROCESS_GROUPS) });

export const teamReassignSchema = z.object({
  kind: z.enum(["tasks", "clients", "leads"]),
  ids: z.array(z.string().min(1)).min(1).max(500),
  toUserId: z.string().min(1),
});
export type TeamReassign = z.infer<typeof teamReassignSchema>;

// ---------------------------------------------------------------------------
// Timesheets

export const TEAM_TIME_CATEGORIES = ["task", "internal", "admin", "meeting", "training"] as const;
export type TeamTimeCategory = (typeof TEAM_TIME_CATEGORIES)[number];
export const TEAM_TIME_CATEGORY_LABELS: Record<TeamTimeCategory, string> = {
  task: "Client task",
  internal: "Internal work",
  admin: "Admin",
  meeting: "Meetings",
  training: "Training",
};

export type TeamTimesheetStatus = "draft" | "submitted" | "approved" | "returned";

export type TeamTimeEntry = {
  id: string;
  date: string;
  minutes: number;
  category: TeamTimeCategory;
  source: "task_log" | "manual";
  task: { id: string; title: string } | null;
  client: string | null;
  note: string | null;
};

export type TeamTimesheet = {
  id: string | null;
  user: Ref;
  weekStart: string;
  weekEnd: string;
  status: TeamTimesheetStatus;
  totalMinutes: number;
  days: { date: string; workingDay: boolean; taskMinutes: number; otherMinutes: number }[];
  byCategory: { category: TeamTimeCategory; minutes: number }[];
  entries: TeamTimeEntry[];
  submittedAt: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  comment: string | null;
  canEdit: boolean;
  canSubmit: boolean;
  canDecide: boolean;
  /** Services you worked on recently, for tagging manual time to a client (own editable week only). */
  clientOptions?: { engagementId: string; label: string }[];
};

export type TeamTimesheetRow = {
  id: string;
  user: Ref;
  weekStart: string;
  status: TeamTimesheetStatus;
  totalMinutes: number;
  submittedAt: string | null;
  decidedBy: string | null;
  comment: string | null;
  canDecide: boolean;
};

export const teamTimeEntrySchema = z.object({
  date: isoDay,
  minutes: z.number().int().min(5).max(16 * 60),
  category: z.enum(TEAM_TIME_CATEGORIES).exclude(["task"]),
  note: z.string().trim().max(300).optional(),
  /** Client work that is not on a task (e.g. a client call). Approved hours with a client feed that client's profitability. */
  engagementId: z.string().min(1).optional(),
});
export type TeamTimeEntryInput = z.infer<typeof teamTimeEntrySchema>;
export const teamSubmitTimesheetSchema = z.object({ weekStart: isoDay });
export const teamDecideTimesheetSchema = z
  .object({ decision: z.enum(["approve", "return"]), comment: z.string().trim().max(500).optional() })
  .refine((v) => v.decision === "approve" || !!v.comment, { message: "Say what needs fixing when you return a timesheet", path: ["comment"] });
export type TeamDecideTimesheet = z.infer<typeof teamDecideTimesheetSchema>;

// ---------------------------------------------------------------------------
// Leave cover

export type TeamLeaveCover = {
  leave: { id: string; user: Ref; from: string; to: string; type: string; status: string; stage: string };
  tasks: { id: string; title: string; deadline: string | null; client: string | null; href: string | null }[];
  people: (Ref & { onLeave: boolean; openTasks: number })[];
};

export type TeamWhoIsOut = { date: string; people: (Ref & { type: string; to: string })[] }[];

// ---------------------------------------------------------------------------
// Global search

export type TeamSearchKind = "client" | "lead" | "proposal" | "invoice" | "task" | "person" | "sop" | "project" | "request" | "creator";
/** v13: `fuzzy` marks a result found despite a typo or partial name (smart search). */
export type TeamSearchItem = { kind: TeamSearchKind; id: string; title: string; sub: string | null; href: string; fuzzy?: boolean };
export type TeamSearchResult = { q: string; groups: { kind: TeamSearchKind; label: string; items: TeamSearchItem[] }[] };

// ---------------------------------------------------------------------------
// Activity feed (AuditEvent)

export const TEAM_ACTIVITY_ENTITIES = ["ClientOrg", "Lead", "Engagement", "Invoice", "User", "Proposal", "Task", "Creator", "File"] as const;
export type TeamActivityEntity = (typeof TEAM_ACTIVITY_ENTITIES)[number];
export type TeamActivityItem = {
  id: string;
  at: string;
  actor: string | null;
  action: string;
  /** Plain-English sentence, e.g. "Asha moved the lead to Proposal sent". */
  summary: string;
  entity: string;
  entityId: string;
  changes: { field: string; before: string | null; after: string | null }[];
};
export type TeamActivityFeed = { items: TeamActivityItem[]; total: number; actors: string[] };

// ---------------------------------------------------------------------------
// Branding visible to every signed-in user (client app name and colours)

export type TeamBranding = { clientAppName: string; primary: string; accent: string; background: string; logoUrl: string; supportEmail: string; supportPhone: string; orgName: string };
