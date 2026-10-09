// v15 AI agents: the agent list, the action catalogue with its approval policy, and the shapes the Agents page,
// run log and Agent Inbox use. The API enforces every rule here; the web only shows it.
import { z } from "zod";
import type { AiCitation, AiMode } from "./ai-flows.js";

export const AGENT_KEYS = ["sales_assistant", "request_triage", "producer", "analyst", "creative_reviewer", "finance_collector"] as const;
export type AgentKey = (typeof AGENT_KEYS)[number];

/** Agents shown as "coming later" on the Agents page (not built yet). */
export const AGENTS_LATER = [
  { key: "am_assistant", label: "AM assistant", summary: "Prepares client check-ins and spots unhappy clients early." },
] as const;

export type AgentInfo = {
  label: string;
  summary: string;
  /** What starts it, in plain words. */
  when: string;
  /** What it does on its own and what it asks about. */
  does: string[];
  /** Roles that can sensibly be "acted for" (suggestion only; the person's own permissions decide). */
  suggestedActsFor: string[];
};

export const agentInfo: Record<AgentKey, AgentInfo> = {
  sales_assistant: {
    label: "Sales assistant",
    summary: "Looks at every new lead within a minute, scores it, writes a short brief and drafts the first reply.",
    when: "A new lead arrives (website, form or added by hand). Every morning it also flags deals that have gone quiet.",
    does: ["Scores the lead and adds a brief as a note", "Sets a follow-up date", "Drafts the first reply (waits in the Agent Inbox)", "Suggests an owner when nobody has the lead (waits in the Agent Inbox)", "Reminds owners about quiet deals"],
    suggestedActsFor: ["sales_manager", "founder"],
  },
  request_triage: {
    label: "Request triage",
    summary: "Reads every new client request, works out what kind it is and how urgent, and drafts the acknowledgement.",
    when: "A client raises a new request.",
    does: ["Adds an internal note with the type, urgency and scope", "Tells the account manager straight away when it is urgent", "Suggests the right request type (waits in the Agent Inbox)", "Suggests who should handle it (waits in the Agent Inbox)", "Drafts the acknowledgement to the client (waits in the Agent Inbox)"],
    suggestedActsFor: ["am_lead", "founder"],
  },
  producer: {
    label: "Producer",
    summary: "Checks the team's work every morning: chases overdue tasks and suggests moving work off people who are on leave or overloaded.",
    when: "Every morning at 10:00, or when you press Run now.",
    does: ["Reminds owners about overdue tasks", "Suggests moving work when someone is on leave on the deadline (waits in the Agent Inbox)", "Suggests moving work off overloaded people (waits in the Agent Inbox)", "Suggests booking a free specialist for skill requests on the workload board (waits in the Agent Inbox; never someone on approved leave)"],
    suggestedActsFor: ["department_head", "admin", "founder"],
  },
  analyst: {
    label: "Analyst",
    summary: "Answers questions about the business with links to where each fact came from, and writes a monthly report for the Founder.",
    when: "When someone asks it a question, and on the 1st of every month for the report.",
    does: ["Answers questions using only what the acting person can see", "Shows the sources for every answer", "Writes the monthly founder report and sends it as a notification"],
    suggestedActsFor: ["founder"],
  },
  creative_reviewer: {
    label: "Creative reviewer",
    summary: "Checks every new draft against the client's brand kit before QC and leaves an internal checklist for the QC reviewer.",
    when: "A new version is uploaded and goes to QC.",
    does: ["Adds an internal brand check note on the version (the client never sees it)", "With an AI key, looks at the image itself: colours, logo, text, do's and don'ts", "Tells the maker straight away when something clearly breaks the brand kit"],
    suggestedActsFor: ["department_head", "founder"],
  },
  finance_collector: {
    label: "Finance collector",
    summary: "Every morning it matches money that came in without an invoice, chases overdue invoices politely and flags expenses nobody has billed.",
    when: "Every morning at 10:00, or when you press Run now.",
    does: ["Suggests which invoice an unmatched payment belongs to (waits in the Agent Inbox)", "Suggests a payment reminder for overdue invoices that had none this week (waits in the Agent Inbox)", "Tells Finance about billable expenses not yet re-billed and projects whose costs are running past their fee"],
    suggestedActsFor: ["finance", "founder"],
  },
};

/** auto = does it and logs it; confirm = waits in the Agent Inbox; never = agents can't do it at all. */
export const AGENT_POLICIES = ["auto", "confirm", "never"] as const;
export type AgentPolicy = (typeof AGENT_POLICIES)[number];
export const agentPolicyLabels: Record<AgentPolicy, string> = {
  auto: "Does it, you can undo",
  confirm: "Asks first (Agent Inbox)",
  never: "Never allowed",
};

export const AGENT_ACTIONS = [
  "add_lead_note",
  "set_lead_score",
  "set_lead_follow_up",
  "add_request_note",
  "notify_person",
  "add_version_note",
  "send_lead_reply",
  "reply_to_request",
  "assign_lead",
  "assign_request",
  "set_request_type",
  "reassign_task",
  "book_person",
  "send_payment_reminder",
  "match_payment",
  "delete_record",
  "change_price",
  "create_invoice",
  "issue_refund",
  "change_role",
] as const;
export type AgentAction = (typeof AGENT_ACTIONS)[number];

export type AgentActionInfo = { label: string; policy: AgentPolicy; why: string; clientFacing?: boolean; money?: boolean };

/** The catalogue. Client-facing and money actions are never "auto". */
export const agentActionInfo: Record<AgentAction, AgentActionInfo> = {
  add_lead_note: { label: "Add a note to a lead", policy: "auto", why: "Internal only" },
  set_lead_score: { label: "Set a lead's score", policy: "auto", why: "Internal only" },
  set_lead_follow_up: { label: "Set a follow-up date", policy: "auto", why: "Internal only" },
  add_request_note: { label: "Add an internal note to a request", policy: "auto", why: "Internal only, the client never sees it" },
  notify_person: { label: "Send a team notification", policy: "auto", why: "Internal only" },
  add_version_note: { label: "Add an internal note on a draft", policy: "auto", why: "Internal only, the client never sees it" },
  send_lead_reply: { label: "Reply to a lead", policy: "confirm", why: "Goes to a prospect", clientFacing: true },
  reply_to_request: { label: "Reply to a client request", policy: "confirm", why: "Goes to the client", clientFacing: true },
  assign_lead: { label: "Give a lead to someone", policy: "confirm", why: "Changes someone's work" },
  assign_request: { label: "Give a request to someone", policy: "confirm", why: "Changes someone's work" },
  set_request_type: { label: "Change a request's type", policy: "confirm", why: "The client sees it and it can lead to a quote", clientFacing: true, money: true },
  reassign_task: { label: "Move a task to someone else", policy: "confirm", why: "Changes someone's work and may move a client date" },
  book_person: { label: "Book someone on a project", policy: "confirm", why: "Changes someone's week" },
  send_payment_reminder: { label: "Send a payment reminder", policy: "confirm", why: "Goes to the client and is about money", clientFacing: true, money: true },
  match_payment: { label: "Match a payment to an invoice", policy: "confirm", why: "Marks an invoice paid", money: true },
  delete_record: { label: "Delete anything", policy: "never", why: "Only people delete" },
  change_price: { label: "Change prices or discounts", policy: "never", why: "Money", money: true },
  create_invoice: { label: "Create or send an invoice", policy: "never", why: "Money", money: true },
  issue_refund: { label: "Refund or credit note", policy: "never", why: "Money", money: true },
  change_role: { label: "Change roles or permissions", policy: "never", why: "Access control" },
};

/** Actions each agent may use (its tool list). Anything else is refused by the runtime. */
export const agentActions: Record<AgentKey, AgentAction[]> = {
  sales_assistant: ["add_lead_note", "set_lead_score", "set_lead_follow_up", "notify_person", "send_lead_reply", "assign_lead"],
  request_triage: ["add_request_note", "notify_person", "reply_to_request", "assign_request", "set_request_type"],
  producer: ["notify_person", "reassign_task", "book_person"],
  analyst: ["notify_person"],
  creative_reviewer: ["add_version_note", "notify_person"],
  finance_collector: ["notify_person", "send_payment_reminder", "match_payment"],
};

export const AGENT_RUN_STATUSES = ["running", "done", "failed", "undone"] as const;
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];
export const AGENT_TRIGGERS = ["event", "schedule", "manual", "ask", "eval"] as const;
export type AgentTrigger = (typeof AGENT_TRIGGERS)[number];
export const agentTriggerLabels: Record<AgentTrigger, string> = { event: "New record", schedule: "Scheduled", manual: "Run now", ask: "Question", eval: "Safety check" };

export type AgentStepKind = "read" | "action" | "proposal" | "blocked" | "note" | "error";

export type AgentStepView = {
  id: string;
  seq: number;
  kind: AgentStepKind;
  tool: string | null;
  title: string;
  detail: string | null;
  policy: AgentPolicy | "read" | null;
  ok: boolean;
  link: string | null;
  canUndo: boolean;
  undoneAt: string | null;
  undoneBy: string | null;
  proposalId: string | null;
  at: string;
};

export type AgentRunRow = {
  id: string;
  agentKey: AgentKey;
  agentLabel: string;
  trigger: AgentTrigger;
  subject: { type: string; id: string; label: string; link: string | null } | null;
  status: AgentRunStatus;
  mode: AiMode;
  summary: string | null;
  actions: number;
  proposals: number;
  blocked: number;
  costPaise: number;
  actingFor: string | null;
  startedBy: string | null;
  createdAt: string;
  finishedAt: string | null;
};

export type AgentRunDetail = AgentRunRow & {
  answer: string | null;
  citations: AiCitation[];
  notice: string | null;
  error: string | null;
  steps: AgentStepView[];
  feedback: { value: 1 | -1; by: string; note: string | null } | null;
  canUndo: boolean;
};

export type AgentView = {
  key: AgentKey;
  label: string;
  summary: string;
  when: string;
  does: string[];
  enabled: boolean;
  actsFor: { id: string; name: string; roles: string[] } | null;
  monthlyBudgetPaise: number;
  spentPaise: number;
  runsThisMonth: number;
  lastRunAt: string | null;
  actions: { action: AgentAction; label: string; policy: AgentPolicy; why: string }[];
  thumbsUp: number;
  thumbsDown: number;
};

export type AgentsOverview = {
  agents: AgentView[];
  later: { key: string; label: string; summary: string }[];
  people: { id: string; name: string; roles: string[] }[];
  aiMode: "ai" | "basic" | "off";
  notice: string | null;
  pendingProposals: number;
  knowledge: { chunks: number; sources: { type: string; label: string; count: number }[]; refreshedAt: string | null; search: "full_text" };
  canEdit: boolean;
  recent: AgentRunRow[];
};

export const agentPatchSchema = z.object({
  enabled: z.boolean().optional(),
  actsForUserId: z.string().max(100).nullable().optional(),
  monthlyBudgetPaise: z.number().int().min(0).max(1_00_00_000).optional(),
});
export type AgentPatch = z.infer<typeof agentPatchSchema>;

export const agentAskSchema = z.object({ question: z.string().trim().min(2, "Type a question").max(2000) });
export type AgentAskInput = z.infer<typeof agentAskSchema>;

export const agentFeedbackSchema = z.object({ value: z.union([z.literal(1), z.literal(-1)]), note: z.string().trim().max(1000).optional() });
export type AgentFeedbackInput = z.infer<typeof agentFeedbackSchema>;

export const agentRunNowSchema = z.object({ subjectId: z.string().max(100).optional() });

export type AgentProposalStatus = "pending" | "approved" | "rejected" | "failed" | "expired";

export type AgentProposalField = { key: string; label: string; kind: "text" | "longtext" | "person" | "select"; options?: { value: string; label: string }[] };

export type AgentProposalView = {
  id: string;
  agentKey: AgentKey;
  agentLabel: string;
  action: AgentAction;
  actionLabel: string;
  why: string;
  title: string;
  summary: string;
  payload: Record<string, unknown>;
  fields: AgentProposalField[];
  link: string | null;
  runId: string;
  actingFor: string | null;
  status: AgentProposalStatus;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  error: string | null;
  canDecide: boolean;
  createdAt: string;
  expiresAt: string;
};

export const agentDecideSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  /** Edited values for the proposal's editable fields (text, person…). */
  edits: z.record(z.string(), z.string().max(8000)).optional(),
  note: z.string().trim().max(1000).optional(),
});
export type AgentDecideInput = z.infer<typeof agentDecideSchema>;

export type AgentAskResult = { runId: string; mode: AiMode; text: string; citations: AiCitation[]; notice: string | null };

export type AgentEvalCase = { key: string; label: string; rule: string; passed: boolean; detail: string };
export type AgentEvalResult = { passed: boolean; total: number; failed: number; cases: AgentEvalCase[]; ranAt: string };

export type AgentTickResult = { runs: number; byAgent: Partial<Record<AgentKey, number>> };

export type KnowledgeHit = { id: string; title: string; snippet: string; link: string | null; sourceType: string; score: number };
export const KNOWLEDGE_SOURCES = ["sop", "service", "plan", "brand_kit", "client_note"] as const;
export type KnowledgeSource = (typeof KNOWLEDGE_SOURCES)[number];
export const knowledgeSourceLabels: Record<KnowledgeSource, string> = {
  sop: "SOPs",
  service: "Services & tiers",
  plan: "Approved monthly plans",
  brand_kit: "Brand kits",
  client_note: "Client notes",
};
