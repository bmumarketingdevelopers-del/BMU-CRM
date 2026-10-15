// v11 people & hierarchy actions: add / edit / move / change role / offboard people, create branches, departments,
// teams and client pods, custom roles, and the hierarchy tree. API: /people-actions/* (see api/people-actions.ts).
import { z } from "zod";
import { ACCESS_SCOPES, type AccessScope } from "./auth.js";
import { hierarchyData } from "./data/hierarchy.js";

export const PEOPLE_EMPLOYMENT_TYPES = ["full_time", "intern", "contract"] as const;
export type PeopleEmploymentType = (typeof PEOPLE_EMPLOYMENT_TYPES)[number];
export const peopleEmploymentLabels: Record<PeopleEmploymentType, string> = { full_time: "Full-time", intern: "Intern", contract: "Contract" };

/** Onboarding checklist parts HR can pick when adding a person. Documents are always included. */
export const PEOPLE_ONBOARDING_CHOICES = ["laptop", "accounts", "sop_reading", "shadowing"] as const;
export type PeopleOnboardingChoice = (typeof PEOPLE_ONBOARDING_CHOICES)[number];
export const peopleOnboardingLabels: Record<PeopleOnboardingChoice, string> = {
  laptop: "Laptop issued and set up",
  accounts: "Accounts (email, tools, BMU Hub)",
  sop_reading: "SOP reading for their department",
  shadowing: "Buddy and first-week shadowing",
};

export const PEOPLE_CAPABILITY_LABELS: Record<string, string> = {
  leads_pipeline: "Leads & pipeline",
  proposal_price_override: "Proposal price override",
  mark_rcd_gate1: "Mark RCD (Gate 1)",
  plan_and_calendar: "Plan & calendar",
  tasks_files: "Tasks & files",
  qc_pass_fail: "QC pass / fail",
  send_draft_to_client: "Send draft to client",
  approve_creative: "Approve creative",
  quote_addon: "Quote add-on",
  approve_addon_quote: "Approve add-on quote",
  invoices_payments: "Invoices & payments",
  revenue_margins: "Revenue & margins",
  users_roles_hierarchy: "Users, roles, hierarchy",
  catalogue_pricing_engine: "Catalogue & pricing",
  sop_checklists_flow_templates: "SOPs, checklists, flows",
  audit_log: "Audit log",
  credential_vault_reveal: "Credential vault reveal",
};
export const peopleScopeLabels: Record<AccessScope, string> = { none: "No access", own: "Own work", team: "Their team", department: "Their department", branch: "Their branch", all: "Everything" };

/** Rank from the hierarchy (1 = Founder … 7 = Intern; client roles 99). Lower number = more senior. */
export function peopleRoleRank(baseRole: string): number {
  return hierarchyData.team_roles.find((r) => r.id === baseRole)?.rank ?? 99;
}
/** The most senior rank among a set of base roles. */
export const peopleTopRank = (baseRoles: string[]) => (baseRoles.length ? Math.min(...baseRoles.map(peopleRoleRank)) : 99);

/** Merges role permissions: the widest scope wins (same as sign-in). */
export function peopleMergePermissions(roles: { permissions: { capability: string; scope: AccessScope }[] }[]): Record<string, AccessScope> {
  const rank = (s: AccessScope) => ACCESS_SCOPES.indexOf(s);
  const out: Record<string, AccessScope> = {};
  for (const r of roles) for (const p of r.permissions) if (!out[p.capability] || rank(p.scope) > rank(out[p.capability])) out[p.capability] = p.scope;
  return out;
}

export type PeoplePermissionDiffLine = { capability: string; label: string; before: AccessScope; after: AccessScope; change: "gain" | "lose" | "same" };
export function peoplePermissionDiff(before: Record<string, AccessScope>, after: Record<string, AccessScope>): PeoplePermissionDiffLine[] {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  const rank = (s: AccessScope) => ACCESS_SCOPES.indexOf(s);
  return keys
    .map((capability) => {
      const b = before[capability] ?? "none";
      const a = after[capability] ?? "none";
      return { capability, label: PEOPLE_CAPABILITY_LABELS[capability] ?? capability, before: b, after: a, change: rank(a) > rank(b) ? ("gain" as const) : rank(a) < rank(b) ? ("lose" as const) : ("same" as const) };
    })
    .sort((x, y) => x.label.localeCompare(y.label));
}

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a date");
const reason = z.string().trim().min(3, "Give a short reason (at least 3 characters)").max(500);
const phone = z
  .string()
  .trim()
  .refine((v) => /^(\+?91)?[6-9]\d{9}$/.test(v.replace(/[\s-]/g, "")), "Enter a 10-digit Indian mobile number");

export const peopleAddPersonSchema = z.object({
  name: z.string().trim().min(2, "Enter their full name").max(120),
  phone,
  email: z.email("Enter a valid email address").trim().toLowerCase(),
  roleIds: z.array(z.string().min(1)).min(1, "Pick at least one role").max(4),
  departmentId: z.string().min(1, "Pick a department"),
  teamId: z.string().min(1).nullable().optional(),
  managerId: z.string().min(1, "Pick who they report to"),
  branchId: z.string().min(1, "Pick a branch"),
  joiningDate: ymd,
  employmentType: z.enum(PEOPLE_EMPLOYMENT_TYPES, "Pick the employment type"),
  specialty: z.string().trim().toLowerCase().regex(/^[a-z][a-z_]{1,39}$/).nullable().optional(),
  onboarding: z
    .object({
      enabled: z.boolean().default(true),
      items: z.array(z.enum(PEOPLE_ONBOARDING_CHOICES)).default([...PEOPLE_ONBOARDING_CHOICES]),
      buddyId: z.string().min(1).nullable().optional(),
      sopIds: z.array(z.string()).max(30).optional(),
    })
    .default({ enabled: true, items: [...PEOPLE_ONBOARDING_CHOICES] }),
  sendInvite: z.boolean().default(true),
  note: z.string().trim().max(500).optional(),
});
export type PeopleAddPerson = z.input<typeof peopleAddPersonSchema>;

export const peopleEditPersonSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  email: z.email("Enter a valid email address").trim().toLowerCase().nullable().optional(),
  phone: phone.nullable().optional(),
  photoUrl: z.url("Paste a link to the photo").max(500).nullable().optional(),
  specialty: z.string().trim().toLowerCase().regex(/^[a-z][a-z_]{1,39}$/).nullable().optional(),
  joiningDate: ymd.nullable().optional(),
  employmentType: z.enum(PEOPLE_EMPLOYMENT_TYPES).nullable().optional(),
});
export type PeopleEditPerson = z.infer<typeof peopleEditPersonSchema>;

export const peopleMoveSchema = z.object({
  departmentId: z.string().min(1, "Pick a department"),
  teamId: z.string().min(1).nullable().optional(),
  managerId: z.string().min(1).nullable().optional(),
  branchId: z.string().min(1).nullable().optional(),
  effectiveDate: ymd,
  reason,
  /** keep = the person keeps their open work; reassign = the web opens the reassignment engine after the move. */
  openWork: z.enum(["keep", "reassign"]).default("keep"),
});
export type PeopleMove = z.input<typeof peopleMoveSchema>;

export const peopleChangeRoleSchema = z.object({
  /** First = main role; the rest are secondary roles. */
  roleIds: z.array(z.string().min(1)).min(1, "Pick at least one role").max(4),
  effectiveDate: ymd,
  reason,
});
export type PeopleChangeRole = z.infer<typeof peopleChangeRoleSchema>;

export const peopleOffboardSchema = z.object({ lastDay: ymd, reason, note: z.string().trim().max(1000).optional() });
export type PeopleOffboard = z.infer<typeof peopleOffboardSchema>;

export const PEOPLE_HANDOVER_KINDS = ["approvals", "briefs"] as const;
export const peopleHandoverSchema = z.object({ kind: z.enum(PEOPLE_HANDOVER_KINDS), toUserId: z.string().min(1, "Pick who takes over") });

export const peopleWorkingHoursSchema = z.object({
  start: z.string().regex(/^\d{2}:\d{2}$/, "Use HH:MM"),
  end: z.string().regex(/^\d{2}:\d{2}$/, "Use HH:MM"),
  days: z.array(z.number().int().min(0).max(6)).min(1, "Pick at least one working day"),
});

export const peopleCreateUnitSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("branch"), name: z.string().trim().min(2, "Enter a name").max(80), city: z.string().trim().min(2, "Enter the city").max(80), workingHours: peopleWorkingHoursSchema }),
  z.object({
    kind: z.literal("department"),
    name: z.string().trim().min(2, "Enter a name").max(80),
    branchId: z.string().min(1, "Pick the branch"),
    headUserId: z.string().min(1, "Pick the department head"),
    copyFlowTemplateIds: z.array(z.string()).max(30).default([]),
    copyQcChecklistIds: z.array(z.string()).max(30).default([]),
  }),
  z.object({ kind: z.literal("team"), name: z.string().trim().min(2, "Enter a name").max(80), departmentId: z.string().min(1, "Pick the department"), leadUserId: z.string().min(1, "Pick the team lead") }),
]);
export type PeopleCreateUnit = z.input<typeof peopleCreateUnitSchema>;

export const peoplePodSchema = z.object({
  name: z.string().trim().min(2, "Enter the pod name").max(80),
  amUserId: z.string().min(1, "Pick the client manager"),
  strategistUserId: z.string().min(1, "Pick the strategist"),
  producerIds: z.array(z.string().min(1)).min(1, "Pick at least one producer").max(20),
  clientIds: z.array(z.string().min(1)).min(1, "Pick at least one client").max(100),
});
export type PeoplePodInput = z.infer<typeof peoplePodSchema>;

export const peopleCustomRoleSchema = z.object({
  name: z.string().trim().min(2, "Name the role").max(60),
  cloneFromRoleId: z.string().min(1, "Pick the role to start from"),
  scopes: z.record(z.string(), z.enum(ACCESS_SCOPES)).default({}),
});
export type PeopleCustomRole = z.input<typeof peopleCustomRoleSchema>;

export const peopleBulkSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("move"), userIds: z.array(z.string()).min(1).max(100), move: peopleMoveSchema }),
  z.object({ action: z.literal("add_role"), userIds: z.array(z.string()).min(1).max(100), roleId: z.string().min(1), effectiveDate: ymd, reason }),
]);
export type PeopleBulk = z.input<typeof peopleBulkSchema>;

// ---------------------------------------------------------------------------
// Views

export type PeopleRef = { id: string; name: string };
export type PeopleRoleOption = { id: string; name: string; baseRole: string; isCustom: boolean; rank: number; assignable: boolean; needsApproval: boolean; whyNot: string | null; permissions: { capability: string; scope: AccessScope }[] };
export type PeopleOptions = {
  roles: PeopleRoleOption[];
  branches: { id: string; name: string; city: string; workStart: string | null; workEnd: string | null; workDays: number[] }[];
  departments: { id: string; name: string; branchId: string; headId: string | null; teams: { id: string; name: string; leadId: string | null }[] }[];
  staff: { id: string; name: string; departmentId: string | null; teamId: string | null; roles: string[] }[];
  sops: { id: string; title: string; departmentId: string }[];
  flowTemplates: { id: string; name: string; department: string }[];
  qcChecklists: { id: string; name: string; department: string | null }[];
  clients: { id: string; name: string; podId: string | null }[];
  can: PeopleCan;
  me: { id: string; departmentId: string | null };
};
export type PeopleCan = {
  /** The Founder and HR only. */
  addPerson: boolean;
  /** HR members other than the HR Department Head: adds wait for a Founder or the HR Department Head. */
  addNeedsApproval: boolean;
  addUnit: boolean;
  addPod: boolean;
  move: boolean;
  changeRole: boolean;
  offboard: boolean;
  reassignWork: boolean;
  customRole: boolean;
  import: boolean;
  edit: boolean;
};

export type PeoplePersonRow = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  photoUrl: string | null;
  status: string;
  roles: { id: string; name: string; baseRole: string }[];
  department: PeopleRef | null;
  team: PeopleRef | null;
  manager: PeopleRef | null;
  branch: PeopleRef | null;
  joiningDate: string | null;
  employmentType: PeopleEmploymentType | null;
  specialty: string | null;
  loadPct: number | null;
  openTasks: number;
  onLeaveToday: boolean;
  nextLeave: string | null;
  leftAt: string | null;
  pending: { scheduled: number; approvals: number };
};

export type PeopleOpenRecords = {
  tasks: { id: string; title: string; deadline: string | null; href: string }[];
  clients: { id: string; title: string; href: string }[];
  engagements: { id: string; title: string; href: string }[];
  leads: { id: string; title: string; href: string }[];
  requests: { id: string; title: string; href: string }[];
  approvals: { id: string; title: string; href: string }[];
  briefs: { id: string; title: string; href: string }[];
  total: number;
};

export type PeoplePersonDetail = PeoplePersonRow & {
  reports: PeopleRef[];
  scheduled: { id: string; kind: "move" | "role"; effectiveDate: string; summary: string; reason: string; by: string }[];
  approvals: { id: string; summary: string; status: string; actionLabel: string }[];
  onboardingId: string | null;
  offboardingId: string | null;
  openRecords: PeopleOpenRecords;
  permissions: { capability: string; label: string; scope: AccessScope }[];
  can: PeopleCan & { self: boolean };
};

export type PeopleTree = {
  org: { name: string };
  branches: {
    id: string;
    name: string;
    city: string;
    workStart: string | null;
    workEnd: string | null;
    departments: {
      id: string;
      name: string;
      head: PeopleRef | null;
      teams: { id: string; name: string; lead: PeopleRef | null; memberIds: string[] }[];
      memberIds: string[];
    }[];
  }[];
  people: PeoplePersonRow[];
  /** People with no department (shown under the branch). */
  unplacedIds: string[];
  pods: PeoplePod[];
  former: PeoplePersonRow[];
  can: PeopleCan;
  me: { id: string; departmentId: string | null };
};

export type PeoplePod = { id: string; name: string; am: PeopleRef | null; strategist: PeopleRef | null; producers: PeopleRef[]; clients: PeopleRef[] };

export type PeopleMovePreview = {
  person: PeopleRef;
  from: { department: string | null; team: string | null; manager: string | null; branch: string | null };
  to: { department: string | null; team: string | null; manager: string | null; branch: string | null };
  gains: string[];
  loses: string[];
  openWork: { tasks: number; clients: number; leads: number; total: number };
  crossDepartment: boolean;
  scheduled: boolean;
  needsApproval: { approver: string; why: string } | null;
  blocked: string | null;
};

export type PeopleRolePreview = {
  person: PeopleRef;
  before: string[];
  after: string[];
  diff: PeoplePermissionDiffLine[];
  scheduled: boolean;
  needsApproval: { approver: string; why: string } | null;
  blocked: string | null;
};

export type PeopleMutationResult = {
  ok: true;
  id: string | null;
  /** Applied now, scheduled for the effective date, or sent for approval. */
  outcome: "applied" | "scheduled" | "approval";
  message: string;
  approval: { id: string; summary: string } | null;
  undo: { token: string; label: string; expiresAt: string } | null;
};

export type PeopleOffboardingStatus = {
  person: PeopleRef;
  processId: string | null;
  lastDay: string | null;
  status: string | null;
  openRecords: PeopleOpenRecords;
  pendingItems: string[];
  canConfirm: boolean;
  confirmNeedsAdmin: boolean;
  blockers: string[];
};

export type PeopleDuplicate = { id: string; name: string; match: "email" | "phone" | "name"; status: string };
export * from "./api/people-actions.js";
