// v20 metric layer: every number is defined once here (formula, unit, which way is good, who may see it) and used
// by dashboards, alerts, scheduled reports, goals, the AI analyst and the forecast service, so the same metric always
// shows the same number. Plus the pure scoring rules behind forecasts (shared so they can be tested and explained).
import { z } from "zod";
import { formatINR } from "../money.js";
import { OPS_METRICS, opsMetricInfo, type OpsMetric } from "../ops-analytics-types.js";

export type MetricUnit = "count" | "paise" | "pct" | "hours";
/** command: Command Centre readers; money: roles that see money numbers. */
export type MetricAudience = "command" | "money";

export type MetricDef = {
  key: string;
  label: string;
  unit: MetricUnit;
  /** Which way is good. */
  direction: "higher" | "lower";
  /** The formula in plain words, shown next to the number everywhere. */
  formula: string;
  audience: MetricAudience;
  /** Can be measured for one client (used by per-client alerts). */
  clientScoped: boolean;
  /** A "right now" number (MRR, overdue tasks) rather than a total over a period. */
  snapshot: boolean;
  /** Computed by the Report Builder engine (same numbers as Analytics → Explore). */
  explore?: OpsMetric;
};

const opsMetric = (k: OpsMetric): MetricDef => ({
  key: k,
  label: opsMetricInfo[k].label,
  unit: opsMetricInfo[k].unit,
  direction: k === "sla_breaches" ? "lower" : "higher",
  formula: opsMetricInfo[k].hint,
  audience: opsMetricInfo[k].money ? "money" : "command",
  clientScoped: opsMetricInfo[k].dimensions.includes("client"),
  snapshot: false,
  explore: k,
});

export const METRICS: MetricDef[] = [
  { key: "mrr", label: "Monthly recurring revenue", unit: "paise", direction: "higher", formula: "Monthly fee of every live retainer today, before GST", audience: "money", clientScoped: true, snapshot: true },
  { key: "pipeline_value", label: "Weighted pipeline", unit: "paise", direction: "higher", formula: "Each open deal's value × the chance of winning at its stage (Settings → Forecast)", audience: "money", clientScoped: false, snapshot: true },
  { key: "win_rate", label: "Win rate", unit: "pct", direction: "higher", formula: "Leads won ÷ leads decided (won + lost) in the period", audience: "command", clientScoped: false, snapshot: false },
  { key: "on_time_pct", label: "On-time delivery", unit: "pct", direction: "higher", formula: "Tasks finished by their deadline ÷ tasks with a deadline finished in the period", audience: "command", clientScoped: true, snapshot: false },
  { key: "overdue_tasks", label: "Overdue tasks", unit: "count", direction: "lower", formula: "Open tasks past their deadline right now", audience: "command", clientScoped: true, snapshot: true },
  { key: "utilisation_pct", label: "Utilisation", unit: "pct", direction: "higher", formula: "Hours logged ÷ hours available (weekly hours less leave and holidays) in the period", audience: "command", clientScoped: false, snapshot: false },
  { key: "profit_margin_pct", label: "Profit margin", unit: "pct", direction: "higher", formula: "Profit ÷ revenue in the period (Money → Profit)", audience: "money", clientScoped: false, snapshot: false },
  { key: "active_clients", label: "Active clients", unit: "count", direction: "higher", formula: "Clients with at least one live engagement today", audience: "command", clientScoped: false, snapshot: true },
  { key: "client_activity", label: "Client activity", unit: "count", direction: "higher", formula: "Requests, approvals and messages from the client's own people in the period", audience: "command", clientScoped: true, snapshot: false },
  ...OPS_METRICS.map(opsMetric),
];

export const METRIC_KEYS = METRICS.map((m) => m.key);
export const metricDef = (key: string) => METRICS.find((m) => m.key === key) ?? null;

/** Who may see a metric: money metrics need money access; the rest need Command Centre access. */
export function canSeeMetric(def: MetricDef, access: { command: boolean; money: boolean }) {
  return def.audience === "money" ? access.money : access.command;
}

export function formatMetric(value: number | null | undefined, unit: MetricUnit): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  switch (unit) {
    case "paise":
      return formatINR(Math.round(value));
    case "pct":
      return `${Math.round(value * 10) / 10}%`;
    case "hours":
      return `${Math.round(value * 10) / 10} h`;
    default:
      return new Intl.NumberFormat("en-IN").format(Math.round(value * 10) / 10);
  }
}

/** Percentage change from `prev` to `cur`; null when there is no baseline. */
export function pctChange(cur: number | null, prev: number | null): number | null {
  if (cur === null || prev === null || prev === 0) return null;
  return Math.round(((cur - prev) / Math.abs(prev)) * 1000) / 10;
}

// ------------------------------------------------------------------------------------------------ anomaly alerts

export const ALERT_CONDITIONS = ["drop_pct", "rise_pct", "above", "below"] as const;
export type AlertCondition = (typeof ALERT_CONDITIONS)[number];
export const alertConditionLabels: Record<AlertCondition, string> = {
  drop_pct: "drops by at least (%)",
  rise_pct: "rises by at least (%)",
  above: "goes above",
  below: "goes below",
};

/**
 * Whether an alert fires. drop/rise compare this window with the window before it and ignore tiny baselines
 * (fewer than `minBaseline`) so one request turning into none doesn't page anyone.
 */
export function alertFires(condition: AlertCondition, threshold: number, cur: number | null, prev: number | null, minBaseline = 3): boolean {
  if (cur === null) return false;
  switch (condition) {
    case "above":
      return cur > threshold;
    case "below":
      return cur < threshold;
    case "drop_pct":
      return prev !== null && prev >= minBaseline && ((prev - cur) / prev) * 100 >= threshold;
    case "rise_pct":
      return prev !== null && prev >= minBaseline && ((cur - prev) / prev) * 100 >= threshold;
  }
}

export const metricAlertSchema = z
  .object({
    name: z.string().trim().min(3, "Give the alert a name").max(80),
    metricKey: z.string().refine((k) => METRIC_KEYS.includes(k), "Pick a metric"),
    scope: z.enum(["org", "each_client", "client"]).default("org"),
    clientOrgId: z.string().nullable().optional(),
    condition: z.enum(ALERT_CONDITIONS),
    threshold: z.number().min(0).max(1e12),
    windowDays: z.number().int().min(1).max(90).default(7),
    roles: z.array(z.string()).max(20).default([]),
    userIds: z.array(z.string()).max(50).default([]),
    active: z.boolean().default(true),
  })
  .refine((a) => a.scope !== "client" || !!a.clientOrgId, { message: "Pick the client", path: ["clientOrgId"] })
  .refine((a) => a.scope === "org" || metricDef(a.metricKey)?.clientScoped, { message: "That metric can't be measured per client", path: ["scope"] })
  .refine((a) => a.roles.length + a.userIds.length > 0, { message: "Pick who gets the alert", path: ["roles"] });
export type MetricAlertInput = z.input<typeof metricAlertSchema>;

export type MetricAlertView = {
  id: string;
  name: string;
  metricKey: string;
  metricLabel: string;
  scope: "org" | "each_client" | "client";
  clientOrgId: string | null;
  clientName: string | null;
  condition: AlertCondition;
  threshold: number;
  windowDays: number;
  roles: string[];
  userIds: string[];
  active: boolean;
  builtIn: boolean;
  lastValue: number | null;
  lastCheckedAt: string | null;
  lastFiredAt: string | null;
  summary: string;
};
export type MetricAlertEventView = { id: string; alertId: string; alertName: string; subject: string; value: number; baseline: number | null; message: string; createdAt: string };

/** The alerts every organisation starts with (they can be switched off or changed). */
export const BUILT_IN_ALERTS: Omit<MetricAlertInput, "active">[] = [
  { name: "A client's activity drops 40%", metricKey: "client_activity", scope: "each_client", condition: "drop_pct", threshold: 40, windowDays: 30, roles: ["founder", "am_lead"], userIds: [] },
  { name: "Missed reply times double", metricKey: "sla_breaches", scope: "org", condition: "rise_pct", threshold: 100, windowDays: 7, roles: ["founder", "am_lead"], userIds: [] },
  { name: "Collections drop 30%", metricKey: "revenue_collected", scope: "org", condition: "drop_pct", threshold: 30, windowDays: 30, roles: ["founder", "finance"], userIds: [] },
  { name: "More than 20 overdue tasks", metricKey: "overdue_tasks", scope: "org", condition: "above", threshold: 20, windowDays: 1, roles: ["founder", "department_head"], userIds: [] },
];

export function describeAlert(a: { metricKey: string; scope: string; condition: AlertCondition; threshold: number; windowDays: number }, clientName?: string | null) {
  const m = metricDef(a.metricKey);
  const label = m?.label ?? a.metricKey;
  const who = a.scope === "each_client" ? " for any client" : a.scope === "client" ? ` for ${clientName ?? "one client"}` : "";
  const val = a.condition === "above" || a.condition === "below" ? formatMetric(a.threshold, m?.unit ?? "count") : `${a.threshold}%`;
  const window = a.condition === "drop_pct" || a.condition === "rise_pct" ? ` (last ${a.windowDays} days vs the ${a.windowDays} before)` : "";
  return `When ${label.toLowerCase()}${who} ${alertConditionLabels[a.condition].replace(" (%)", "")} ${val}${window}`;
}

// ------------------------------------------------------------------------------------------------ scheduled reports

export const REPORT_CADENCES = ["daily", "weekly", "monthly"] as const;
export type ReportCadence = (typeof REPORT_CADENCES)[number];

export const scheduledReportSchema = z
  .object({
    name: z.string().trim().min(3, "Give the report a name").max(80),
    kind: z.enum(["metrics", "dashboard"]).default("metrics"),
    dashboardId: z.string().nullable().optional(),
    metricKeys: z.array(z.string().refine((k) => METRIC_KEYS.includes(k), "Unknown metric")).max(20).default([]),
    cadence: z.enum(REPORT_CADENCES),
    dayOfWeek: z.number().int().min(0).max(6).nullable().optional(),
    dayOfMonth: z.number().int().min(1).max(28).nullable().optional(),
    hourIst: z.number().int().min(0).max(23).default(9),
    recipients: z.array(z.string().trim().email("Each recipient needs a valid email")).min(1, "Add at least one recipient").max(20),
    active: z.boolean().default(true),
  })
  .refine((r) => r.kind !== "metrics" || r.metricKeys.length > 0, { message: "Pick at least one number", path: ["metricKeys"] })
  .refine((r) => r.kind !== "dashboard" || !!r.dashboardId, { message: "Pick the dashboard", path: ["dashboardId"] });
export type ScheduledReportInput = z.input<typeof scheduledReportSchema>;
export type ScheduledReportView = {
  id: string;
  name: string;
  kind: "metrics" | "dashboard";
  dashboardId: string | null;
  dashboardName: string | null;
  metricKeys: string[];
  cadence: ReportCadence;
  dayOfWeek: number | null;
  dayOfMonth: number | null;
  hourIst: number;
  recipients: string[];
  active: boolean;
  nextRunAt: string;
  lastSentAt: string | null;
  lastError: string | null;
  schedule: string;
};

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export function describeSchedule(r: { cadence: ReportCadence; dayOfWeek?: number | null; dayOfMonth?: number | null; hourIst: number }) {
  const at = `${String(r.hourIst).padStart(2, "0")}:00 IST`;
  if (r.cadence === "daily") return `Every day at ${at}`;
  if (r.cadence === "weekly") return `Every ${DAYS[r.dayOfWeek ?? 1]} at ${at}`;
  return `On day ${r.dayOfMonth ?? 1} of each month at ${at}`;
}

/** The next time a schedule is due after `from` (IST wall clock). */
export function nextReportRun(r: { cadence: ReportCadence; dayOfWeek?: number | null; dayOfMonth?: number | null; hourIst: number }, from = new Date()): Date {
  const IST = 330 * 60_000;
  const local = new Date(from.getTime() + IST);
  for (let i = 0; i < 70; i++) {
    const d = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + i, r.hourIst));
    const ok = r.cadence === "daily" || (r.cadence === "weekly" && d.getUTCDay() === (r.dayOfWeek ?? 1)) || (r.cadence === "monthly" && d.getUTCDate() === (r.dayOfMonth ?? 1));
    const at = new Date(d.getTime() - IST);
    if (ok && at > from) return at;
  }
  return new Date(from.getTime() + 86_400_000);
}

// ------------------------------------------------------------------------------------------------ goals

export const GOAL_LEVELS = ["company", "team", "person"] as const;
export type GoalLevel = (typeof GOAL_LEVELS)[number];
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a date");

export const goalSchema = z
  .object({
    title: z.string().trim().min(3, "Name the goal").max(120),
    level: z.enum(GOAL_LEVELS),
    ownerId: z.string().nullable().optional(),
    departmentId: z.string().nullable().optional(),
    metricKey: z.string().nullable().optional(),
    direction: z.enum(["higher", "lower"]).default("higher"),
    startValue: z.number().default(0),
    target: z.number(),
    unit: z.string().trim().max(20).default(""),
    startDate: isoDate,
    endDate: isoDate,
  })
  .refine((g) => g.startDate < g.endDate, { message: "The end date must be after the start", path: ["endDate"] })
  .refine((g) => !g.metricKey || METRIC_KEYS.includes(g.metricKey), { message: "Pick a metric", path: ["metricKey"] })
  .refine((g) => !g.metricKey || g.level === "company", { message: "Only company goals follow a metric automatically; team and personal goals use check-ins", path: ["metricKey"] })
  .refine((g) => g.level !== "team" || !!g.departmentId, { message: "Pick the team", path: ["departmentId"] })
  .refine((g) => g.target !== g.startValue, { message: "The target must differ from the starting value", path: ["target"] });
export type GoalInput = z.input<typeof goalSchema>;
export const goalCheckInSchema = z.object({ value: z.number(), note: z.string().trim().max(500).optional() });

export type GoalStatus = "on_track" | "at_risk" | "behind" | "done" | "missed";
export const goalStatusLabels: Record<GoalStatus, string> = { on_track: "On track", at_risk: "At risk", behind: "Behind", done: "Achieved", missed: "Missed" };

/** Progress 0–100 from the starting value towards the target (works for "lower is better" goals too). */
export function goalProgress(g: { startValue: number; target: number }, current: number | null): number {
  if (current === null) return 0;
  const span = g.target - g.startValue;
  if (span === 0) return 100;
  return Math.max(0, Math.min(100, Math.round(((current - g.startValue) / span) * 100)));
}

/** Compares progress with the share of time gone: within 10 points is on track, within 25 at risk. */
export function goalStatus(progress: number, startDate: string, endDate: string, now = new Date()): GoalStatus {
  const s = new Date(`${startDate}T00:00:00+05:30`).getTime();
  const e = new Date(`${endDate}T23:59:59+05:30`).getTime();
  if (progress >= 100) return "done";
  if (now.getTime() > e) return "missed";
  const elapsed = Math.max(0, Math.min(100, ((now.getTime() - s) / (e - s)) * 100));
  if (progress >= elapsed - 10) return "on_track";
  if (progress >= elapsed - 25) return "at_risk";
  return "behind";
}

export type GoalView = {
  id: string;
  title: string;
  level: GoalLevel;
  owner: { id: string; name: string } | null;
  department: { id: string; name: string } | null;
  metricKey: string | null;
  metricLabel: string | null;
  direction: "higher" | "lower";
  startValue: number;
  target: number;
  current: number | null;
  unit: string;
  display: { current: string; target: string };
  progress: number;
  status: GoalStatus;
  startDate: string;
  endDate: string;
  checkIns: { id: string; value: number; note: string | null; by: string; createdAt: string }[];
  canEdit: boolean;
  canCheckIn: boolean;
};

// ------------------------------------------------------------------------------------------------ forecasting rules

/** Why a forecast says what it says: each reason with how much it moved the score (points) or value. */
export type ForecastReason = { label: string; impact: number; detail?: string };

/** Least-squares line through equally spaced points; `at(k)` is the value k steps after the last point. */
export function linearTrend(values: number[]) {
  const n = values.length;
  if (n === 0) return { slope: 0, intercept: 0, at: () => 0 };
  const mx = (n - 1) / 2;
  const my = values.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let den = 0;
  values.forEach((v, i) => {
    num += (i - mx) * (v - my);
    den += (i - mx) ** 2;
  });
  const slope = den ? num / den : 0;
  const intercept = my - slope * mx;
  return { slope, intercept, at: (k: number) => intercept + slope * (n - 1 + k) };
}

/** Holt's linear exponential smoothing (level + trend). Same method as the optional Python service. */
export function holtForecast(values: number[], horizon: number, alpha = 0.5, beta = 0.3): number[] {
  if (!values.length) return Array(horizon).fill(0);
  if (values.length === 1) return Array(horizon).fill(values[0]);
  let level = values[0];
  let trend = values[1] - values[0];
  for (let i = 1; i < values.length; i++) {
    const prevLevel = level;
    level = alpha * values[i] + (1 - alpha) * (level + trend);
    trend = beta * (level - prevLevel) + (1 - beta) * trend;
  }
  return Array.from({ length: horizon }, (_, k) => Math.max(0, level + trend * (k + 1)));
}

export type ChurnSignals = {
  healthScore: number;
  healthReasons: string[];
  /** Days until the last live retainer ends with no renewal raised (null when open-ended). */
  endsInDays: number | null;
  /** Change in client activity, last 30 days vs the 30 before (%), null without a baseline. */
  activityChangePct: number | null;
  tenureDays: number;
  /** Share of MRR this client pays (0–100), to rank who matters most. */
  mrrSharePct: number;
};

/** Churn risk 0–100 with the reasons that drove it. */
export function churnRisk(s: ChurnSignals): { score: number; reasons: ForecastReason[] } {
  const reasons: ForecastReason[] = [];
  const add = (impact: number, label: string, detail?: string) => {
    if (impact > 0) reasons.push({ label, impact, detail });
  };
  // The health score's lost points carry over (at 60% weight), each with its own reason.
  const lost = Math.max(0, 100 - s.healthScore);
  if (lost > 0) {
    const each = s.healthReasons.length ? (lost * 0.6) / s.healthReasons.length : 0;
    for (const r of s.healthReasons) add(Math.round(each), r);
  }
  if (s.endsInDays !== null && s.endsInDays <= 45) add(s.endsInDays <= 15 ? 25 : 15, `Retainer ends in ${Math.max(0, s.endsInDays)} days with no renewal yet`);
  if (s.activityChangePct !== null && s.activityChangePct <= -30) add(s.activityChangePct <= -60 ? 20 : 12, `Client activity down ${Math.abs(Math.round(s.activityChangePct))}% on the month before`);
  if (s.tenureDays < 90) add(8, "New client (first three months carry the most churn)");
  const score = Math.max(0, Math.min(100, Math.round(reasons.reduce((t, r) => t + r.impact, 0))));
  reasons.sort((a, b) => b.impact - a.impact);
  return { score, reasons };
}

export type WinSignals = {
  stageProbabilityPct: number;
  stageLabel: string;
  leadScore: number;
  daysSinceActivity: number;
  proposalViews: number;
  followUpOverdue: boolean;
  ageDays: number;
};

/** Chance of winning a deal (2–95%): the stage's probability adjusted by what we know about this deal. */
export function winProbability(s: WinSignals): { score: number; reasons: ForecastReason[] } {
  const reasons: ForecastReason[] = [{ label: `${s.stageLabel} stage: ${s.stageProbabilityPct}% of deals at this stage are won`, impact: s.stageProbabilityPct }];
  const add = (impact: number, label: string) => impact !== 0 && reasons.push({ label, impact });
  if (s.leadScore >= 70) add(10, `Strong lead score (${s.leadScore}/100)`);
  else if (s.leadScore < 30) add(-10, `Weak lead score (${s.leadScore}/100)`);
  if (s.proposalViews >= 2) add(10, `Proposal opened ${s.proposalViews} times`);
  if (s.daysSinceActivity >= 21) add(-20, `No activity for ${s.daysSinceActivity} days`);
  else if (s.daysSinceActivity >= 10) add(-10, `No activity for ${s.daysSinceActivity} days`);
  if (s.followUpOverdue) add(-8, "Follow-up is overdue");
  if (s.ageDays > 60) add(-10, `Open for ${s.ageDays} days`);
  const score = Math.max(2, Math.min(95, Math.round(reasons.reduce((t, r) => t + r.impact, 0))));
  return { score, reasons };
}

export type SlipSignals = {
  hoursLeft: number;
  estimateHours: number;
  status: string;
  started: boolean;
  ownerLoadPct: number | null;
  hasOwner: boolean;
  deadlineChanges: number;
  openDependencies: number;
};

/** Risk 0–100 that a task misses its deadline. */
export function slipRisk(s: SlipSignals): { score: number; reasons: ForecastReason[] } {
  if (s.hoursLeft < 0) return { score: 100, reasons: [{ label: `Already ${Math.ceil(-s.hoursLeft / 24)} day(s) past the deadline`, impact: 100 }] };
  const reasons: ForecastReason[] = [];
  const add = (impact: number, label: string) => impact > 0 && reasons.push({ label, impact });
  if (s.status === "blocked") add(35, "Blocked");
  if (!s.hasOwner) add(25, "Nobody is assigned");
  if (s.estimateHours > 0 && s.hoursLeft < s.estimateHours * 1.5) add(s.hoursLeft < s.estimateHours ? 30 : 15, `${Math.round(s.estimateHours)} h of work with ${Math.max(0, Math.round(s.hoursLeft))} working hours left`);
  if (!s.started && s.hoursLeft <= 24) add(20, "Not started and due within a day");
  if (s.ownerLoadPct !== null && s.ownerLoadPct > 110) add(s.ownerLoadPct > 140 ? 25 : 15, `Owner is booked at ${s.ownerLoadPct}% this week`);
  if (s.deadlineChanges >= 2) add(10, `Deadline already moved ${s.deadlineChanges} times`);
  if (s.openDependencies > 0) add(15, `Waiting on ${s.openDependencies} earlier task${s.openDependencies === 1 ? "" : "s"}`);
  const score = Math.max(0, Math.min(99, Math.round(reasons.reduce((t, r) => t + r.impact, 0))));
  reasons.sort((a, b) => b.impact - a.impact);
  return { score, reasons };
}

// ------------------------------------------------------------------------------------------------ views

export type MetricValueView = { key: string; label: string; unit: MetricUnit; direction: "higher" | "lower"; formula: string; value: number | null; previous: number | null; changePct: number | null; display: string; from: string; to: string };

export type ForecastView = {
  kind: "revenue" | "churn" | "win" | "slip" | "capacity";
  subjectType: string;
  subjectId: string;
  title: string;
  href: string | null;
  period: string;
  value: number;
  score: number | null;
  reasons: ForecastReason[];
  source: "ts" | "python";
  computedAt: string;
};

export type IntelligenceOverview = {
  computedAt: string | null;
  source: "ts" | "python" | null;
  pythonAvailable: boolean;
  revenue: { months: { period: string; label: string; expectedPaise: number; lowPaise: number; highPaise: number; trendPaise: number }[]; reasons: ForecastReason[]; nextMonthPaise: number; targetPaise: number } | null;
  churn: ForecastView[];
  win: ForecastView[];
  slip: ForecastView[];
  capacity: ForecastView[];
  alerts: MetricAlertEventView[];
  goals: GoalView[];
};
