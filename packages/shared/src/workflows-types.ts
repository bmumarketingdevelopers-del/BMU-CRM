// v14 workflows: a trigger, start conditions, then a tree of steps (actions, if/else branches, waits,
// approvals, stop). The engine runs a compiled, flat version of the tree and stores its position, so a run
// can wait for days and survive restarts. Builder, engine and run log all read these definitions.
import { z } from "zod";
import {
  AUTOMATION_OPS,
  AUTOMATION_TRIGGER_KEYS,
  automationActionPhrase,
  automationActionSchema,
  automationOpLabels,
  automationTrigger,
  automationTriggerPhrase,
  type AutomationArea,
  type AutomationConditionOp,
  type AutomationFieldSpec,
  type AutomationOption,
  type AutomationTriggerKey,
} from "./automations-types.js";
import { customFieldEntityLabels, type CustomFieldEntity } from "./customise-types.js";
import { LEAD_STAGES, leadStageLabels } from "./crm.js";
import { REQUEST_STATUSES, requestStatusLabels } from "./requests.js";
import { TEAM_ROLES, hierarchyData } from "./roles.js";

const opt = (pairs: readonly (readonly [string, string])[]): AutomationOption[] => pairs.map(([value, label]) => ({ value, label }));
const YES_NO = opt([
  ["yes", "Yes"],
  ["no", "No"],
]);

// ---------------------------------------------------------------------------
// Extra actions (on top of the automation actions)

export const WORKFLOW_EXTRA_ACTION_TYPES = ["score_lead", "send_whatsapp", "set_status", "set_custom_field", "reassign_open_work"] as const;
export type WorkflowExtraActionType = (typeof WORKFLOW_EXTRA_ACTION_TYPES)[number];
export const workflowExtraActionInfo: Record<WorkflowExtraActionType, { label: string; description: string }> = {
  score_lead: { label: "Score the lead", description: "Scores the lead from 0 to 100 (budget, services asked for, business details). AI Copilot explains the score on the lead page." },
  send_whatsapp: { label: "Send a WhatsApp", description: "A WhatsApp message to the lead or the client's main contact. Until WhatsApp Business is connected it waits in the WhatsApp queue (Outbox page)." },
  set_status: { label: "Change the status", description: "Moves the record to another status, e.g. an approved creative to Scheduled." },
  set_custom_field: { label: "Set a custom field", description: "Fills in one of your custom fields on the record." },
  reassign_open_work: { label: "Hand over open work", description: "Moves the person's open tasks and open leads to their manager, someone with a role, or a chosen person." },
};

/** Statuses a workflow may set, per record type (others change through their own screens and checks). */
export const WORKFLOW_SET_STATUS: Record<string, AutomationOption[]> = {
  Deliverable: opt([
    ["scheduled", "Scheduled"],
    ["published", "Published"],
  ]),
  Task: opt([
    ["in_progress", "In progress"],
    ["waiting", "Waiting"],
    ["done", "Done"],
    ["cancelled", "Cancelled"],
  ]),
  Request: opt([
    ["in_progress", "In progress"],
    ["done", "Done"],
    ["rescheduled", "Rescheduled"],
  ]),
};

const roleSchema = z.enum(TEAM_ROLES as [string, ...string[]]);
const text = (label: string, max = 1000) => z.string().trim().min(1, `${label} is required`).max(max);

export const workflowActionSchema = z.discriminatedUnion("type", [
  ...automationActionSchema.options,
  z.object({ type: z.literal("score_lead") }),
  z.object({ type: z.literal("send_whatsapp"), to: z.enum(["lead", "client"]), message: text("The WhatsApp message", 1000) }),
  z.object({ type: z.literal("set_status"), status: z.string().trim().min(1, "Pick the status").max(40) }),
  z.object({
    type: z.literal("set_custom_field"),
    field: z
      .string()
      .trim()
      .regex(/^custom\.[a-z]+\.[a-z][a-z0-9_]{0,39}$/, "Pick the custom field"),
    value: z.string().max(500).default(""),
  }),
  z.object({ type: z.literal("reassign_open_work"), to: z.enum(["manager", "role", "user"]), role: roleSchema.optional(), userId: z.string().optional() }),
]);
export type WorkflowAction = z.infer<typeof workflowActionSchema>;
export type WorkflowActionType = WorkflowAction["type"];

export const workflowActionLabel = (type: string): string =>
  (workflowExtraActionInfo as Record<string, { label: string }>)[type]?.label ??
  ({
    notify: "Send an in-app alert",
    create_task: "Create a task",
    assign_lead_owner: "Assign a lead owner",
    change_lead_stage: "Move the lead to a stage",
    post_internal_note: "Post an internal note",
    send_client_reminder: "Send the client a message",
    email: "Send an email",
    webhook: "Call a webhook",
    ai_draft: "AI draft (a person approves)",
  } as Record<string, string>)[type] ??
  type;

// ---------------------------------------------------------------------------
// Fields a condition can check

/** Live facts re-read from the record every time a condition is checked (the trigger's fields are a snapshot). */
export const WORKFLOW_RECORD_FIELDS: Record<string, AutomationFieldSpec[]> = {
  Lead: [
    { key: "record.stage", label: "Lead stage now", type: "select", options: LEAD_STAGES.map((s) => ({ value: s, label: leadStageLabels[s] })) },
    { key: "record.score", label: "Lead score now", type: "number" },
    { key: "record.has_owner", label: "Lead has an owner", type: "select", options: YES_NO },
    { key: "record.replied", label: "Lead has had a first reply", type: "select", options: YES_NO },
    { key: "record.days_in_stage", label: "Days in the current stage", type: "number" },
  ],
  Proposal: [
    {
      key: "record.status",
      label: "Proposal status now",
      type: "select",
      options: opt([
        ["sent", "Sent, waiting"],
        ["accepted", "Accepted"],
        ["rejected", "Rejected"],
        ["expired", "Expired"],
        ["superseded", "Replaced by a newer version"],
      ]),
    },
    { key: "record.days_since_sent", label: "Days since it was sent", type: "number" },
  ],
  Invoice: [
    {
      key: "record.status",
      label: "Invoice status now",
      type: "select",
      options: opt([
        ["issued", "Issued"],
        ["partially_paid", "Partly paid"],
        ["paid", "Paid"],
        ["overdue", "Overdue"],
        ["void", "Void"],
        ["credit_noted", "Credit noted"],
      ]),
    },
    { key: "record.balance", label: "Amount still owed now (₹)", type: "money" },
    { key: "record.days_overdue", label: "Days past the due date", type: "number" },
  ],
  Task: [
    {
      key: "record.status",
      label: "Task status now",
      type: "select",
      options: opt([
        ["todo", "To do"],
        ["in_progress", "In progress"],
        ["blocked", "Blocked"],
        ["waiting", "Waiting"],
        ["in_qc", "In QC"],
        ["done", "Done"],
        ["cancelled", "Cancelled"],
      ]),
    },
  ],
  Deliverable: [
    {
      key: "record.status",
      label: "Deliverable status now",
      type: "select",
      options: opt([
        ["approved", "Approved"],
        ["scheduled", "Scheduled"],
        ["published", "Published"],
        ["changes_requested", "Changes requested"],
      ]),
    },
  ],
  Engagement: [
    { key: "record.days_to_end", label: "Days until the end date", type: "number" },
    { key: "record.renewed", label: "Renewed since the trigger", type: "select", options: YES_NO },
    { key: "record.status", label: "Project status now", type: "text" },
  ],
  Request: [
    { key: "record.status", label: "Request status now", type: "select", options: REQUEST_STATUSES.map((s) => ({ value: s, label: requestStatusLabels[s].team })) },
    { key: "record.replied", label: "Someone has replied", type: "select", options: YES_NO },
  ],
  "Leave request": [
    {
      key: "record.status",
      label: "Leave status now",
      type: "select",
      options: opt([
        ["pending", "Waiting"],
        ["approved", "Approved"],
        ["rejected", "Rejected"],
        ["cancelled", "Cancelled"],
      ]),
    },
  ],
  User: [{ key: "record.open_work", label: "Open tasks and leads they still own", type: "number" }],
};

/** Dates a "wait until" step can wait for, per record type. Custom date fields are added from the org's fields. */
export const WORKFLOW_DATE_FIELDS: Record<string, AutomationOption[]> = {
  Lead: opt([["record.next_follow_up", "The next follow-up date"]]),
  Proposal: opt([["record.valid_until", "The proposal's valid-until date"]]),
  Invoice: opt([["record.due", "The invoice due date"]]),
  Task: opt([["record.deadline", "The task deadline"]]),
  Deliverable: opt([
    ["record.due", "The deliverable due date"],
    ["record.scheduled", "The scheduled post date"],
  ]),
  Engagement: opt([["record.end", "The project end date"]]),
  Request: opt([["record.reply_due", "The reply-by time"]]),
  User: opt([["record.last_day", "Their last working day"]]),
};

/** Which records' custom fields a trigger can reach (through the lead, client or project). */
export const WORKFLOW_CUSTOM_REACH: Record<string, CustomFieldEntity[]> = {
  Lead: ["lead"],
  Proposal: ["lead"],
  Invoice: ["client", "engagement"],
  Payment: ["client", "engagement"],
  Task: ["engagement", "client"],
  Deliverable: ["engagement", "client"],
  Engagement: ["engagement", "client"],
  Request: ["request", "engagement", "client"],
  Client: ["client"],
};

export type WorkflowCustomFieldRef = { entity: CustomFieldEntity; key: string; label: string; type: string; options: string[] };

/** Every field a condition in this workflow can check: the trigger's own, the live record facts and custom fields. */
export function workflowFieldSpecs(trigger: string, custom: WorkflowCustomFieldRef[] = []): (AutomationFieldSpec & { group: string })[] {
  const t = automationTrigger(trigger);
  if (!t) return [];
  const reach = WORKFLOW_CUSTOM_REACH[t.entity] ?? [];
  return [
    ...t.fields.map((f) => ({ ...f, group: "When it started" })),
    ...(WORKFLOW_RECORD_FIELDS[t.entity] ?? []).map((f) => ({ ...f, group: "Right now" })),
    ...custom
      .filter((c) => reach.includes(c.entity) && c.type !== "date" && c.type !== "long_text")
      .map((c) => ({
        key: `custom.${c.entity}.${c.key}`,
        label: `${customFieldEntityLabels[c.entity].one}: ${c.label}${c.type === "money" ? " (₹)" : ""}`,
        type: (c.type === "select" ? "select" : c.type === "checkbox" ? "select" : c.type === "number" || c.type === "money" ? "number" : "text") as AutomationFieldSpec["type"],
        options: c.type === "select" ? c.options.map((o) => ({ value: o, label: o })) : c.type === "checkbox" ? YES_NO : undefined,
        group: "Custom fields",
      })),
  ];
}

export function workflowDateFields(trigger: string, custom: WorkflowCustomFieldRef[] = []): AutomationOption[] {
  const t = automationTrigger(trigger);
  if (!t) return [];
  const reach = WORKFLOW_CUSTOM_REACH[t.entity] ?? [];
  return [...(WORKFLOW_DATE_FIELDS[t.entity] ?? []), ...custom.filter((c) => c.type === "date" && reach.includes(c.entity)).map((c) => ({ value: `custom.${c.entity}.${c.key}`, label: `${customFieldEntityLabels[c.entity].one}: ${c.label}` }))];
}

// ---------------------------------------------------------------------------
// Steps

export const WORKFLOW_WAIT_UNITS = ["minutes", "hours", "days", "working_days"] as const;
export type WorkflowWaitUnit = (typeof WORKFLOW_WAIT_UNITS)[number];
export const workflowWaitUnitLabels: Record<WorkflowWaitUnit, string> = { minutes: "minutes", hours: "hours", days: "days", working_days: "working days" };
const WAIT_MAX: Record<WorkflowWaitUnit, number> = { minutes: 1440, hours: 720, days: 365, working_days: 250 };

export const WORKFLOW_STEP_KINDS = ["action", "if", "wait", "wait_until", "approval", "stop"] as const;
export type WorkflowStepKind = (typeof WORKFLOW_STEP_KINDS)[number];
export const workflowStepKindInfo: Record<WorkflowStepKind, { label: string; description: string }> = {
  action: { label: "Do something", description: "Send an alert, message or email, create a task, assign, change a status…" },
  if: { label: "If / else", description: "Check something and take a different path when it is true or not." },
  wait: { label: "Wait", description: "Pause for minutes, hours, days or working days, then carry on." },
  wait_until: { label: "Wait until a date", description: "Pause until a date on the record (due date, end date, reply-by time)." },
  approval: { label: "Ask for approval", description: "A person approves or rejects in their Approvals. Each answer has its own path." },
  stop: { label: "Stop", description: "End the workflow here for this record." },
};

export const WORKFLOW_MATCH = ["all", "any"] as const;
export type WorkflowMatch = (typeof WORKFLOW_MATCH)[number];

export type WorkflowCondition = { field: string; op: AutomationConditionOp; value: string };
export type WorkflowStep =
  | { id: string; kind: "action"; action: WorkflowAction }
  | { id: string; kind: "if"; label?: string; match: WorkflowMatch; conditions: WorkflowCondition[]; then: WorkflowStep[]; else: WorkflowStep[] }
  | { id: string; kind: "wait"; amount: number; unit: WorkflowWaitUnit }
  | { id: string; kind: "wait_until"; field: string; offsetDays: number }
  | { id: string; kind: "approval"; title: string; approverRole?: string; approverId?: string; expiresInDays: number; approved: WorkflowStep[]; rejected: WorkflowStep[] }
  | { id: string; kind: "stop"; reason?: string };

export const workflowConditionSchema = z.object({
  field: z.string().trim().min(1, "Pick a field for each check").max(80),
  op: z.enum(AUTOMATION_OPS),
  value: z.string().max(500).optional().default(""),
});

const stepId = z.string().trim().regex(/^[A-Za-z0-9_-]{1,40}$/, "Bad step id");
export const workflowStepSchema: z.ZodType<WorkflowStep, unknown> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({ id: stepId, kind: z.literal("action"), action: workflowActionSchema }),
    z.object({
      id: stepId,
      kind: z.literal("if"),
      label: z.string().trim().max(80).optional(),
      match: z.enum(WORKFLOW_MATCH).default("all"),
      conditions: z.array(workflowConditionSchema).min(1, "Add at least one check to each If step").max(10),
      then: z.array(workflowStepSchema).max(30).default([]),
      else: z.array(workflowStepSchema).max(30).default([]),
    }),
    z.object({ id: stepId, kind: z.literal("wait"), amount: z.coerce.number().int().min(1, "Wait at least 1").max(1440), unit: z.enum(WORKFLOW_WAIT_UNITS) }),
    z.object({ id: stepId, kind: z.literal("wait_until"), field: z.string().trim().min(1, "Pick the date to wait for").max(80), offsetDays: z.coerce.number().int().min(-60).max(60).default(0) }),
    z.object({
      id: stepId,
      kind: z.literal("approval"),
      title: text("What needs approving", 200),
      approverRole: roleSchema.optional(),
      approverId: z.string().optional(),
      expiresInDays: z.coerce.number().int().min(1).max(30).default(3),
      approved: z.array(workflowStepSchema).max(30).default([]),
      rejected: z.array(workflowStepSchema).max(30).default([]),
    }),
    z.object({ id: stepId, kind: z.literal("stop"), reason: z.string().trim().max(200).optional() }),
  ]),
);

/** Visits every step, depth first, with its depth. */
export function workflowWalk(steps: WorkflowStep[], fn: (s: WorkflowStep, depth: number) => void, depth = 0) {
  for (const s of steps) {
    fn(s, depth);
    if (s.kind === "if") {
      workflowWalk(s.then, fn, depth + 1);
      workflowWalk(s.else, fn, depth + 1);
    } else if (s.kind === "approval") {
      workflowWalk(s.approved, fn, depth + 1);
      workflowWalk(s.rejected, fn, depth + 1);
    }
  }
}

export const WORKFLOW_MAX_STEPS = 60;
export const WORKFLOW_MAX_DEPTH = 5;

export const workflowInputSchema = z
  .object({
    name: z.string().trim().min(2, "Give the workflow a name").max(120),
    description: z.string().trim().max(500).optional().nullable(),
    enabled: z.boolean().default(true),
    trigger: z.enum(AUTOMATION_TRIGGER_KEYS),
    triggerArgs: z.record(z.string(), z.union([z.number(), z.string()])).default({}),
    start: z.object({ match: z.enum(WORKFLOW_MATCH).default("all"), conditions: z.array(workflowConditionSchema).max(10).default([]) }).default({ match: "all", conditions: [] }),
    steps: z.array(workflowStepSchema).min(1, "Add at least one step").max(30),
  })
  .superRefine((v, ctx) => {
    const t = automationTrigger(v.trigger)!;
    for (const a of t.args) {
      const val = v.triggerArgs[a.key];
      if (a.type === "number") {
        const n = Number(val ?? a.default);
        if (!Number.isFinite(n) || n < (a.min ?? 0) || n > (a.max ?? 10_000)) ctx.addIssue({ code: "custom", message: `${a.label} must be between ${a.min ?? 0} and ${a.max ?? 10_000}`, path: ["triggerArgs", a.key] });
      } else if (val !== undefined && val !== "" && !a.dynamic && !a.options?.some((o) => o.value === val)) {
        ctx.addIssue({ code: "custom", message: `Pick a valid ${a.label.toLowerCase()}`, path: ["triggerArgs", a.key] });
      }
    }
    const known = new Set([...t.fields.map((f) => f.key), ...(WORKFLOW_RECORD_FIELDS[t.entity] ?? []).map((f) => f.key)]);
    const fieldOk = (f: string) => known.has(f) || /^custom\.[a-z]+\.[a-z][a-z0-9_]{0,39}$/.test(f);
    for (const c of v.start.conditions) if (!fieldOk(c.field)) ctx.addIssue({ code: "custom", message: `"${c.field}" can't be checked for this trigger`, path: ["start", "conditions"] });
    let count = 0;
    const ids = new Set<string>();
    const dates = new Set((WORKFLOW_DATE_FIELDS[t.entity] ?? []).map((d) => d.value));
    workflowWalk(v.steps, (s, depth) => {
      count++;
      if (ids.has(s.id)) ctx.addIssue({ code: "custom", message: "Two steps share an id. Remove one and add it again.", path: ["steps"] });
      ids.add(s.id);
      if (depth >= WORKFLOW_MAX_DEPTH) ctx.addIssue({ code: "custom", message: `Branches can go ${WORKFLOW_MAX_DEPTH} levels deep at most`, path: ["steps"] });
      if (s.kind === "if") for (const c of s.conditions) if (!fieldOk(c.field)) ctx.addIssue({ code: "custom", message: `"${c.field}" can't be checked for this trigger`, path: ["steps"] });
      if (s.kind === "wait" && s.amount > WAIT_MAX[s.unit]) ctx.addIssue({ code: "custom", message: `Wait at most ${WAIT_MAX[s.unit]} ${workflowWaitUnitLabels[s.unit]}`, path: ["steps"] });
      if (s.kind === "wait_until" && !dates.has(s.field) && !s.field.startsWith("custom.")) ctx.addIssue({ code: "custom", message: "Pick a date this record has", path: ["steps"] });
      if (s.kind === "approval" && !s.approverRole && !s.approverId) ctx.addIssue({ code: "custom", message: `Say who approves "${s.title}"`, path: ["steps"] });
      if (s.kind === "action") {
        const a = s.action;
        const where = `"${workflowActionLabel(a.type)}"`;
        if ((a.type === "assign_lead_owner" || a.type === "change_lead_stage" || a.type === "score_lead") && t.entity !== "Lead" && t.entity !== "Proposal") ctx.addIssue({ code: "custom", message: `${where} only works with lead and proposal triggers`, path: ["steps"] });
        if ((a.type === "notify" || a.type === "email" || a.type === "ai_draft") && a.to === "role" && !a.role) ctx.addIssue({ code: "custom", message: `Pick the role for ${where}`, path: ["steps"] });
        if ((a.type === "notify" || a.type === "email" || a.type === "ai_draft") && a.to === "users" && !a.userIds?.length) ctx.addIssue({ code: "custom", message: `Pick at least one person for ${where}`, path: ["steps"] });
        if (a.type === "create_task" && a.assignTo === "role" && !a.role) ctx.addIssue({ code: "custom", message: "Pick the role for the task", path: ["steps"] });
        if (a.type === "create_task" && a.assignTo === "user" && !a.userId) ctx.addIssue({ code: "custom", message: "Pick who gets the task", path: ["steps"] });
        if (a.type === "set_status" && !(WORKFLOW_SET_STATUS[t.entity] ?? []).some((o) => o.value === a.status)) ctx.addIssue({ code: "custom", message: `This record can't be moved to "${a.status}" by a workflow`, path: ["steps"] });
        if (a.type === "send_whatsapp" && a.to === "lead" && t.entity !== "Lead" && t.entity !== "Proposal") ctx.addIssue({ code: "custom", message: "WhatsApp to the lead only works with lead and proposal triggers", path: ["steps"] });
        if (a.type === "reassign_open_work" && t.entity !== "User") ctx.addIssue({ code: "custom", message: `${where} only works with the offboarding trigger`, path: ["steps"] });
        if (a.type === "reassign_open_work" && a.to === "role" && !a.role) ctx.addIssue({ code: "custom", message: "Pick the role that takes over", path: ["steps"] });
        if (a.type === "reassign_open_work" && a.to === "user" && !a.userId) ctx.addIssue({ code: "custom", message: "Pick who takes over", path: ["steps"] });
      }
    });
    if (count > WORKFLOW_MAX_STEPS) ctx.addIssue({ code: "custom", message: `A workflow can have up to ${WORKFLOW_MAX_STEPS} steps`, path: ["steps"] });
  });
export type WorkflowInput = z.input<typeof workflowInputSchema>;
export type WorkflowData = z.output<typeof workflowInputSchema>;
export const workflowPatchSchema = z.object({ enabled: z.boolean() });

// ---------------------------------------------------------------------------
// Compiled program

export type WorkflowInstr =
  | { op: "action"; step: string; action: WorkflowAction }
  | { op: "wait"; step: string; amount: number; unit: WorkflowWaitUnit }
  | { op: "wait_until"; step: string; field: string; offsetDays: number }
  | { op: "if"; step: string; match: WorkflowMatch; conditions: WorkflowCondition[]; else: number }
  | { op: "approval"; step: string; title: string; approverRole?: string; approverId?: string; expiresInDays: number; rejected: number }
  | { op: "jump"; to: number }
  | { op: "stop"; step: string; reason?: string };

/** Flattens the step tree. Runs store an index into this list, so they continue after a restart. */
export function compileWorkflow(steps: WorkflowStep[]): WorkflowInstr[] {
  const out: WorkflowInstr[] = [];
  const emit = (list: WorkflowStep[]) => {
    for (const s of list) {
      switch (s.kind) {
        case "action":
          out.push({ op: "action", step: s.id, action: s.action });
          break;
        case "wait":
          out.push({ op: "wait", step: s.id, amount: s.amount, unit: s.unit });
          break;
        case "wait_until":
          out.push({ op: "wait_until", step: s.id, field: s.field, offsetDays: s.offsetDays });
          break;
        case "stop":
          out.push({ op: "stop", step: s.id, reason: s.reason });
          break;
        case "if":
        case "approval": {
          const at = out.length;
          out.push(
            s.kind === "if"
              ? { op: "if", step: s.id, match: s.match, conditions: s.conditions, else: -1 }
              : { op: "approval", step: s.id, title: s.title, approverRole: s.approverRole, approverId: s.approverId, expiresInDays: s.expiresInDays, rejected: -1 },
          );
          emit(s.kind === "if" ? s.then : s.approved);
          const jump = out.length;
          out.push({ op: "jump", to: -1 });
          const elseAt = out.length;
          emit(s.kind === "if" ? s.else : s.rejected);
          const head = out[at] as Extract<WorkflowInstr, { op: "if" | "approval" }>;
          if (head.op === "if") head.else = elseAt;
          else head.rejected = elseAt;
          (out[jump] as Extract<WorkflowInstr, { op: "jump" }>).to = out.length;
          break;
        }
      }
    }
  };
  emit(steps);
  return out;
}

// ---------------------------------------------------------------------------
// Plain-English phrases

const roleName = (id?: string) => hierarchyData.team_roles.find((r) => r.id === id)?.name.split(" / ")[0] ?? id ?? "a role";

export function workflowConditionPhrase(c: WorkflowCondition, specs: AutomationFieldSpec[]): string {
  const f = specs.find((x) => x.key === c.field);
  const label = (f?.label ?? c.field).replace(/ \(₹\)$/, "").toLowerCase();
  if (c.op === "is_empty") return `${label} is empty`;
  const val = f?.options?.find((o) => o.value === c.value)?.label ?? (f?.type === "money" ? `₹${Number(c.value || 0).toLocaleString("en-IN")}` : `"${c.value}"`);
  return `${label} ${automationOpLabels[c.op]} ${val}`;
}

export function workflowActionPhrase(a: WorkflowAction, names: Record<string, string> = {}, customLabels: Record<string, string> = {}): string {
  switch (a.type) {
    case "score_lead":
      return "score the lead";
    case "send_whatsapp":
      return `send ${a.to === "lead" ? "the lead" : "the client"} a WhatsApp`;
    case "set_status": {
      const label = Object.values(WORKFLOW_SET_STATUS)
        .flat()
        .find((o) => o.value === a.status)?.label;
      return `change the status to ${label ?? a.status}`;
    }
    case "set_custom_field":
      return `set ${customLabels[a.field] ?? a.field.split(".").pop()} to "${a.value}"`;
    case "reassign_open_work":
      return `hand their open work to ${a.to === "manager" ? "their manager" : a.to === "role" ? `the least busy ${roleName(a.role)}` : (names[a.userId ?? ""] ?? "a chosen person")}`;
    default:
      return automationActionPhrase(a, names);
  }
}

export function workflowStepPhrase(s: WorkflowStep, specs: AutomationFieldSpec[] = [], names: Record<string, string> = {}, dateLabels: Record<string, string> = {}): string {
  switch (s.kind) {
    case "action":
      return workflowActionPhrase(s.action, names);
    case "if":
      return `If ${s.conditions.map((c) => workflowConditionPhrase(c, specs)).join(s.match === "any" ? " or " : " and ")}`;
    case "wait":
      return `Wait ${s.amount} ${s.amount === 1 ? workflowWaitUnitLabels[s.unit].replace(/s$/, "") : workflowWaitUnitLabels[s.unit]}`;
    case "wait_until": {
      const what = (dateLabels[s.field] ?? s.field).replace(/^The /, "the ");
      return s.offsetDays === 0 ? `Wait until ${what}` : `Wait until ${Math.abs(s.offsetDays)} day${Math.abs(s.offsetDays) === 1 ? "" : "s"} ${s.offsetDays < 0 ? "before" : "after"} ${what}`;
    }
    case "approval":
      return `Ask ${s.approverId ? (names[s.approverId] ?? "a chosen person") : roleName(s.approverRole)} to approve: ${s.title}`;
    case "stop":
      return s.reason ? `Stop: ${s.reason}` : "Stop";
  }
}

/** "When an invoice is 1 day overdue → 9 steps (2 waits, 2 checks, 1 approval)". */
export function workflowSummary(w: { trigger: string; triggerArgs?: Record<string, unknown>; steps: WorkflowStep[] }, names: Record<string, string> = {}): string {
  let n = 0;
  const kinds: Record<string, number> = {};
  workflowWalk(w.steps, (s) => {
    n++;
    kinds[s.kind] = (kinds[s.kind] ?? 0) + 1;
  });
  const extras = [kinds.wait || kinds.wait_until ? `${(kinds.wait ?? 0) + (kinds.wait_until ?? 0)} wait${(kinds.wait ?? 0) + (kinds.wait_until ?? 0) === 1 ? "" : "s"}` : "", kinds.if ? `${kinds.if} check${kinds.if === 1 ? "" : "s"}` : "", kinds.approval ? `${kinds.approval} approval${kinds.approval === 1 ? "" : "s"}` : ""].filter(Boolean);
  return `When ${automationTriggerPhrase(w.trigger, w.triggerArgs ?? {}, names)} → ${n} step${n === 1 ? "" : "s"}${extras.length ? ` (${extras.join(", ")})` : ""}`;
}

// ---------------------------------------------------------------------------
// Ready-made workflows

export type WorkflowTemplate = { key: string; name: string; description: string; area: AutomationArea; workflow: WorkflowInput };

let seq = 0;
const sid = (p: string) => `${p}${++seq}`;
const act = (action: WorkflowAction): WorkflowStep => ({ id: sid("a"), kind: "action", action });
const wait = (amount: number, unit: WorkflowWaitUnit): WorkflowStep => ({ id: sid("w"), kind: "wait", amount, unit });
const when = (conditions: WorkflowCondition[], then: WorkflowStep[], otherwise: WorkflowStep[] = [], match: WorkflowMatch = "all"): WorkflowStep => ({ id: sid("i"), kind: "if", match, conditions, then, else: otherwise });
const stop = (reason?: string): WorkflowStep => ({ id: sid("s"), kind: "stop", reason });

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    key: "wf_new_lead",
    name: "New lead: score, assign, welcome, follow up",
    description: "Scores every new lead, gives it the next sales person in turn, sends a WhatsApp welcome and a same-day call task, then checks back after 2 working days.",
    area: "Sales",
    workflow: {
      name: "New lead",
      trigger: "lead_created",
      steps: [
        act({ type: "score_lead" }),
        act({ type: "assign_lead_owner" }),
        act({ type: "send_whatsapp", to: "lead", message: "Hi {{lead}}, thank you for contacting BMU Marketing about {{service}}. {{owner}} from our team will call you today. Reply here any time with questions." }),
        act({ type: "create_task", title: "Call {{lead}} ({{company}}) about {{service}}", assignTo: "owner", dueInDays: 0 }),
        wait(2, "working_days"),
        when([{ field: "record.stage", op: "equals", value: "new" }], [act({ type: "notify", to: "owner", message: "{{lead}} ({{company}}) is still New after 2 working days. Please follow up today." }), act({ type: "notify", to: "manager", message: "{{lead}} ({{company}}) has not been contacted in 2 working days (owner: {{owner}})." })]),
      ],
    },
  },
  {
    key: "wf_proposal_chase",
    name: "Proposal reminder at 3 days, escalation at 7",
    description: "If the client has not accepted after 3 days the owner gets a follow-up task and the lead a gentle WhatsApp. After 7 days the sales manager is told.",
    area: "Sales",
    workflow: {
      name: "Proposal reminder and escalation",
      trigger: "proposal_sent",
      steps: [
        wait(3, "days"),
        when(
          [{ field: "record.status", op: "equals", value: "sent" }],
          [
            act({ type: "create_task", title: "Follow up with {{client}} on their {{amount}} proposal", assignTo: "owner", dueInDays: 0 }),
            act({ type: "send_whatsapp", to: "lead", message: "Hi {{lead}}, just checking you had a chance to look at our proposal. Happy to walk you through it on a quick call." }),
            wait(4, "days"),
            when([{ field: "record.status", op: "equals", value: "sent" }], [act({ type: "notify", to: "manager", message: "The {{amount}} proposal for {{client}} has waited 7 days without an answer (owner: {{owner}})." }), act({ type: "notify", to: "owner", message: "{{client}} has not answered the proposal in 7 days. Your manager has been told." })]),
          ],
          [stop("The proposal was answered")],
        ),
      ],
    },
  },
  {
    key: "wf_creative_scheduled",
    name: "Approved creative moves to Scheduled",
    description: "When a client approves a creative it moves to Scheduled and the client manager gets a task to pick the post date.",
    area: "Delivery",
    workflow: {
      name: "Approved creative to Scheduled",
      trigger: "deliverable_approved",
      steps: [act({ type: "set_status", status: "scheduled" }), act({ type: "create_task", title: "Pick the post date for {{title}} ({{client}})", assignTo: "am", dueInDays: 1 }), act({ type: "notify", to: "am", message: "{{client}} approved {{title}}. It is now Scheduled." })],
    },
  },
  {
    key: "wf_overdue_invoice",
    name: "Overdue invoice: day 1, 7, 14 and 30",
    description: "A polite reminder on day 1, a firmer one on day 7, the Founder is told on day 14, and on day 30 the Founder decides whether to pause the work. Stops as soon as the invoice is paid.",
    area: "Money",
    workflow: {
      name: "Overdue invoice chase",
      trigger: "invoice_overdue",
      triggerArgs: { days: 1 },
      steps: [
        act({ type: "send_client_reminder", message: "Hello! A gentle reminder that invoice {{invoice}} for {{balance}} was due on {{due}}. If you have already paid, thank you and please ignore this. You can pay from the Billing page in your app." }),
        act({ type: "notify", to: "role", role: "finance", message: "Day 1 reminder sent to {{client}} for invoice {{invoice}} ({{balance}})." }),
        wait(6, "days"),
        when(
          [{ field: "record.balance", op: "greater_than", value: "0" }],
          [
            act({ type: "send_client_reminder", message: "Hello, invoice {{invoice}} for {{balance}} is now a week overdue. Please pay from the Billing page or tell us if anything is holding it up." }),
            act({ type: "notify", to: "am", message: "{{client}} is a week late on invoice {{invoice}}. Please give them a call." }),
            wait(7, "days"),
            when(
              [{ field: "record.balance", op: "greater_than", value: "0" }],
              [
                act({ type: "notify", to: "role", role: "founder", message: "{{client}} is 14 days late on invoice {{invoice}} ({{balance}} owed)." }),
                act({ type: "create_task", title: "Call {{client}} about invoice {{invoice}} (14 days late)", assignTo: "am", dueInDays: 0 }),
                wait(16, "days"),
                when(
                  [{ field: "record.balance", op: "greater_than", value: "0" }],
                  [
                    {
                      id: sid("p"),
                      kind: "approval",
                      title: "Pause work for {{client}}? Invoice {{invoice}} is 30 days late ({{balance}})",
                      approverRole: "founder",
                      expiresInDays: 3,
                      approved: [act({ type: "notify", to: "am", message: "The Founder decided to pause work for {{client}} until invoice {{invoice}} is paid. Please tell the client today." }), act({ type: "post_internal_note", message: "Work paused: invoice {{invoice}} is 30 days late ({{balance}})." })],
                      rejected: [act({ type: "notify", to: "role", role: "finance", message: "Keep chasing {{client}} for invoice {{invoice}}: the Founder chose not to pause work." })],
                    },
                  ],
                  [stop("Paid")],
                ),
              ],
              [stop("Paid")],
            ),
          ],
          [stop("Paid")],
        ),
      ],
    },
  },
  {
    key: "wf_sla_75_100",
    name: "Request reply time: warn at 75%, escalate at 100%",
    description: "The client manager is warned when three quarters of the reply time has gone. If nobody replies by the deadline the CM Lead is told.",
    area: "Client requests",
    workflow: {
      name: "Reply time warning and escalation",
      trigger: "request_sla_warning",
      steps: [
        act({ type: "notify", to: "am", message: "{{client}}'s {{type}} request needs a reply by {{due}}." }),
        { id: sid("u"), kind: "wait_until", field: "record.reply_due", offsetDays: 0 },
        when([{ field: "record.replied", op: "equals", value: "no" }], [act({ type: "notify", to: "role", role: "am_lead", message: "Reply time missed for {{client}} ({{type}} request)." }), act({ type: "notify", to: "am", message: "{{client}}'s request missed its reply time. Please reply now." })]),
      ],
    },
  },
  {
    key: "wf_renewal_30d",
    name: "Renewal 30 days before the end date",
    description: "A renewal call task and an AI-drafted note for the client manager 30 days before a project ends. The Founder hears about it if it is still not renewed 2 weeks later.",
    area: "Delivery",
    workflow: {
      name: "Renewal 30 days out",
      trigger: "engagement_renewal_due",
      triggerArgs: { days: 30 },
      steps: [
        act({ type: "create_task", title: "Renewal call with {{client}} ({{service}} ends {{end}})", assignTo: "am", dueInDays: 2 }),
        act({ type: "ai_draft", draft: "client_message", to: "am", instruction: "A friendly renewal message: what we achieved, and a suggestion for the next period." }),
        wait(14, "days"),
        when([{ field: "record.renewed", op: "equals", value: "no" }], [act({ type: "notify", to: "role", role: "founder", message: "{{client}}'s {{service}} ends {{end}} and is not renewed yet." })]),
      ],
    },
  },
  {
    key: "wf_offboarding_reassign",
    name: "Offboarding: hand open work to the manager",
    description: "When HR starts offboarding someone, their open tasks and leads move to their manager, who gets a task to review them.",
    area: "Team",
    workflow: {
      name: "Offboarding handover",
      trigger: "offboarding_started",
      steps: [
        act({ type: "reassign_open_work", to: "manager" }),
        act({ type: "create_task", title: "Review the work handed over from {{person}}", assignTo: "role", role: "hr_ops", dueInDays: 1 }),
        act({ type: "notify", to: "manager", message: "{{person}} is leaving (last day {{last_day}}). Their open tasks and leads are now yours." }),
      ],
    },
  },
];

// ---------------------------------------------------------------------------
// Views

export const WORKFLOW_RUN_STATUSES = ["running", "waiting", "waiting_approval", "done", "failed", "cancelled"] as const;
export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUSES)[number];
export const workflowRunStatusLabels: Record<WorkflowRunStatus, string> = {
  running: "Running",
  waiting: "Waiting",
  waiting_approval: "Waiting for approval",
  done: "Finished",
  failed: "Finished with problems",
  cancelled: "Stopped",
};

export type WorkflowRow = {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  trigger: AutomationTriggerKey;
  triggerLabel: string;
  area: AutomationArea;
  summary: string;
  version: number;
  templateKey: string | null;
  movedFromRule: boolean;
  runCount: number;
  active: number;
  failures30d: number;
  lastRunAt: string | null;
  createdAt: string;
};

export type WorkflowVersionRow = { id: string; number: number; createdAt: string; createdBy: string | null; steps: number; runs: number };

export type WorkflowDetail = WorkflowRow & {
  triggerArgs: Record<string, string | number>;
  start: { match: WorkflowMatch; conditions: WorkflowCondition[] };
  steps: WorkflowStep[];
  watermark: string;
  createdBy: string | null;
  versions: WorkflowVersionRow[];
  stepCounts: Record<string, { at: number; done: number }>;
};

export type WorkflowRunStepRow = { id: string; stepId: string; kind: string; ok: boolean; skipped: boolean; text: string; at: string };
export type WorkflowRunRow = {
  id: string;
  workflowId: string;
  workflowName: string;
  version: number;
  entity: string;
  entityId: string;
  record: string;
  link: string | null;
  status: WorkflowRunStatus;
  /** Plain words: "Waiting until 12 Oct, 10:30" / "Waiting for Asha to approve". */
  where: string;
  wakeAt: string | null;
  failures: number;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
};
export type WorkflowRunDetail = WorkflowRunRow & { steps: WorkflowRunStepRow[]; canCancel: boolean; approvalId: string | null; outline: { stepId: string; text: string; depth: number; state: "done" | "current" | "todo" | "skipped" }[] };
export type WorkflowRunFilters = { workflowId?: string; status?: string; entityId?: string };

export type WorkflowOverview = {
  canManage: boolean;
  stats: { active: number; total: number; runs7d: number; waiting: number; awaitingApproval: number; failures7d: number };
  workflows: WorkflowRow[];
  templates: (WorkflowTemplate & { installed: boolean; summary: string })[];
  automationsToMove: number;
};

export type WorkflowOptions = {
  canManage: boolean;
  users: { id: string; name: string; roles: string[] }[];
  roles: AutomationOption[];
  forms: AutomationOption[];
  customFields: WorkflowCustomFieldRef[];
};

export type WorkflowTestMatch = { entity: string; entityId: string; record: string; link: string | null; alreadyStarted: boolean; beforeStart: boolean; passes: boolean; failedCondition?: string };
export type WorkflowTestResult = { summary: string; considered: number; willStart: number; matches: WorkflowTestMatch[]; outline: string[]; note: string };
export type WorkflowTickResult = { started: number; advanced: number; finished: number; failed: number; tookMs: number };
export type WorkflowMoveResult = { moved: { ruleId: string; ruleName: string; workflowId: string; importedRuns: number }[] };
/** WhatsApp messages workflows queued (they wait here until WhatsApp Business is connected). */
export type WhatsAppQueueRow = { id: string; toName: string | null; toPhone: string; body: string; status: string; link: string | null; source: string; createdAt: string };
