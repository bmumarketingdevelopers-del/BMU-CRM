// v9 operations analytics: team performance, delivery speed, SLA & response, report builder,
// "My performance" for staff and client insights. Every view covers a period (from/to) and, where it makes
// sense, compares with the previous period of the same length.
import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared bits

export type OpsRange = { from: string; to: string; prevFrom: string; prevTo: string; days: number; bucket: "week" | "month" };
export type OpsInsight = { text: string; tone: "default" | "good" | "warn" };
/** A value now and in the previous period (null when there was nothing to measure). */
export type OpsCompare = { value: number | null; prev: number | null };
export type OpsSeries = { labels: string[]; series: { key: string; label: string; values: (number | null)[] }[] };
export type OpsPeriodQuery = { from?: string; to?: string };

// ---------------------------------------------------------------------------
// Team performance

export type OpsPersonRow = {
  id: string;
  name: string;
  department: string | null;
  departmentId: string | null;
  role: string | null;
  completed: number;
  completedPrev: number;
  onTimePct: number | null;
  avgCycleDays: number | null;
  hours: number;
  utilisation: number;
  qcFirstPassPct: number | null;
  qcVersions: number;
  avgRevisionRounds: number | null;
  overdueNow: number;
  openTasks: number;
};

export type OpsDepartmentRow = Omit<OpsPersonRow, "name" | "department" | "departmentId" | "role" | "id"> & { id: string | null; name: string; people: number };

export type OpsTeamView = {
  range: OpsRange;
  productiveHoursPerWeek: number;
  departmentFilter: { id: string; name: string }[];
  /** Department heads only see their own department. */
  lockedDepartmentId: string | null;
  totals: {
    completed: OpsCompare;
    onTimePct: OpsCompare;
    avgCycleDays: OpsCompare;
    hours: OpsCompare;
    utilisation: OpsCompare;
    qcFirstPassPct: OpsCompare;
    overdueNow: number;
  };
  people: OpsPersonRow[];
  departments: OpsDepartmentRow[];
  throughput: OpsSeries;
  /** Open tasks by deadline for the next four weeks, per person (for overload spotting). */
  workload: { weeks: string[]; rows: { id: string; name: string; department: string | null; tasks: number[]; loadPct: number[] }[]; hoursPerTask: number };
  insights: OpsInsight[];
};

// ---------------------------------------------------------------------------
// Delivery speed

export type OpsGateStep = { key: string; label: string; detail: string; avgDays: number | null; medianDays: number | null; count: number; prevAvgDays: number | null };

export type OpsWipRow = {
  id: string;
  title: string;
  type: string;
  client: string;
  clientId: string;
  status: string;
  ageDays: number;
  sinceUpdateDays: number;
  owner: string | null;
  dueAt: string | null;
  overdue: boolean;
};

export type OpsDeliveryView = {
  range: OpsRange;
  totals: {
    approved: OpsCompare;
    avgCycleDays: OpsCompare;
    qcPassRate: OpsCompare;
    onTimePct: OpsCompare;
    avgRevisionRounds: OpsCompare;
  };
  steps: OpsGateStep[];
  bottleneck: string | null;
  byType: { type: string; count: number; avgDays: number | null; prevAvgDays: number | null }[];
  revisions: { label: string; count: number }[];
  qcTrend: OpsSeries;
  onTimeTrend: OpsSeries;
  wip: OpsWipRow[];
  insights: OpsInsight[];
};

// ---------------------------------------------------------------------------
// SLA & response

export type OpsSlaTypeRow = { type: string; label: string; targetMin: number; count: number; avgReplyMin: number | null; medianReplyMin: number | null; withinPct: number | null; prevWithinPct: number | null; breaches: number };
export type OpsAmRow = { id: string; name: string; requests: number; avgReplyMin: number | null; withinPct: number | null; breaches: number };
export type OpsOpenRequestRow = { id: string; client: string; clientId: string; type: string; typeLabel: string; description: string; status: string; createdAt: string; waitingMin: number; replied: boolean; pastSla: boolean; am: string | null };

export type OpsSlaView = {
  range: OpsRange;
  totals: { requests: OpsCompare; withinPct: OpsCompare; avgReplyMin: OpsCompare; breaches: OpsCompare; openPastSla: number };
  byType: OpsSlaTypeRow[];
  trend: OpsSeries;
  heatmap: { rows: string[]; cols: string[]; requests: number[][]; breaches: number[][] };
  ams: OpsAmRow[];
  messages: { rule: string; clientMessages: number; replied: number; sameDayPct: OpsCompare; avgReplyMin: number | null } | null;
  slowest: OpsOpenRequestRow[];
  insights: OpsInsight[];
};

// ---------------------------------------------------------------------------
// Report builder

export const OPS_METRICS = [
  "revenue_raised",
  "revenue_collected",
  "leads",
  "proposals_sent",
  "proposals_won",
  "tasks_completed",
  "hours_logged",
  "requests",
  "sla_breaches",
  "qc_pass_rate",
  "new_clients",
] as const;
export type OpsMetric = (typeof OPS_METRICS)[number];

export const OPS_DIMENSIONS = ["month", "week", "service", "department", "person", "client", "lead_source", "request_type"] as const;
export type OpsDimension = (typeof OPS_DIMENSIONS)[number];

export const OPS_CHARTS = ["line", "columns", "bars", "table"] as const;
export type OpsChart = (typeof OPS_CHARTS)[number];

export const opsMetricInfo: Record<OpsMetric, { label: string; unit: "count" | "paise" | "pct" | "hours"; money: boolean; dimensions: OpsDimension[]; hint: string }> = {
  revenue_raised: { label: "Revenue raised", unit: "paise", money: true, dimensions: ["month", "week", "service", "client"], hint: "Invoices raised, before GST, cancelled ones left out" },
  revenue_collected: { label: "Revenue collected", unit: "paise", money: true, dimensions: ["month", "week", "service", "client"], hint: "Payments received, including GST" },
  leads: { label: "Leads", unit: "count", money: false, dimensions: ["month", "week", "service", "person", "lead_source"], hint: "New leads added" },
  proposals_sent: { label: "Proposals sent", unit: "count", money: false, dimensions: ["month", "week", "person", "lead_source"], hint: "Proposals sent to a lead" },
  proposals_won: { label: "Proposals won", unit: "count", money: false, dimensions: ["month", "week", "person", "lead_source"], hint: "Proposals accepted and signed" },
  tasks_completed: { label: "Tasks completed", unit: "count", money: false, dimensions: ["month", "week", "service", "department", "person", "client"], hint: "Tasks marked done" },
  hours_logged: { label: "Hours logged", unit: "hours", money: false, dimensions: ["month", "week", "service", "department", "person", "client"], hint: "Time logged on tasks finished in the period" },
  requests: { label: "Client requests", unit: "count", money: false, dimensions: ["month", "week", "service", "person", "client", "request_type"], hint: "Requests raised by clients (person = Account Manager)" },
  sla_breaches: { label: "Reply times missed", unit: "count", money: false, dimensions: ["month", "week", "service", "person", "client", "request_type"], hint: "Requests answered after the reply target, or still waiting past it" },
  qc_pass_rate: { label: "QC pass rate", unit: "pct", money: false, dimensions: ["month", "week", "service", "department", "person", "client"], hint: "Share of QC checks that passed (person = who made the version)" },
  new_clients: { label: "New clients", unit: "count", money: false, dimensions: ["month", "week", "service", "person", "lead_source"], hint: "Client accounts created (person = Account Manager)" },
};

export const opsDimensionLabels: Record<OpsDimension, string> = {
  month: "Month",
  week: "Week",
  service: "Service",
  department: "Department",
  person: "Person",
  client: "Client",
  lead_source: "Lead source",
  request_type: "Request type",
};

export const opsChartLabels: Record<OpsChart, string> = { line: "Line", columns: "Columns", bars: "Bar list", table: "Table only" };

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}/, "Pick a valid date");

export const opsExploreSchema = z
  .object({
    metric: z.enum(OPS_METRICS, { error: "Pick a metric" }),
    dimension: z.enum(OPS_DIMENSIONS, { error: "Pick how to group it" }),
    from: isoDay,
    to: isoDay,
    preset: z.string().max(20).optional(),
    chart: z.enum(OPS_CHARTS).default("columns"),
  })
  .refine((c) => opsMetricInfo[c.metric].dimensions.includes(c.dimension), { message: "That grouping is not available for this metric" })
  .refine((c) => c.from.slice(0, 10) <= c.to.slice(0, 10), { message: "The start date must be before the end date" });
export type OpsExploreConfig = z.infer<typeof opsExploreSchema>;

export type OpsExploreResult = {
  config: OpsExploreConfig;
  metricLabel: string;
  dimensionLabel: string;
  unit: "count" | "paise" | "pct" | "hours";
  rows: { key: string; label: string; value: number; count?: number; href?: string }[];
  total: number | null;
  prevTotal: number | null;
  range: OpsRange;
};

export const opsSaveReportSchema = z.object({
  name: z.string().trim().min(1, "Give the report a name").max(80),
  config: opsExploreSchema,
  pinned: z.boolean().optional(),
  shared: z.boolean().optional(),
});
export type OpsSaveReport = z.infer<typeof opsSaveReportSchema>;

export const opsUpdateReportSchema = z.object({
  name: z.string().trim().min(1, "Give the report a name").max(80).optional(),
  config: opsExploreSchema.optional(),
  pinned: z.boolean().optional(),
  shared: z.boolean().optional(),
});
export type OpsUpdateReport = z.infer<typeof opsUpdateReportSchema>;

export type OpsSavedReport = { id: string; name: string; config: OpsExploreConfig; pinned: boolean; shared: boolean; owner: string; mine: boolean; updatedAt: string };
export type OpsReportsList = { mine: OpsSavedReport[]; shared: OpsSavedReport[]; canSeeMoney: boolean };

// ---------------------------------------------------------------------------
// My performance

export type OpsMyView = {
  range: OpsRange;
  name: string;
  stats: { completed: OpsCompare; onTimePct: OpsCompare; hours: OpsCompare; qcFirstPassPct: OpsCompare; avgCycleDays: OpsCompare; streakDays: number };
  teamAverage: { completed: number | null; onTimePct: number | null; hours: number | null; qcFirstPassPct: number | null; people: number };
  trend: OpsSeries;
  upcoming: { days: { date: string; label: string; count: number }[]; tasks: { id: string; title: string; deadline: string; status: string; client: string | null }[] };
  recent: { id: string; title: string; client: string | null; deadline: string | null; completedAt: string; onTime: boolean | null; hours: number }[];
  insights: OpsInsight[];
};

// ---------------------------------------------------------------------------
// Client insights

export type OpsClientView = {
  range: OpsRange;
  clientName: string;
  canSeeMoney: boolean;
  totals: { approved: OpsCompare; firstReplyHours: OpsCompare; draftToApprovalDays: OpsCompare; onTimePct: OpsCompare; requests: OpsCompare };
  approvedByMonth: { label: string; value: number }[];
  revisions: { used: number; allowance: number; overAllowance: number };
  requestsByType: { type: string; label: string; count: number }[];
  spendByMonth: { label: string; invoicedPaise: number; paidPaise: number }[] | null;
  spendTotalPaise: number | null;
  delivered: { id: string; title: string; type: string; approvedAt: string; rounds: number; allowance: number; onTime: boolean | null }[];
  insights: OpsInsight[];
};
