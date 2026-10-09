// v9 flows area: business flow map, client journey timelines, founder pulse.

export const FLOW_STAGE_KEYS = ["leads", "proposals", "won", "g1", "g2", "g3", "g4", "g5", "retainer", "offboarding"] as const;
export type FlowStageKey = (typeof FLOW_STAGE_KEYS)[number];
export type FlowSeverity = "ok" | "amber" | "red";

/** One record sitting in a flow stage (a lead, a sent proposal or an engagement). */
export type FlowItem = {
  id: string;
  kind: "lead" | "proposal" | "engagement";
  title: string;
  subtitle: string;
  href: string;
  /** Client 360 link for engagements. */
  clientHref: string | null;
  valuePaise: number | null;
  /** When the item entered this stage. */
  since: string;
  days: number;
  /** Plan deadline for this stage, when there is one. */
  deadline: string | null;
  severity: FlowSeverity;
  /** Plain-English reason it is flagged, e.g. "Past plan deadline by 3 days". */
  reason: string | null;
  owner: string | null;
};

export type FlowNode = {
  key: FlowStageKey;
  label: string;
  /** Short tag shown above the label, e.g. "G2". */
  tag: string;
  hint: string;
  /** Work in progress right now. */
  count: number;
  valuePaise: number | null;
  avgDays: number | null;
  stuckCount: number;
  severity: FlowSeverity;
  /** What counts as stuck here, in plain words. */
  stuckRule: string;
  /** Activity in the selected period, e.g. "6 won in period". */
  periodCount: number;
  periodLabel: string;
  periodValuePaise: number | null;
  items: FlowItem[];
};

export type FlowEdge = {
  from: FlowStageKey;
  to: FlowStageKey;
  /** Items that moved along this connector in the period. */
  throughput: number;
  /** Share that moved on (null when it can't be computed). */
  conversionPct: number | null;
  prevConversionPct: number | null;
  label: string;
};

export type FlowHealth = {
  inFlow: number;
  stuck: number;
  avgLeadToPaidDays: number | null;
  avgPaidToG5Days: number | null;
  prev: { avgLeadToPaidDays: number | null; avgPaidToG5Days: number | null };
};

export type FlowMap = {
  from: string;
  to: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  health: FlowHealth;
  insights: { text: string; tone: "default" | "good" | "warn" }[];
};

/** Per-gate summary strip for the projects board. */
export type FlowGateStrip = { gate: string; count: number; avgDays: number | null; stuck: number }[];

// ---------------------------------------------------------------------------
// Journey

export type FlowJourneyEventKind =
  | "proposal_accepted"
  | "paid"
  | "started"
  | "requirement"
  | "gate"
  | "plan_sent"
  | "plan_changes"
  | "plan_internal"
  | "tasks_generated"
  | "version_uploaded"
  | "qc"
  | "version_sent"
  | "version_approved"
  | "version_changes"
  | "invoice_issued"
  | "invoice_paid"
  | "sign_off"
  | "files_released";

export type FlowJourneyEvent = {
  id: string;
  kind: FlowJourneyEventKind;
  /** Set on gate milestones (G1–G5). */
  gate: string | null;
  title: string;
  detail: string | null;
  /** Actual date; null for steps that haven't happened yet. */
  at: string | null;
  /** Planned date where a plan deadline exists. */
  plannedAt: string | null;
  state: "done" | "current" | "upcoming";
  timing: "early" | "on_time" | "late" | null;
  /** Whole days late (positive) or early (negative) against the plan. */
  varianceDays: number | null;
  /** Staff-only events (never sent to client users). */
  internal: boolean;
};

export type FlowJourneyGate = {
  gate: string;
  name: string;
  passedAt: string | null;
  plannedAt: string | null;
  /** Days since the previous gate (or the start) for passed gates. */
  daysFromPrevious: number | null;
};

export type FlowJourney = {
  engagement: { id: string; serviceName: string; tier: string; billingType: string; status: string; currentGate: string; clientName: string; startDate: string | null };
  gates: FlowJourneyGate[];
  events: FlowJourneyEvent[];
  summary: string;
};

export type FlowJourneyOption = { id: string; serviceName: string; status: string; currentGate: string; clientName: string };

// ---------------------------------------------------------------------------
// Founder pulse

export type FlowPulse = {
  asOf: string;
  month: string;
  revenueMonthPaise: number;
  targetPaise: number | null;
  collectedMonthPaise: number;
  outstandingPaise: number;
  overdueInvoices: number;
  openLeads: number;
  stuckItems: number;
  requestsPastSla: number;
  tasksOverdue: number;
  stages: { key: FlowStageKey; label: string; tag: string; count: number; stuck: number }[];
  needsYou: { id: string; title: string; detail: string; tone: "warn" | "bad" | "default"; href: string }[];
};
