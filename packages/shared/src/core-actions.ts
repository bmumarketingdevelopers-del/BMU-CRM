// v11 core: the shared action system (reassignment engine, approvals, undo, drafts, saved views, watchers, tags,
// imports, archive) and the task actions built on it. Every name here starts with `core`/`Core` so other areas'
// shared files never clash. Other builders: see docs/flows/core-actions.md, "How to plug in".
import { z } from "zod";
import { TASK_STATUSES, type TaskStatus, type TaskView } from "./production.js";

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-10-05");
const dateOrDay = z.string().refine((v) => /^\d{4}-\d{2}-\d{2}$/.test(v) || !Number.isNaN(Date.parse(v)), "Pick a valid date");
type Ref = { id: string; name: string };

// ---------------------------------------------------------------------------
// Roles

/** Leadership sees and manages everything. */
export const CORE_LEADERSHIP_ROLES = ["founder", "admin", "am_lead"] as const;
/** Roles that may add tasks for other people (producers can only add for themselves or as subtasks). */
export const CORE_TASK_MANAGER_ROLES = ["founder", "admin", "am_lead", "department_head", "account_manager", "strategist"] as const;
/** Roles that may change a deadline (producers can only request a change). */
export const CORE_DEADLINE_ROLES = ["founder", "admin", "am_lead", "department_head", "account_manager", "strategist"] as const;
/** Roles that may archive / cancel a task. */
export const CORE_ARCHIVE_ROLES = ["founder", "admin", "am_lead", "department_head", "account_manager"] as const;
/** Roles that may add tasks from a flow template. */
export const CORE_TEMPLATE_ROLES = ["founder", "admin", "am_lead", "department_head", "strategist", "account_manager"] as const;
/** Roles that may set up recurring tasks. */
export const CORE_RECURRING_ROLES = ["founder", "admin", "am_lead", "department_head", "account_manager"] as const;
/** Roles that may override "on leave" and approve over-capacity assignments. */
export const CORE_OVERRIDE_ROLES = ["founder", "admin", "department_head"] as const;

const hasAny = (roles: readonly string[], allowed: readonly string[]) => roles.some((r) => allowed.includes(r));
export const coreIsLeadership = (me: { roles: string[] }) => hasAny(me.roles, CORE_LEADERSHIP_ROLES);
export const coreCanManageTasks = (me: { type?: string; roles: string[] }) => me.type !== "client" && me.type !== "creator" && hasAny(me.roles, CORE_TASK_MANAGER_ROLES);
export const coreCanChangeDeadline = (me: { roles: string[] }) => hasAny(me.roles, CORE_DEADLINE_ROLES);
export const coreCanArchiveTasks = (me: { roles: string[] }) => hasAny(me.roles, CORE_ARCHIVE_ROLES);
export const coreCanUseTemplates = (me: { roles: string[] }) => hasAny(me.roles, CORE_TEMPLATE_ROLES);
export const coreCanRecur = (me: { roles: string[] }) => hasAny(me.roles, CORE_RECURRING_ROLES);
export const coreCanOverride = (me: { roles: string[] }) => hasAny(me.roles, CORE_OVERRIDE_ROLES);
/** Anyone on the team can add a task (producers only for themselves). */
export const coreCanAddTask = (me: { type?: string }) => me.type === "staff";

// ---------------------------------------------------------------------------
// Reassignment engine

export const CORE_REASSIGN_REASONS = ["leave", "overload", "skill_fit", "quality_issue", "priority_change", "offboarding", "client_request", "other"] as const;
export type CoreReassignReason = (typeof CORE_REASSIGN_REASONS)[number];
export const coreReassignReasonLabels: Record<CoreReassignReason, string> = {
  leave: "Leave",
  overload: "Overload",
  skill_fit: "Skill fit",
  quality_issue: "Quality issue",
  priority_change: "Priority change",
  offboarding: "Offboarding",
  client_request: "Client request",
  other: "Other",
};

/** Built-in target types. Other areas register more (lead, client_am, request, creator_brief, engagement roles…). */
export const CORE_REASSIGN_TYPES = ["task", "deliverable", "qc"] as const;

export const coreDeadlineHandlingSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("keep") }),
  z.object({ mode: z.literal("extend"), days: z.number().int().min(1, "Extend by at least 1 working day").max(60) }),
  z.object({ mode: z.literal("set"), date: dateOrDay }),
]);
export type CoreDeadlineHandling = z.infer<typeof coreDeadlineHandlingSchema>;

export const coreReassignApplySchema = z.object({
  ids: z.array(z.string().min(1)).min(1, "Pick at least one item").max(500),
  toUserId: z.string().min(1, "Pick the new owner"),
  reason: z.enum(CORE_REASSIGN_REASONS, { message: "Pick a reason" }),
  note: z.string().trim().max(2000).optional(),
  handoverNote: z.string().trim().max(4000).optional(),
  deadline: coreDeadlineHandlingSchema.default({ mode: "keep" }),
  /** Department Head / Admin: assign even though the person is on leave on the deadline date. */
  overrideLeave: z.boolean().optional(),
  /** Seat for multi-role targets (engagement: am | strategist | producer). */
  role: z.string().max(40).optional(),
});
export type CoreReassignApply = z.input<typeof coreReassignApplySchema>;

export const coreReassignPreviewSchema = coreReassignApplySchema.pick({ ids: true, toUserId: true, deadline: true, role: true }).extend({ reason: z.enum(CORE_REASSIGN_REASONS).optional() });
export type CoreReassignPreviewInput = z.input<typeof coreReassignPreviewSchema>;

/** One eligible person in the picker. */
export type CoreCandidate = {
  id: string;
  name: string;
  role: string | null;
  department: string | null;
  specialty: string | null;
  skills: string[];
  /** Open task hours in the next 7 days vs capacity (after leave), before this assignment. */
  loadPct: number;
  /** Load % if the selected work moves to them. */
  loadAfterPct: number;
  openTasks: number;
  hoursOpen: number;
  capacityHours: number;
  /** On approved leave on (one of) the deadline date(s). */
  onLeave: boolean;
  leaveNote: string | null;
  onLeaveToday: boolean;
  /** Best fit by specialty, department and load. */
  suggested: boolean;
  /** The current owner (shown, not selectable). */
  current: boolean;
  /** Why they can't be picked at all (wrong role for QC, uploaded the version…). */
  blockedReason: string | null;
};

export type CoreCandidates = {
  type: string;
  label: string;
  items: { id: string; title: string; ownerId: string | null; ownerName: string | null; deadline: string | null; status: string | null; inProgress: boolean }[];
  candidates: CoreCandidate[];
  /** Roles/seats for multi-seat targets (engagement); empty for single-owner types. */
  roles: { key: string; label: string }[];
  canOverrideLeave: boolean;
  reasons: { key: CoreReassignReason; label: string }[];
};

export type CoreImpactLevel = "info" | "warning" | "approval" | "blocked";
export type CoreImpactLine = { level: CoreImpactLevel; text: string };

export type CoreReassignPreview = {
  to: Ref & { loadPct: number; loadAfterPct: number; onLeave: boolean };
  items: { id: string; title: string; from: string | null; deadlineFrom: string | null; deadlineTo: string | null; atRisk: boolean; clientFacing: boolean; dependents: string[]; inProgress: boolean }[];
  impact: CoreImpactLine[];
  /** A handover note is required (in-progress work). */
  needsHandover: boolean;
  /** The change will go to the Department Head for approval instead of applying now. */
  needsApproval: { approver: string | null; why: string } | null;
  /** The change can't be made (e.g. on leave without override). */
  blocked: string | null;
};

export type CoreUndo = { token: string; label: string; expiresAt: string };

export type CoreReassignResult = {
  ok: true;
  applied: number;
  /** Set when the change waits for approval instead. */
  approval: { id: string; approver: string | null; summary: string } | null;
  undo: CoreUndo | null;
  message: string;
};

export const coreBulkReassignSchema = z.object({
  fromUserId: z.string().min(1),
  reason: z.enum(CORE_REASSIGN_REASONS, { message: "Pick a reason" }),
  note: z.string().trim().max(2000).optional(),
  handoverNote: z.string().trim().max(4000).optional(),
  /** Each line moves some items to one person (split), or everything to one person. */
  moves: z
    .array(z.object({ toUserId: z.string().min(1), items: z.array(z.object({ type: z.string().min(1), id: z.string().min(1) })).min(1) }))
    .min(1, "Pick who takes the work"),
  overrideLeave: z.boolean().optional(),
});
export type CoreBulkReassign = z.input<typeof coreBulkReassignSchema>;

export type CoreOpenWork = {
  user: Ref;
  groups: { type: string; label: string; items: { id: string; title: string; deadline: string | null; status: string | null; client: string | null }[] }[];
  candidates: CoreCandidate[];
};

// ---------------------------------------------------------------------------
// Approvals

export const CORE_APPROVAL_STATUSES = ["pending", "approved", "rejected", "expired", "cancelled"] as const;
export type CoreApprovalStatus = (typeof CORE_APPROVAL_STATUSES)[number];
export const coreApprovalStatusLabels: Record<CoreApprovalStatus, string> = { pending: "Waiting", approved: "Approved", rejected: "Rejected", expired: "Expired", cancelled: "Withdrawn" };
/** Approvals expire after 72 working hours. */
export const CORE_APPROVAL_EXPIRY_WORKING_HOURS = 72;

export type CoreApprovalView = {
  id: string;
  action: string;
  actionLabel: string;
  targetType: string;
  targetId: string;
  targetHref: string | null;
  summary: string;
  reason: string | null;
  requestedBy: Ref;
  approver: Ref | null;
  approverRoles: string[];
  status: CoreApprovalStatus;
  decisionNote: string | null;
  decidedBy: Ref | null;
  decidedAt: string | null;
  createdAt: string;
  expiresAt: string;
  /** What the approver needs to provide when approving (e.g. a new owner for a hand-back). */
  approveNeeds: "none" | "assignee";
  canDecide: boolean;
  canCancel: boolean;
  /** Before → after lines for display. */
  diff: { field: string; before: string | null; after: string | null }[];
};

export const coreDecideApprovalSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  note: z.string().trim().max(2000).optional(),
  /** Extra input some handlers need on approve, e.g. { toUserId } for a hand-back. */
  input: z.record(z.string(), z.unknown()).optional(),
});
export type CoreDecideApproval = z.infer<typeof coreDecideApprovalSchema>;

// ---------------------------------------------------------------------------
// Drafts, saved views, watchers, tags

export const coreDraftSchema = z.object({ key: z.string().min(1).max(200).default("new"), payload: z.record(z.string(), z.unknown()) });
export type CoreDraft = { entity: string; key: string; payload: Record<string, unknown>; updatedAt: string };

export const coreSavedViewSchema = z.object({
  name: z.string().trim().min(1, "Name the view").max(80),
  filters: z.record(z.string(), z.unknown()).default({}),
  columns: z.array(z.string()).default([]),
  isShared: z.boolean().default(false),
});
export type CoreSavedViewInput = z.input<typeof coreSavedViewSchema>;
export type CoreSavedView = { id: string; entity: string; name: string; filters: Record<string, unknown>; columns: string[]; isShared: boolean; mine: boolean; owner: string };

export type CoreWatchers = { watching: boolean; people: Ref[] };

export const CORE_TAG_COLORS = ["neutral", "green", "amber", "red", "dark"] as const;
export const coreTagSchema = z.object({ name: z.string().trim().min(1, "Name the tag").max(40), color: z.enum(CORE_TAG_COLORS).default("neutral") });
export type CoreTag = { id: string; name: string; color: (typeof CORE_TAG_COLORS)[number] };
export const coreSetTagsSchema = z.object({ tagIds: z.array(z.string()).max(30).default([]), names: z.array(z.string().trim().min(1).max(40)).max(10).default([]) });

export const coreArchiveSchema = z.object({ reason: z.string().trim().min(3, "Give a short reason (at least 3 characters)").max(500) });

// ---------------------------------------------------------------------------
// CSV import

export type CoreImportField = { key: string; label: string; required: boolean; hint?: string };
export type CoreImportEntityInfo = { entity: string; label: string; fields: CoreImportField[]; sampleCsv: string };
export const coreImportPreviewSchema = z.object({
  csv: z.string().min(1, "The file is empty").max(5_000_000, "The file is too big (5 MB max)"),
  fileName: z.string().max(200).optional(),
  /** { "CSV column": "fieldKey" }; columns left out are ignored. */
  mapping: z.record(z.string(), z.string()).optional(),
});
export type CoreImportRow = { row: number; ok: boolean; errors: string[]; duplicate: string | null; values: Record<string, string> };
export type CoreImportJob = {
  id: string;
  entity: string;
  fileName: string | null;
  status: "preview" | "committed" | "cancelled";
  columns: string[];
  mapping: Record<string, string>;
  rowsTotal: number;
  rowsOk: number;
  rowsFailed: number;
  rows: CoreImportRow[];
  createdAt: string;
  committedAt: string | null;
  by: string;
};
export const coreImportCommitSchema = z.object({ skipDuplicates: z.boolean().default(true) });

/** Tiny CSV parser (quotes, commas, CRLF). Shared by the API and the import wizard preview. */
export function coreParseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/** One CSV line, quoting where needed. */
export const coreCsvLine = (cells: (string | number | null | undefined)[]) =>
  cells.map((c) => {
    const s = c === null || c === undefined ? "" : String(c);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(",");

// ---------------------------------------------------------------------------
// Tasks

export const CORE_TASK_PRIORITIES = ["urgent", "high", "normal", "low"] as const;
export type CoreTaskPriority = (typeof CORE_TASK_PRIORITIES)[number];
export const CORE_INTERNAL_CATEGORIES = ["training", "admin", "pitch", "internal"] as const;

const checklistItem = z.object({ id: z.string().min(1).max(40), label: z.string().trim().min(1).max(200), done: z.boolean().default(false) });

export const coreTaskCreateBase = z.object({
  title: z.string().trim().min(3, "Give the task a title (at least 3 characters)").max(200),
  /** Client work: the engagement. Leave empty and set internal for internal work. */
  engagementId: z.string().optional().nullable(),
  internal: z.boolean().default(false),
  departmentId: z.string().min(1, "Pick a department"),
  /** v32: several departments: each Department Head gets their own copy (Founder, Branch Manager, client leads). */
  departmentIds: z.array(z.string().min(1)).max(30).optional(),
  ownerId: z.string().min(1, "Pick who will do it"),
  deadline: dateOrDay,
  priority: z.enum(CORE_TASK_PRIORITIES).default("normal"),
  // More details
  description: z.string().trim().max(10_000).optional(),
  brief: z.string().trim().max(10_000).optional(),
  references: z.array(z.string().trim().max(500)).max(20).default([]),
  checklist: z.array(checklistItem).max(50).default([]),
  subtasks: z.array(z.object({ title: z.string().trim().min(2).max(200), ownerId: z.string().optional(), deadline: dateOrDay.optional() })).max(30).default([]),
  dependsOn: z.array(z.string()).max(20).default([]),
  estimateHours: z.number().min(0.25).max(500).optional(),
  attachmentIds: z.array(z.string()).max(20).default([]),
  deliverableId: z.string().optional().nullable(),
  watcherIds: z.array(z.string()).max(30).default([]),
  parentId: z.string().optional().nullable(),
  preProduction: z.boolean().default(false),
  outOfScope: z.boolean().default(false),
  addOnRequestId: z.string().optional().nullable(),
  specialty: z.string().max(40).optional().nullable(),
  /** Save as draft (the author's own choice). */
  draft: z.boolean().default(false),
  /** Created from a message / comment: { type: "message" | "comment", id }. */
  source: z.object({ type: z.enum(["message", "comment"]), id: z.string() }).optional(),
  /** Recurring task: creates the rule and the instances for the next 7 days instead of one task. */
  repeat: z
    .object({ rule: z.enum(["daily", "weekly", "monthly", "cycle_start"]), dayOf: z.number().int().min(0).max(31).optional(), end: isoDay })
    .optional(),
  /** Department Head / Admin: assign even though the person is on leave on the deadline. */
  overrideLeave: z.boolean().optional(),
});
export const coreTaskCreateSchema = coreTaskCreateBase.refine((v) => v.internal || !!v.engagementId, { message: "Pick the client engagement, or mark the task Internal", path: ["engagementId"] });
export type CoreTaskCreate = z.input<typeof coreTaskCreateSchema>;

/** "Save as draft" skips the required-field rules (only a title is needed). */
export const coreTaskDraftSchema = coreTaskCreateBase.partial().extend({ title: z.string().trim().min(3, "Give the task a title (at least 3 characters)").max(200), deadline: dateOrDay.optional().or(z.literal("")) });

export const coreTaskEditSchema = z.object({
  title: z.string().trim().min(3).max(200).optional(),
  description: z.string().trim().max(10_000).nullable().optional(),
  brief: z.string().trim().max(10_000).nullable().optional(),
  references: z.array(z.string().trim().max(500)).max(20).optional(),
  checklist: z.array(checklistItem).max(50).optional(),
  estimateHours: z.number().min(0.25).max(500).nullable().optional(),
  priority: z.enum(CORE_TASK_PRIORITIES).optional(),
  departmentId: z.string().optional(),
  deliverableId: z.string().nullable().optional(),
  preProduction: z.boolean().optional(),
});
export type CoreTaskEdit = z.infer<typeof coreTaskEditSchema>;
export const CORE_TASK_EDIT_KEYS = Object.keys(coreTaskEditSchema.shape) as (keyof CoreTaskEdit)[];

export const coreTaskDeadlineSchema = z.object({
  deadline: dateOrDay,
  reason: z.string().trim().min(3, "Give a short reason (at least 3 characters)").max(500),
});

export const coreTaskBlockedSchema = z.object({
  reason: z.string().trim().min(3, "Say why it is blocked (at least 3 characters)").max(500),
  waitingFor: z.string().trim().min(2, "Say what you are waiting for").max(200),
  responsibleId: z.string().min(1, "Pick who is responsible for unblocking it").optional().nullable(),
  responsibleName: z.string().trim().max(120).optional(),
  expectedAt: isoDay,
});

export const coreTaskStatusSchema = z.object({
  status: z.enum(TASK_STATUSES),
  blocked: coreTaskBlockedSchema.optional(),
});

export const coreTaskHandbackSchema = z.object({ reason: z.string().trim().min(3, "Say why you can't take it").max(500) });
export const coreTaskDuplicateSchema = z.object({ withSubtasks: z.boolean().default(true), count: z.number().int().min(1).max(20).default(1) });
export const coreTaskDependencySchema = z.object({ dependsOnId: z.string().min(1) });
export const coreTaskActivateSchema = z.object({ addOnRequestId: z.string().min(1, "Pick the approved add-on request") });

export const CORE_TASK_BULK_ACTIONS = ["status", "deadline", "tag", "archive", "priority"] as const;
export const coreTaskBulkSchema = z.object({
  ids: z.array(z.string().min(1)).min(1, "Select at least one task").max(500),
  action: z.enum(CORE_TASK_BULK_ACTIONS),
  status: z.enum(TASK_STATUSES).optional(),
  deadline: dateOrDay.optional(),
  priority: z.enum(CORE_TASK_PRIORITIES).optional(),
  tag: z.string().trim().min(1).max(40).optional(),
  reason: z.string().trim().max(500).optional(),
});
export type CoreTaskBulk = z.input<typeof coreTaskBulkSchema>;

export const coreTemplatePreviewSchema = z.object({
  templateId: z.string().min(1, "Pick a template"),
  engagementId: z.string().optional().nullable(),
  deliverableId: z.string().optional().nullable(),
  title: z.string().trim().max(200).optional(),
  startDate: isoDay,
  /** { role: userId } */
  people: z.record(z.string(), z.string()).default({}),
});
export type CoreTemplatePreviewInput = z.input<typeof coreTemplatePreviewSchema>;
export type CoreTemplatePreview = {
  template: { id: string; name: string; department: string | null };
  roles: { role: string; label: string; userId: string | null; userName: string | null; options: CoreCandidate[] }[];
  tasks: { step: string; title: string; role: string; ownerId: string | null; ownerName: string | null; deadline: string; kind: string; dependsOnStep: string | null }[];
  warnings: string[];
};

export const CORE_REPEAT_RULES = ["daily", "weekly", "monthly", "cycle_start"] as const;
export const coreRepeatRuleLabels: Record<(typeof CORE_REPEAT_RULES)[number], string> = { daily: "Every working day", weekly: "Every week", monthly: "Every month", cycle_start: "At each cycle start (1st of the month)" };
export type CoreRecurrence = { id: string; title: string; rule: string; ruleLabel: string; dayOf: number | null; owner: string | null; startDate: string; endDate: string | null; nextDates: string[]; active: boolean };

/** What the current user may do on one task (drives RowMenu and detail buttons; the server checks again). */
export type CoreTaskCan = {
  edit: boolean;
  reassign: boolean;
  /** Producers: they can ask a manager instead of changing it. */
  deadline: "change" | "request" | null;
  status: boolean;
  duplicate: boolean;
  archive: boolean;
  restore: boolean;
  handback: boolean;
  addSubtask: boolean;
  /** Disabled-with-reason (gate blocked etc.). */
  blocked: Partial<Record<"edit" | "reassign" | "deadline" | "status" | "archive" | "duplicate", string>>;
};

export type CoreTaskRow = TaskView & {
  priority: string;
  departmentId: string | null;
  department: string | null;
  archivedAt: string | null;
  archivedReason: string | null;
  isDraft: boolean;
  draftReason: string | null;
  isInternal: boolean;
  parentId: string | null;
  subtaskCount: number;
  subtasksOpen: number;
  /** "Waiting" label when a predecessor is not done. */
  waitingOn: string[];
  tags: CoreTag[];
  can: CoreTaskCan;
};

export type CoreTaskDetail = CoreTaskRow & {
  description: string | null;
  brief: string | null;
  references: string[];
  /** v38: files sent on the task (the owner, creator, watchers and leadership see them, also in Files). */
  files?: { id: string; name: string; url: string; mimeType: string | null; sizeBytes: number | null; by?: string; at?: string }[];
  checklist: { id: string; label: string; done: boolean }[];
  estimateHours: number | null;
  preProduction: boolean;
  outOfScope: boolean;
  addOnRequestId: string | null;
  engagement: { id: string; client: string; service: string; gate: string } | null;
  parent: { id: string; title: string } | null;
  subtasks: CoreTaskRow[];
  dependencies: { id: string; title: string; status: TaskStatus }[];
  dependents: { id: string; title: string; status: TaskStatus }[];
  watchers: Ref[];
  blocked: { reason: string | null; waitingFor: string | null; responsible: string | null; expectedAt: string | null; since: string | null } | null;
  assignments: { id: string; at: string; from: string | null; to: string | null; by: string; reason: string; note: string | null; handoverNote: string | null }[];
  pendingApprovals: { id: string; action: string; summary: string; status: string }[];
  createdBy: string | null;
  createdAt: string;
};

export type CoreTaskQuery = {
  q?: string;
  scope?: "mine" | "team";
  ownerId?: string;
  clientId?: string;
  departmentId?: string;
  status?: string;
  from?: string;
  to?: string;
  archived?: "1";
  drafts?: "1";
  /** Every completed task, however long ago (newest first). "Open and recent" only keeps the last 30 days. */
  completed?: "1";
  tag?: string;
};

export type CoreTaskMutation = { task: CoreTaskDetail; undo: CoreUndo | null; message?: string; approval?: { id: string; summary: string } | null };

export type CoreTaskFormOptions = {
  engagements: { id: string; client: string; clientId: string; service: string; gate: string; productionOpen: boolean; amId: string | null; departmentIds: string[]; /** v11 people: the client pod's members (producers, strategist, CM), the default assignees. */ podMemberIds?: string[] }[];
  /** v32: with each department's head (tasks from the Founder, Branch Manager and client leads go to the head). */
  departments: (Ref & { head?: Ref | null })[];
  deliverables: { id: string; title: string; engagementId: string }[];
  addOnRequests: { id: string; engagementId: string; description: string }[];
  templates: { id: string; name: string; department: string | null; steps: number }[];
  people: (Ref & { departmentId: string | null; roles: string[] })[];
  /** The current user can assign to others (producers can't). */
  canAssignOthers: boolean;
  me: Ref & { departmentId: string | null };
  /** v32: "self" = team members (only themselves); "team" = Department Heads (their team or themselves); "heads" = everyone else (the chosen departments' heads). */
  assignMode?: "self" | "team" | "heads";
  /** v32: a Department Head's own department(s). */
  teamDepartmentIds?: string[];
};

// ---------------------------------------------------------------------------
// Command palette: plain-language actions ("new task for Aroma", "reassign Reel 03 to Arjun", "add user to Design").

export type CorePaletteIntent =
  | { kind: "new_task"; client: string | null; title: string | null }
  | { kind: "reassign_task"; task: string; person: string }
  | { kind: "add_user"; department: string }
  | { kind: "new"; entity: string };

/** Parses a typed phrase into an action, or null when it is just a search. */
export function coreParsePaletteIntent(raw: string): CorePaletteIntent | null {
  const q = raw.trim().replace(/\s+/g, " ");
  let m = /^(?:new|add|create) task(?: for ([^:]+?))?(?:: (.+))?$/i.exec(q);
  if (m) return { kind: "new_task", client: m[1]?.trim() || null, title: m[2]?.trim() || null };
  m = /^(?:reassign|assign|move) (.+?) to (.+)$/i.exec(q);
  if (m) return { kind: "reassign_task", task: m[1].trim(), person: m[2].trim() };
  m = /^add (?:user|person|someone|member) (?:to|in) (.+)$/i.exec(q);
  if (m) return { kind: "add_user", department: m[1].trim() };
  m = /^(?:new|add|create) (person|client|lead|request|engagement|invoice|creator|note|meeting|announcement|file)s?$/i.exec(q);
  if (m) return { kind: "new", entity: m[1].toLowerCase() };
  return null;
}

export type CorePaletteResult = {
  intent: CorePaletteIntent | null;
  actions: { label: string; hint: string; action: "new" | "reassign" | "navigate"; entity: string; prefill: Record<string, string>; href?: string; targetIds?: string[] }[];
};
