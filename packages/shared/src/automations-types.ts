// Automations area: "When this happens, if these are true, do this".
// Triggers, conditions and actions are plain data so the builder, the engine and the sentence preview
// all read the same definitions.
import { z } from "zod";
import { LEAD_STAGES, leadStageLabels } from "./crm.js";
import { REQUEST_TYPES, requestTypeLabels } from "./requests.js";
import { TEAM_ROLES, hierarchyData } from "./roles.js";

// ---------------------------------------------------------------------------
// Triggers

export const AUTOMATION_TRIGGER_KEYS = [
  "lead_created",
  "lead_idle",
  "proposal_sent_not_accepted",
  "proposal_accepted",
  "invoice_issued",
  "invoice_overdue",
  "payment_received",
  "task_overdue",
  "task_blocked",
  "deliverable_changes_requested",
  "request_created",
  "request_sla_breached",
  "engagement_gate_reached",
  "client_health_dropped",
  "leave_requested",
  // v14: workflow-only triggers
  "proposal_sent",
  "deliverable_approved",
  "request_sla_warning",
  "engagement_renewal_due",
  "offboarding_started",
  "form_submitted",
] as const;
export type AutomationTriggerKey = (typeof AUTOMATION_TRIGGER_KEYS)[number];

export const AUTOMATION_AREAS = ["Sales", "Delivery", "Money", "Client requests", "Team"] as const;
export type AutomationArea = (typeof AUTOMATION_AREAS)[number];

export type AutomationOption = { value: string; label: string };
export type AutomationArgSpec = {
  key: string;
  label: string;
  type: "number" | "select";
  unit?: string;
  min?: number;
  max?: number;
  default?: number | string;
  options?: AutomationOption[];
  optional?: boolean;
  /** v14: options come from the org's data (e.g. its forms) instead of a fixed list. */
  dynamic?: "forms";
};
export type AutomationFieldType = "text" | "number" | "money" | "select";
export type AutomationFieldSpec = { key: string; label: string; type: AutomationFieldType; options?: AutomationOption[] };

export type AutomationTriggerDef = {
  key: AutomationTriggerKey;
  area: AutomationArea;
  label: string;
  description: string;
  /** Sentence after "When", with {arg} placeholders, e.g. "an invoice is {days} days overdue". */
  sentence: string;
  /** What kind of record the rule acts on (shown in logs). */
  entity: string;
  /** Event triggers act only on records created or changed after the rule was switched on. */
  event: boolean;
  args: AutomationArgSpec[];
  fields: AutomationFieldSpec[];
  /** Placeholders available in message templates for this trigger. */
  placeholders: string[];
  /** Which people the record has (for "notify the CM / owner / assignee"). */
  people: AutomationPersonKey[];
  /** v14: only available in workflows (the older Automations builder hides it). */
  workflowOnly?: boolean;
};

export type AutomationPersonKey = "am" | "owner" | "assignee" | "manager" | "department_head";
export const automationPersonLabels: Record<AutomationPersonKey, string> = {
  am: "the client's client manager",
  owner: "the record's owner",
  assignee: "the person assigned",
  manager: "their manager",
  department_head: "the department head",
};

const opt = (pairs: readonly (readonly [string, string])[]): AutomationOption[] => pairs.map(([value, label]) => ({ value, label }));
const GATES = opt([
  ["G1", "Gate 1: requirements received"],
  ["G2", "Gate 2: plan approved"],
  ["G3", "Gate 3: tasks assigned"],
  ["G4", "Gate 4: all deliverables approved"],
  ["G5", "Gate 5: final delivery"],
]);
const REQUEST_TYPE_OPTIONS = REQUEST_TYPES.map((t) => ({ value: t, label: requestTypeLabels[t].team }));
const LEAD_STAGE_OPTIONS = LEAD_STAGES.map((s) => ({ value: s, label: leadStageLabels[s] }));
const DEPARTMENT_OPTIONS = hierarchyData.departments.map((d) => ({ value: d, label: d }));

const LEAD_FIELDS: AutomationFieldSpec[] = [
  { key: "source", label: "Lead source", type: "text" },
  { key: "budget", label: "Lead budget (₹)", type: "money" },
  { key: "service", label: "Service asked for", type: "text" },
  { key: "company", label: "Company name", type: "text" },
  { key: "score", label: "Lead score", type: "number" },
  { key: "stage", label: "Lead stage", type: "select", options: LEAD_STAGE_OPTIONS },
];
const PROPOSAL_FIELDS: AutomationFieldSpec[] = [
  { key: "client", label: "Client or company", type: "text" },
  { key: "amount", label: "Proposal total (₹)", type: "money" },
  { key: "service", label: "Service", type: "text" },
  { key: "source", label: "Lead source", type: "text" },
];
const INVOICE_FIELDS: AutomationFieldSpec[] = [
  { key: "client", label: "Client name", type: "text" },
  { key: "amount", label: "Invoice total (₹)", type: "money" },
  { key: "balance", label: "Amount still owed (₹)", type: "money" },
  { key: "kind", label: "Invoice type", type: "select", options: opt([["first_payment", "First payment"], ["retainer", "Monthly retainer"], ["project_balance", "Project balance"], ["addon", "Extra request"], ["standard", "Standard"]]) },
];
const TASK_FIELDS: AutomationFieldSpec[] = [
  { key: "title", label: "Task title", type: "text" },
  { key: "department", label: "Task department", type: "select", options: DEPARTMENT_OPTIONS },
  { key: "client", label: "Client name", type: "text" },
  { key: "kind", label: "Task kind", type: "select", options: opt([["work", "Work"], ["qc", "QC"], ["client_review", "Client review"], ["planning", "Planning"]]) },
];
const REQUEST_FIELDS: AutomationFieldSpec[] = [
  { key: "type", label: "Request type", type: "select", options: REQUEST_TYPE_OPTIONS },
  { key: "client", label: "Client name", type: "text" },
  { key: "service", label: "Service", type: "text" },
  { key: "description", label: "Request text", type: "text" },
  { key: "tone", label: "Tone of the request (BMU Hub tone check)", type: "select", options: opt([["negative", "Unhappy"], ["urgent", "Urgent"], ["positive", "Happy"], ["neutral", "Neutral"]]) },
];
const ENGAGEMENT_FIELDS: AutomationFieldSpec[] = [
  { key: "client", label: "Client name", type: "text" },
  { key: "service", label: "Service", type: "text" },
  { key: "billing", label: "Billing", type: "select", options: opt([["monthly", "Monthly retainer"], ["one_time", "One-time project"], ["per_unit", "Per unit"]]) },
];

const days = (label: string, def: number, max = 365): AutomationArgSpec => ({ key: "days", label, type: "number", unit: "days", min: 1, max, default: def });

export const AUTOMATION_TRIGGERS: AutomationTriggerDef[] = [
  // Sales
  {
    key: "lead_created",
    area: "Sales",
    label: "A new lead comes in",
    description: "Runs once for every new enquiry from the website or added by the team.",
    sentence: "a new lead comes in",
    entity: "Lead",
    event: true,
    args: [],
    fields: LEAD_FIELDS,
    placeholders: ["lead", "company", "source", "budget", "service", "owner", "link"],
    people: ["owner"],
  },
  {
    key: "lead_idle",
    area: "Sales",
    label: "A lead goes quiet",
    description: "An open lead (new, contacted, discovery or proposal sent) has not moved stage for a number of days.",
    sentence: "a lead has not moved for {days} days",
    entity: "Lead",
    event: false,
    args: [days("Days without a stage change", 5, 90)],
    fields: LEAD_FIELDS,
    placeholders: ["lead", "company", "stage", "days", "owner", "link"],
    people: ["owner", "manager"],
  },
  {
    key: "proposal_sent_not_accepted",
    area: "Sales",
    label: "A proposal is not accepted in time",
    description: "A sent proposal is still waiting for the client after a number of days.",
    sentence: "a proposal is still not accepted {days} days after sending",
    entity: "Proposal",
    event: false,
    args: [days("Days after sending", 3, 60)],
    fields: PROPOSAL_FIELDS,
    placeholders: ["lead", "client", "amount", "days", "owner", "link"],
    people: ["owner"],
  },
  {
    key: "proposal_accepted",
    area: "Sales",
    label: "A proposal is accepted",
    description: "The client accepts and signs a proposal.",
    sentence: "a proposal is accepted",
    entity: "Proposal",
    event: true,
    args: [],
    fields: PROPOSAL_FIELDS,
    placeholders: ["lead", "client", "amount", "owner", "link"],
    people: ["owner"],
  },
  // Money
  {
    key: "invoice_issued",
    area: "Money",
    label: "An invoice is issued",
    description: "A new invoice is raised for a client.",
    sentence: "an invoice is issued",
    entity: "Invoice",
    event: true,
    args: [],
    fields: INVOICE_FIELDS,
    placeholders: ["invoice", "client", "amount", "due", "am", "link"],
    people: ["am"],
  },
  {
    key: "invoice_overdue",
    area: "Money",
    label: "An invoice is overdue",
    description: "An invoice still has money owed a number of days after its due date. Each rule fires once per invoice, so a 3-day and a 10-day rule each run once.",
    sentence: "an invoice is {days} days overdue",
    entity: "Invoice",
    event: false,
    args: [days("Days past the due date", 3, 180)],
    fields: INVOICE_FIELDS,
    placeholders: ["invoice", "client", "amount", "balance", "days", "due", "am", "link"],
    people: ["am"],
  },
  {
    key: "payment_received",
    area: "Money",
    label: "A payment is received",
    description: "Money comes in against an invoice (online or recorded by Finance).",
    sentence: "a payment is received",
    entity: "Payment",
    event: true,
    args: [],
    fields: [
      { key: "client", label: "Client name", type: "text" },
      { key: "amount", label: "Payment amount (₹)", type: "money" },
      { key: "method", label: "Payment method", type: "text" },
      { key: "kind", label: "Invoice type", type: "select", options: INVOICE_FIELDS[3].options },
    ],
    placeholders: ["invoice", "client", "amount", "method", "am", "link"],
    people: ["am"],
  },
  // Delivery
  {
    key: "task_overdue",
    area: "Delivery",
    label: "A task is overdue",
    description: "A task that is not done is past its deadline by a number of hours.",
    sentence: "a task is {hours} hours past its deadline",
    entity: "Task",
    event: false,
    args: [{ key: "hours", label: "Hours past the deadline", type: "number", unit: "hours", min: 1, max: 720, default: 24 }],
    fields: TASK_FIELDS,
    placeholders: ["title", "client", "assignee", "hours", "due", "link"],
    people: ["assignee", "am", "manager", "department_head"],
  },
  {
    key: "task_blocked",
    area: "Delivery",
    label: "A task gets blocked",
    description: "Someone marks a task as blocked.",
    sentence: "a task gets blocked",
    entity: "Task",
    event: true,
    args: [],
    fields: TASK_FIELDS,
    placeholders: ["title", "client", "assignee", "reason", "link"],
    people: ["assignee", "am", "manager", "department_head"],
  },
  {
    key: "deliverable_changes_requested",
    area: "Delivery",
    label: "A client asks for another revision",
    description: "The client requests changes on a deliverable and the revision round reaches a number.",
    sentence: "a client asks for revision round {round} or more",
    entity: "Deliverable",
    event: true,
    args: [{ key: "round", label: "Revision round", type: "number", min: 1, max: 20, default: 3 }],
    fields: [
      { key: "client", label: "Client name", type: "text" },
      { key: "title", label: "Deliverable title", type: "text" },
      { key: "type", label: "Deliverable type", type: "text" },
      { key: "round", label: "Revision round", type: "number" },
    ],
    placeholders: ["title", "client", "round", "am", "link"],
    people: ["am"],
  },
  {
    key: "engagement_gate_reached",
    area: "Delivery",
    label: "A project passes a gate",
    description: "An engagement passes one of the five gates (requirements, plan, tasks, approvals, final delivery).",
    sentence: "a project passes {gate}",
    entity: "Engagement",
    event: true,
    args: [{ key: "gate", label: "Gate", type: "select", options: GATES, default: "G5" }],
    fields: ENGAGEMENT_FIELDS,
    placeholders: ["client", "service", "gate", "am", "link"],
    people: ["am"],
  },
  // Client requests
  {
    key: "request_created",
    area: "Client requests",
    label: "A client raises a request",
    description: "A client sends a new request from the app. Optionally only one type of request.",
    sentence: "a client raises {type} request",
    entity: "Request",
    event: true,
    args: [{ key: "type", label: "Request type", type: "select", options: [{ value: "", label: "Any type" }, ...REQUEST_TYPE_OPTIONS], default: "", optional: true }],
    fields: REQUEST_FIELDS,
    placeholders: ["client", "type", "description", "am", "link"],
    people: ["am"],
  },
  {
    key: "request_sla_breached",
    area: "Client requests",
    label: "A request misses its reply time",
    description: "Nobody replied to a client request within the working-hours reply time.",
    sentence: "a client request misses its reply time",
    entity: "Request",
    event: true,
    args: [],
    fields: REQUEST_FIELDS,
    placeholders: ["client", "type", "description", "due", "am", "link"],
    people: ["am"],
  },
  {
    key: "client_health_dropped",
    area: "Client requests",
    label: "A client becomes at risk",
    description: "A client's health score falls below 50 (late payments, missed replies, extra revisions, silence). Fires at most once a month per client.",
    sentence: "a client becomes at risk",
    entity: "Client",
    event: false,
    args: [],
    fields: [
      { key: "client", label: "Client name", type: "text" },
      { key: "score", label: "Health score", type: "number" },
      { key: "industry", label: "Industry", type: "text" },
    ],
    placeholders: ["client", "score", "reasons", "am", "link"],
    people: ["am"],
  },
  // Team
  {
    key: "leave_requested",
    area: "Team",
    label: "Someone asks for leave",
    description: "A team member submits a leave request.",
    sentence: "someone asks for leave",
    entity: "Leave request",
    event: true,
    args: [],
    fields: [
      { key: "person", label: "Person", type: "text" },
      { key: "type", label: "Leave type", type: "text" },
      { key: "days", label: "Number of days", type: "number" },
      { key: "department", label: "Department", type: "select", options: DEPARTMENT_OPTIONS },
    ],
    placeholders: ["person", "type", "from", "to", "days", "link"],
    people: ["manager", "department_head"],
  },
  // v14: workflow-only triggers
  {
    key: "proposal_sent",
    area: "Sales",
    label: "A proposal is sent",
    description: "A proposal goes to the client. Use waits and checks after it, e.g. remind after 3 days, escalate after 7.",
    sentence: "a proposal is sent",
    entity: "Proposal",
    event: true,
    args: [],
    fields: PROPOSAL_FIELDS,
    placeholders: ["lead", "client", "amount", "owner", "link"],
    people: ["owner", "manager"],
    workflowOnly: true,
  },
  {
    key: "deliverable_approved",
    area: "Delivery",
    label: "A client approves a creative",
    description: "The client approves a deliverable (post, video, design) in their review screen.",
    sentence: "a client approves a creative",
    entity: "Deliverable",
    event: true,
    args: [],
    fields: [
      { key: "client", label: "Client name", type: "text" },
      { key: "title", label: "Deliverable title", type: "text" },
      { key: "type", label: "Deliverable type", type: "text" },
      { key: "channel", label: "Channel", type: "text" },
    ],
    placeholders: ["title", "client", "am", "link"],
    people: ["am"],
    workflowOnly: true,
  },
  {
    key: "request_sla_warning",
    area: "Client requests",
    label: "A request is close to its reply time",
    description: "Three quarters of the reply time has gone and nobody has replied yet.",
    sentence: "a client request reaches 75% of its reply time",
    entity: "Request",
    event: false,
    args: [],
    fields: REQUEST_FIELDS,
    placeholders: ["client", "type", "description", "due", "am", "link"],
    people: ["am", "assignee"],
    workflowOnly: true,
  },
  {
    key: "engagement_renewal_due",
    area: "Delivery",
    label: "A project is coming up for renewal",
    description: "An engagement's end date is a number of days away and it has not been renewed.",
    sentence: "a project ends in {days} days",
    entity: "Engagement",
    event: false,
    args: [days("Days before the end date", 30, 120)],
    fields: ENGAGEMENT_FIELDS,
    placeholders: ["client", "service", "end", "days", "am", "link"],
    people: ["am"],
    workflowOnly: true,
  },
  {
    key: "offboarding_started",
    area: "Team",
    label: "Someone starts offboarding",
    description: "HR starts offboarding a team member. Use it to hand their open work to their manager.",
    sentence: "someone starts offboarding",
    entity: "User",
    event: true,
    args: [],
    fields: [
      { key: "person", label: "Person", type: "text" },
      { key: "department", label: "Department", type: "select", options: DEPARTMENT_OPTIONS },
    ],
    placeholders: ["person", "last_day", "reason", "link"],
    people: ["owner", "manager", "department_head"],
    workflowOnly: true,
  },
  {
    key: "form_submitted",
    area: "Sales",
    label: "A website form is filled in",
    description: "Someone fills in one of your forms (shared link or embedded on your website). The form creates a lead first.",
    sentence: "{formId} is filled in",
    entity: "Lead",
    event: true,
    args: [{ key: "formId", label: "Form", type: "select", options: [{ value: "", label: "Any form" }], default: "", optional: true, dynamic: "forms" }],
    fields: [...LEAD_FIELDS, { key: "form", label: "Form name", type: "text" }],
    placeholders: ["lead", "company", "source", "budget", "service", "owner", "form", "link"],
    people: ["owner"],
    workflowOnly: true,
  },
];

export const automationTrigger = (key: string) => AUTOMATION_TRIGGERS.find((t) => t.key === key);

// ---------------------------------------------------------------------------
// Conditions

export const AUTOMATION_OPS = ["equals", "not_equals", "contains", "greater_than", "less_than", "is_empty"] as const;
export type AutomationConditionOp = (typeof AUTOMATION_OPS)[number];
export const automationOpLabels: Record<AutomationConditionOp, string> = {
  equals: "is",
  not_equals: "is not",
  contains: "contains",
  greater_than: "is more than",
  less_than: "is less than",
  is_empty: "is empty",
};

export const automationConditionSchema = z.object({
  field: z.string().min(1, "Pick a field for each condition"),
  op: z.enum(AUTOMATION_OPS),
  value: z.string().max(500).optional().default(""),
});
export type AutomationCondition = z.infer<typeof automationConditionSchema>;

// ---------------------------------------------------------------------------
// Actions

export const AUTOMATION_ACTION_TYPES = ["notify", "create_task", "assign_lead_owner", "change_lead_stage", "post_internal_note", "send_client_reminder", "email", "webhook", "ai_draft"] as const;
export type AutomationActionType = (typeof AUTOMATION_ACTION_TYPES)[number];

export const automationActionInfo: Record<AutomationActionType, { label: string; description: string; leadOnly?: boolean; needsClient?: boolean }> = {
  notify: { label: "Send an in-app alert", description: "A notification in the bell for the people you choose." },
  create_task: { label: "Create a task", description: "A to-do with a due date in working days." },
  assign_lead_owner: { label: "Assign a lead owner", description: "Hands the lead to the next sales person in turn (round-robin).", leadOnly: true },
  change_lead_stage: { label: "Move the lead to a stage", description: "Changes the lead's pipeline stage.", leadOnly: true },
  post_internal_note: { label: "Post an internal note", description: "A team-only note on the client's message thread. The client never sees it.", needsClient: true },
  send_client_reminder: { label: "Send the client a message", description: "A polite message the client sees in their app, e.g. a payment reminder.", needsClient: true },
  email: { label: "Send an email", description: "Sends a real email when an email server (SMTP) is set up; until then it is saved to the Outbox. An in-app alert is sent too." },
  webhook: { label: "Call a webhook", description: "Sends the record as JSON to another tool (Zapier, Slack, Sheets). Public http/https addresses only." },
  ai_draft: { label: "AI draft (a person approves)", description: "AI Copilot drafts a client message, task description or note from the record and sends the draft to the chosen people as an alert. Nothing reaches the client until a person sends it." },
};

export const AUTOMATION_AI_DRAFT_KINDS = ["client_message", "task_description", "internal_note"] as const;
export type AutomationAiDraftKind = (typeof AUTOMATION_AI_DRAFT_KINDS)[number];
export const automationAiDraftLabels: Record<AutomationAiDraftKind, string> = {
  client_message: "A message to the client",
  task_description: "A task description",
  internal_note: "A team-only note",
};

export const AUTOMATION_RECIPIENTS = ["am", "owner", "assignee", "manager", "department_head", "role", "users"] as const;
export type AutomationRecipient = (typeof AUTOMATION_RECIPIENTS)[number];
export const automationRecipientLabels: Record<AutomationRecipient, string> = {
  am: "The client's client manager",
  owner: "The record's owner",
  assignee: "The person assigned",
  manager: "Their manager",
  department_head: "The department head",
  role: "Everyone with a role",
  users: "Specific people",
};

export const AUTOMATION_TASK_ASSIGNEES = ["am", "owner", "assignee", "role", "user"] as const;
export type AutomationTaskAssignee = (typeof AUTOMATION_TASK_ASSIGNEES)[number];
export const automationTaskAssigneeLabels: Record<AutomationTaskAssignee, string> = {
  am: "The client's client manager",
  owner: "The record's owner",
  assignee: "The person assigned",
  role: "Least busy person with a role",
  user: "A specific person",
};

const roleSchema = z.enum(TEAM_ROLES as [string, ...string[]]);
const text = (label: string, max = 1000) => z.string().trim().min(1, `${label} is required`).max(max);
const recipientFields = {
  to: z.enum(AUTOMATION_RECIPIENTS),
  role: roleSchema.optional(),
  userIds: z.array(z.string()).max(20).optional(),
};

export const automationActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("notify"), ...recipientFields, message: text("The alert message") }),
  z.object({
    type: z.literal("create_task"),
    title: text("The task title", 200),
    assignTo: z.enum(AUTOMATION_TASK_ASSIGNEES),
    role: roleSchema.optional(),
    userId: z.string().optional(),
    dueInDays: z.coerce.number().int().min(0).max(60).default(1),
  }),
  z.object({ type: z.literal("assign_lead_owner"), roles: z.array(roleSchema).max(5).optional() }),
  z.object({ type: z.literal("change_lead_stage"), stage: z.enum(LEAD_STAGES).refine((s) => s !== "lost", "Use the pipeline to mark a lead lost (it needs a reason)") }),
  z.object({ type: z.literal("post_internal_note"), message: text("The note") }),
  z.object({ type: z.literal("send_client_reminder"), message: text("The message") }),
  z.object({ type: z.literal("email"), to: z.enum([...AUTOMATION_RECIPIENTS, "client"]), role: roleSchema.optional(), userIds: z.array(z.string()).max(20).optional(), subject: text("The subject", 200), message: text("The email text", 4000) }),
  z.object({ type: z.literal("webhook"), url: z.string().trim().url("Enter a full web address starting with https://").max(500) }),
  z.object({ type: z.literal("ai_draft"), draft: z.enum(AUTOMATION_AI_DRAFT_KINDS), ...recipientFields, instruction: z.string().trim().max(500).optional().default("") }),
]);
export type AutomationAction = z.infer<typeof automationActionSchema>;

export const automationRuleInputSchema = z
  .object({
    name: z.string().trim().min(2, "Give the rule a name").max(120),
    description: z.string().trim().max(500).optional().nullable(),
    enabled: z.boolean().default(true),
    trigger: z.enum(AUTOMATION_TRIGGER_KEYS),
    triggerArgs: z.record(z.string(), z.union([z.number(), z.string()])).default({}),
    conditions: z.array(automationConditionSchema).max(10).default([]),
    actions: z.array(automationActionSchema).min(1, "Add at least one action").max(10),
  })
  .superRefine((v, ctx) => {
    const t = automationTrigger(v.trigger)!;
    if (t.workflowOnly) ctx.addIssue({ code: "custom", message: `"${t.label}" is only available in Workflows`, path: ["trigger"] });
    for (const a of t.args) {
      const val = v.triggerArgs[a.key];
      if (a.type === "number") {
        const n = Number(val ?? a.default);
        if (!Number.isFinite(n) || n < (a.min ?? 0) || n > (a.max ?? 10_000)) ctx.addIssue({ code: "custom", message: `${a.label} must be between ${a.min ?? 0} and ${a.max ?? 10_000}`, path: ["triggerArgs", a.key] });
      } else if (val !== undefined && val !== "" && !a.dynamic && !a.options?.some((o) => o.value === val)) {
        ctx.addIssue({ code: "custom", message: `Pick a valid ${a.label.toLowerCase()}`, path: ["triggerArgs", a.key] });
      }
    }
    for (const c of v.conditions) {
      if (!t.fields.some((f) => f.key === c.field)) ctx.addIssue({ code: "custom", message: `"${c.field}" is not a field of this trigger`, path: ["conditions"] });
    }
    v.actions.forEach((a, i) => {
      const info = automationActionInfo[a.type];
      if (info.leadOnly && t.entity !== "Lead" && t.entity !== "Proposal") ctx.addIssue({ code: "custom", message: `"${info.label}" only works with lead and proposal triggers`, path: ["actions", i] });
      if ((a.type === "notify" || a.type === "email" || a.type === "ai_draft") && a.to === "role" && !a.role) ctx.addIssue({ code: "custom", message: "Pick the role to notify", path: ["actions", i] });
      if ((a.type === "notify" || a.type === "email" || a.type === "ai_draft") && a.to === "users" && !a.userIds?.length) ctx.addIssue({ code: "custom", message: "Pick at least one person", path: ["actions", i] });
      if (a.type === "create_task" && a.assignTo === "role" && !a.role) ctx.addIssue({ code: "custom", message: "Pick the role for the task", path: ["actions", i] });
      if (a.type === "create_task" && a.assignTo === "user" && !a.userId) ctx.addIssue({ code: "custom", message: "Pick who gets the task", path: ["actions", i] });
    });
  });
export type AutomationRuleInput = z.input<typeof automationRuleInputSchema>;
export type AutomationRuleData = z.output<typeof automationRuleInputSchema>;
export const automationRulePatchSchema = z.object({ enabled: z.boolean() });

// ---------------------------------------------------------------------------
// Plain-English sentence

const roleName = (id?: string) => hierarchyData.team_roles.find((r) => r.id === id)?.name.split(" / ")[0] ?? id ?? "a role";
const lcFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

function recipientPhrase(to: string, role?: string, userCount?: number, userNames?: string[]) {
  if (to === "role") return roleName(role);
  if (to === "users") return userNames?.length ? userNames.join(", ") : `${userCount ?? 0} ${userCount === 1 ? "person" : "people"}`;
  if (to === "client") return "the client";
  return automationPersonLabels[to as AutomationPersonKey] ?? to;
}

export function automationTriggerPhrase(trigger: string, args: Record<string, unknown> = {}, names: Record<string, string> = {}): string {
  const t = automationTrigger(trigger);
  if (!t) return trigger;
  return t.sentence.replace(/\{(\w+)\}/g, (_, k: string) => {
    const spec = t.args.find((a) => a.key === k);
    const v = args[k] ?? spec?.default;
    if (k === "type") return v ? `${requestTypeLabels[v as keyof typeof requestTypeLabels]?.team.toLowerCase() ?? v}` : "any";
    if (k === "gate") return String(spec?.options?.find((o) => o.value === v)?.label ?? v);
    if (k === "formId") return v ? `the form "${names[String(v)] ?? "chosen"}"` : "any form";
    return String(v ?? "");
  }).replace(/\b1 (day|hour|minute)s\b/g, "1 $1");
}

export function automationActionPhrase(a: AutomationAction, names: Record<string, string> = {}): string {
  switch (a.type) {
    case "notify":
      return `alert ${recipientPhrase(a.to, a.role, a.userIds?.length, a.userIds?.map((id) => names[id]).filter(Boolean))}`;
    case "create_task":
      return `create a task for ${a.assignTo === "user" ? (names[a.userId ?? ""] ?? "a specific person") : a.assignTo === "role" ? `the least busy ${roleName(a.role)}` : lcFirst(automationTaskAssigneeLabels[a.assignTo])} ${a.dueInDays > 0 ? `due in ${a.dueInDays} working day${a.dueInDays === 1 ? "" : "s"}` : "due today"}`;
    case "assign_lead_owner":
      return "assign the next sales person in turn";
    case "change_lead_stage":
      return `move the lead to ${leadStageLabels[a.stage]}`;
    case "post_internal_note":
      return "post an internal note on the client thread";
    case "send_client_reminder":
      return "send the client a message";
    case "email":
      return `email ${recipientPhrase(a.to, a.role, a.userIds?.length, a.userIds?.map((id) => names[id]).filter(Boolean))}`;
    case "ai_draft":
      return `ask AI to draft ${automationAiDraftLabels[a.draft].toLowerCase()} for ${recipientPhrase(a.to, a.role, a.userIds?.length, a.userIds?.map((id) => names[id]).filter(Boolean))} to review`;
    case "webhook": {
      let host = a.url;
      try {
        host = new URL(a.url).host;
      } catch {
        /* keep raw */
      }
      return `call a webhook (${host})`;
    }
  }
}

const joinAnd = (parts: string[]) => (parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`);

/** "When an invoice is 3 days overdue, if the client is Sunrise → send the client a message and alert Finance". */
export function automationSentence(rule: { trigger: string; triggerArgs?: Record<string, unknown>; conditions?: AutomationCondition[]; actions?: AutomationAction[] }, names: Record<string, string> = {}): string {
  const t = automationTrigger(rule.trigger);
  let s = `When ${automationTriggerPhrase(rule.trigger, rule.triggerArgs ?? {})}`;
  const conds = (rule.conditions ?? []).map((c) => {
    const f = t?.fields.find((x) => x.key === c.field);
    const label = (f?.label ?? c.field).replace(/ \(₹\)$/, "").toLowerCase();
    if (c.op === "is_empty") return `${label} is empty`;
    const val = f?.options?.find((o) => o.value === c.value)?.label ?? (f?.type === "money" ? `₹${Number(c.value || 0).toLocaleString("en-IN")}` : `"${c.value}"`);
    return `${label} ${automationOpLabels[c.op]} ${val}`;
  });
  if (conds.length) s += `, if ${joinAnd(conds)}`;
  const acts = (rule.actions ?? []).map((a) => automationActionPhrase(a, names));
  s += ` → ${acts.length ? joinAnd(acts) : "do nothing yet"}`;
  return s;
}

/** Replaces {{placeholder}} with values; unknown placeholders become blank. */
export function automationFill(template: string, vars: Record<string, string | number | null | undefined>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => {
    const v = vars[k];
    return v === null || v === undefined ? "" : String(v);
  });
}

// ---------------------------------------------------------------------------
// Ready-made recipes

export type AutomationTemplate = { key: string; name: string; description: string; area: AutomationArea; rule: AutomationRuleInput };

export const AUTOMATION_TEMPLATES: AutomationTemplate[] = [
  {
    key: "payment_reminder_3d",
    name: "Payment reminder 3 days after due",
    description: "Sends the client a polite payment reminder and lets Finance know.",
    area: "Money",
    rule: {
      name: "Payment reminder 3 days after due",
      trigger: "invoice_overdue",
      triggerArgs: { days: 3 },
      actions: [
        { type: "send_client_reminder", message: "Hello! A gentle reminder that invoice {{invoice}} for {{balance}} was due on {{due}}. If you have already paid, thank you and please ignore this message. You can pay securely from the Billing page in your app." },
        { type: "notify", to: "role", role: "finance", message: "Payment reminder sent to {{client}} for invoice {{invoice}} ({{balance}} owed, {{days}} days late)." },
      ],
    },
  },
  {
    key: "escalate_overdue_10d",
    name: "Escalate invoices 10 days overdue to the Founder",
    description: "The Founder and the CM get an alert when an invoice is 10 days late.",
    area: "Money",
    rule: {
      name: "Escalate invoices 10 days overdue",
      trigger: "invoice_overdue",
      triggerArgs: { days: 10 },
      actions: [
        { type: "notify", to: "role", role: "founder", message: "{{client}} is {{days}} days late on invoice {{invoice}} ({{balance}} owed)." },
        { type: "notify", to: "am", message: "{{client}} is {{days}} days late on invoice {{invoice}}. Please call them today." },
      ],
    },
  },
  {
    key: "welcome_new_leads",
    name: "Welcome new leads within minutes",
    description: "Gives every new lead an owner in turn and a same-day call task.",
    area: "Sales",
    rule: {
      name: "Welcome new leads",
      trigger: "lead_created",
      actions: [
        { type: "assign_lead_owner" },
        { type: "create_task", title: "Call {{lead}} ({{company}}) about {{service}}", assignTo: "owner", dueInDays: 0 },
      ],
    },
  },
  {
    key: "nudge_idle_leads_5d",
    name: "Nudge idle leads after 5 days",
    description: "Reminds the lead owner when an open lead has not moved for 5 days.",
    area: "Sales",
    rule: {
      name: "Nudge idle leads after 5 days",
      trigger: "lead_idle",
      triggerArgs: { days: 5 },
      actions: [{ type: "notify", to: "owner", message: "{{lead}} ({{company}}) has been in {{stage}} for {{days}} days. Time for a follow-up?" }],
    },
  },
  {
    key: "proposal_follow_up_3d",
    name: "Follow up proposals not accepted in 3 days",
    description: "A follow-up call task for the owner when a proposal is still waiting.",
    area: "Sales",
    rule: {
      name: "Follow up proposals after 3 days",
      trigger: "proposal_sent_not_accepted",
      triggerArgs: { days: 3 },
      actions: [{ type: "create_task", title: "Follow up with {{client}} on their {{amount}} proposal", assignTo: "owner", dueInDays: 1 }],
    },
  },
  {
    key: "third_revision_alert",
    name: "Alert CM when a client asks for a 3rd revision",
    description: "The CM hears about it before extra revisions eat the margin.",
    area: "Delivery",
    rule: {
      name: "Alert CM on 3rd revision",
      trigger: "deliverable_changes_requested",
      triggerArgs: { round: 3 },
      actions: [{ type: "notify", to: "am", message: "{{client}} asked for revision round {{round}} on {{title}}. Check if this is still within the included rounds." }],
    },
  },
  {
    key: "sla_missed_alert",
    name: "Tell the CM when a request misses its reply time",
    description: "Alerts the CM and the CM Lead when a client request goes unanswered too long.",
    area: "Client requests",
    rule: {
      name: "Request missed its reply time",
      trigger: "request_sla_breached",
      actions: [
        { type: "notify", to: "am", message: "{{client}}'s {{type}} request is waiting for a reply (was due {{due}})." },
        { type: "notify", to: "role", role: "am_lead", message: "Reply time missed for {{client}} ({{type}} request)." },
      ],
    },
  },
  {
    key: "kickoff_on_payment",
    name: "Kick-off task when a client pays",
    description: "The CM gets a kick-off call task as soon as money arrives.",
    area: "Money",
    rule: {
      name: "Kick-off task on payment",
      trigger: "payment_received",
      conditions: [{ field: "kind", op: "equals", value: "first_payment" }],
      actions: [{ type: "create_task", title: "Kick-off call with {{client}}", assignTo: "am", dueInDays: 1 }],
    },
  },
  {
    key: "gate5_review",
    name: "Celebrate gate 5 delivery and ask for a review",
    description: "When final files are delivered, the CM gets a task to thank the client and ask for a review.",
    area: "Delivery",
    rule: {
      name: "Ask for a review after delivery",
      trigger: "engagement_gate_reached",
      triggerArgs: { gate: "G5" },
      actions: [{ type: "create_task", title: "Thank {{client}} for {{service}} and ask for a Google review", assignTo: "am", dueInDays: 2 }],
    },
  },
  {
    key: "blocked_task_head",
    name: "Flag blocked tasks to the department head",
    description: "The department head sees blocked work straight away.",
    area: "Delivery",
    rule: {
      name: "Flag blocked tasks",
      trigger: "task_blocked",
      actions: [{ type: "notify", to: "department_head", message: "{{title}} for {{client}} is blocked: {{reason}}" }],
    },
  },
  {
    key: "leave_to_manager",
    name: "HR: notify manager of leave requests",
    description: "The person's manager and HR are told about each new leave request.",
    area: "Team",
    rule: {
      name: "Notify manager of leave requests",
      trigger: "leave_requested",
      actions: [
        { type: "notify", to: "manager", message: "{{person}} asked for {{type}} leave from {{from}} to {{to}} ({{days}} days)." },
        { type: "notify", to: "role", role: "hr_ops", message: "New leave request from {{person}} ({{from}} to {{to}})." },
      ],
    },
  },
];

// ---------------------------------------------------------------------------
// Views

export type AutomationRunStatus = "success" | "failed" | "skipped";
export type AutomationStep = { action: AutomationActionType; ok: boolean; skipped?: boolean; text: string };
export type AutomationRunDetail = { summary: string; record?: string; link?: string | null; steps?: AutomationStep[]; error?: string; demo?: boolean };

export type AutomationRuleRow = {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  trigger: AutomationTriggerKey;
  triggerLabel: string;
  area: AutomationArea;
  sentence: string;
  templateKey: string | null;
  runCount: number;
  failures30d: number;
  lastRunAt: string | null;
  createdAt: string;
};

export type AutomationRuleDetail = AutomationRuleRow & {
  triggerArgs: Record<string, string | number>;
  conditions: AutomationCondition[];
  actions: AutomationAction[];
  watermark: string;
  createdBy: string | null;
  runs: AutomationRunRow[];
};

export type AutomationRunRow = {
  id: string;
  ruleId: string;
  ruleName: string;
  entity: string;
  entityId: string;
  status: AutomationRunStatus;
  summary: string;
  record: string | null;
  link: string | null;
  steps: AutomationStep[];
  at: string;
};

export type AutomationOverview = {
  canManage: boolean;
  stats: { activeRules: number; totalRules: number; runs7d: number; runsPrev7d: number; actions7d: number; failures7d: number };
  rules: AutomationRuleRow[];
  daily: { date: string; success: number; failed: number; skipped: number }[];
  templates: (AutomationTemplate & { installed: boolean; sentence: string })[];
  topRules: { id: string; name: string; runs: number }[];
};

export type AutomationOptions = {
  canManage: boolean;
  users: { id: string; name: string; roles: string[] }[];
  roles: AutomationOption[];
};

export type AutomationTestMatch = {
  entity: string;
  entityId: string;
  record: string;
  link: string | null;
  /** True when the rule already ran for this record (it will not run again). */
  alreadyDone: boolean;
  /** True for event records from before the rule was switched on (shown for testing only). */
  beforeStart: boolean;
  passes: boolean;
  failedCondition?: string;
  wouldDo: string[];
};
export type AutomationTestResult = { sentence: string; considered: number; willRun: number; matches: AutomationTestMatch[]; note: string };
export type AutomationRunNowResult = { rules: number; fired: number; failed: number; skipped: number; tookMs: number };
export type AutomationRunFilters = { ruleId?: string; status?: string; from?: string; to?: string };
