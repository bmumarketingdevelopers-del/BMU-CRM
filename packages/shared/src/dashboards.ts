// v12 Dashboard Studio: every dashboard is a layout of widgets. Built-in dashboards (Weekly Review, Scorecard, My Day,
// Manager workspace, Specialist workspace, Client home) are made of their own sections, which can be hidden, moved,
// resized and mixed with library widgets. Custom dashboards are built from the library and shown to chosen people.
import { z } from "zod";
import { CUSTOM_FIELD_ENTITIES, type CustomFieldEntity } from "./customise-types.js";
import { OPS_CHARTS, OPS_DIMENSIONS, OPS_METRICS, opsMetricInfo, type OpsChart, type OpsDimension, type OpsMetric } from "./ops-analytics-types.js";

// ---------------------------------------------------------------------------
// Sizes and periods

/** Width on a large screen (6-column grid). On a phone every widget is full width. */
export const DASHBOARD_SIZES = ["full", "wide", "half", "third"] as const;
export type DashboardSize = (typeof DASHBOARD_SIZES)[number];
export const dashboardSizeLabels: Record<DashboardSize, string> = { full: "Full width", wide: "Two thirds", half: "Half", third: "One third" };

export const DASHBOARD_PERIODS = ["last_7", "last_30", "last_90", "this_month", "last_month", "this_quarter", "this_fy"] as const;
export type DashboardPeriod = (typeof DASHBOARD_PERIODS)[number];
export const dashboardPeriodLabels: Record<DashboardPeriod, string> = {
  last_7: "Last 7 days",
  last_30: "Last 30 days",
  last_90: "Last 90 days",
  this_month: "This month",
  last_month: "Last month",
  this_quarter: "This quarter",
  this_fy: "This financial year",
};

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (y: number, m: number, d: number) => {
  const t = new Date(Date.UTC(y, m, d));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
};

/** IST from/to dates (inclusive) for a widget period. */
export function dashboardPeriodRange(period: DashboardPeriod, now = new Date()): { from: string; to: string } {
  const ist = new Date(now.getTime() + 330 * 60_000);
  const y = ist.getUTCFullYear();
  const m = ist.getUTCMonth();
  const d = ist.getUTCDate();
  const to = ymd(y, m, d);
  switch (period) {
    case "last_7":
      return { from: ymd(y, m, d - 6), to };
    case "last_30":
      return { from: ymd(y, m, d - 29), to };
    case "last_90":
      return { from: ymd(y, m, d - 89), to };
    case "this_month":
      return { from: ymd(y, m, 1), to };
    case "last_month":
      return { from: ymd(y, m - 1, 1), to: ymd(y, m, 0) };
    case "this_quarter": {
      // Indian financial quarters: Apr–Jun, Jul–Sep, Oct–Dec, Jan–Mar.
      const qStart = m >= 3 ? 3 + Math.floor((m - 3) / 3) * 3 : 0;
      return { from: ymd(y, qStart, 1), to };
    }
    case "this_fy":
      return { from: ymd(m >= 3 ? y : y - 1, 3, 1), to };
  }
}

// ---------------------------------------------------------------------------
// Lists

export const DASHBOARD_LIST_SOURCES = [
  "my_tasks",
  "due_this_week",
  "overdue_tasks",
  "blocked_tasks",
  "open_requests",
  "late_requests",
  "new_leads",
  "follow_ups_due",
  "overdue_invoices",
] as const;
export type DashboardListSource = (typeof DASHBOARD_LIST_SOURCES)[number];
export const dashboardListInfo: Record<DashboardListSource, { label: string; hint: string; href: string; money?: boolean }> = {
  my_tasks: { label: "My open tasks", hint: "The viewer's own open tasks, soonest deadline first", href: "/team/tasks" },
  due_this_week: { label: "Tasks due in the next 7 days", hint: "Everyone's for leaders, the viewer's own otherwise", href: "/team/tasks" },
  overdue_tasks: { label: "Overdue tasks", hint: "Past their deadline and not done", href: "/team/tasks" },
  blocked_tasks: { label: "Blocked tasks", hint: "With the reason they are blocked", href: "/team/tasks" },
  open_requests: { label: "Open client requests", hint: "All for leaders, the viewer's clients for Client Managers", href: "/team/requests" },
  late_requests: { label: "Requests past reply time", hint: "Still waiting for a reply after the target", href: "/team/requests" },
  new_leads: { label: "New leads to contact", hint: "All for sales leaders, the viewer's own for sales executives", href: "/team/leads" },
  follow_ups_due: { label: "Lead follow-ups due", hint: "Follow-ups due today or earlier", href: "/team/leads" },
  overdue_invoices: { label: "Overdue invoices", hint: "Founder, Branch Manager and Finance only", href: "/admin/collections", money: true },
};
export type DashboardListRow = { id: string; title: string; meta?: string; href: string; badge?: { label: string; tone: "red" | "amber" | "green" | "grey" } };
export type DashboardListResult = { source: DashboardListSource; label: string; href: string; rows: DashboardListRow[]; total: number };
/** v14: counts of records per value of a custom field (open records unless scope is "all"), scoped to the viewer. */
export type DashboardFieldBreakdown = {
  entity: CustomFieldEntity;
  field: string;
  label: string;
  type: string;
  rows: { value: string; label: string; count: number; href: string | null }[];
  total: number;
  empty: number;
};

// ---------------------------------------------------------------------------
// Built-in dashboards and their sections

export const DASHBOARD_BUILTIN_KEYS = ["command_centre", "scorecard", "my_day", "manager", "specialist", "client_home"] as const;
export type DashboardBuiltinKey = (typeof DASHBOARD_BUILTIN_KEYS)[number];
export type DashboardSurface = "team" | "admin" | "client";
export type DashboardSectionDef = { key: string; label: string; size: DashboardSize; hint?: string };
export type DashboardBuiltinDef = { name: string; where: string; who: string; surface: DashboardSurface; path: string; sections: DashboardSectionDef[] };

export const DASHBOARD_BUILTINS: Record<DashboardBuiltinKey, DashboardBuiltinDef> = {
  command_centre: {
    name: "Weekly Review",
    where: "Command Centre home",
    who: "Founder, Branch Manager, Finance, CM lead and department heads",
    surface: "admin",
    path: "/admin",
    sections: [
      { key: "ai_digest", label: "AI weekly digest", size: "full" },
      { key: "forecast_risks", label: "Forecast & risks", size: "full", hint: "Revenue forecast (money roles), churn risk, deals, slipping tasks and capacity, each with its reasons" },
      { key: "money_tiles", label: "Money numbers", size: "full", hint: "Revenue, collected, outstanding (money roles only)" },
      { key: "ops_tiles", label: "Operations numbers", size: "full", hint: "Leads, overdue tasks, reply times, QC" },
      { key: "new_clients", label: "New clients and who added them", size: "full", hint: "Founder, Branch Manager, CM Lead, Finance: clients added in the last 30 days" },
      { key: "attendance_today", label: "Attendance today by department", size: "full", hint: "Founder, Branch Manager, HR; Department Heads see their own team" },
      { key: "money_chart", label: "Invoiced and collected chart", size: "half", hint: "Money roles only" },
      { key: "pipeline", label: "Pipeline by stage", size: "half" },
      { key: "overdue_invoices", label: "Overdue invoices", size: "half", hint: "Money roles only" },
      { key: "at_risk_clients", label: "Clients at risk", size: "half" },
      { key: "blocked_tasks", label: "Blocked tasks", size: "half" },
      { key: "late_requests", label: "Requests past reply time", size: "half" },
    ],
  },
  scorecard: {
    name: "Scorecard",
    where: "Command Centre → Analytics → Scorecard",
    who: "Founder, Branch Manager and Finance",
    surface: "admin",
    path: "/admin/analytics",
    sections: [
      { key: "ai_notes", label: "What stands out (AI notes)", size: "full" },
      { key: "month_target", label: "This month against target", size: "full" },
      { key: "kpis", label: "Scorecard numbers", size: "full" },
      { key: "trend", label: "Revenue against target, 12 months", size: "full" },
      { key: "month_table", label: "Month by month table", size: "full" },
    ],
  },
  my_day: {
    name: "My Day",
    where: "Team app home",
    who: "Team members who are not specialists or managers (sales, finance, HR, QC, strategists)",
    surface: "team",
    path: "/team",
    sections: [
      { key: "attendance", label: "Attendance and task counts", size: "full" },
      { key: "queues", label: "QC and ready-to-send counts", size: "full", hint: "Shows only when something is waiting" },
      { key: "deadlines", label: "Delivery deadlines to watch", size: "full", hint: "Shows only when a deadline is close" },
      { key: "tasks", label: "My tasks by urgency", size: "full" },
      { key: "eod", label: "End-of-day report", size: "full" },
      { key: "sales", label: "My sales pipeline", size: "full", hint: "People with access to leads" },
    ],
  },
  manager: {
    name: "Manager workspace",
    where: "Team app home for managers, and the Manager workspace page",
    who: "Client managers, project managers, CM leads and department heads",
    surface: "team",
    path: "/team/manager",
    sections: [
      { key: "strip", label: "My Day strip", size: "full", hint: "Attendance, overdue, due today, end-of-day report" },
      { key: "kpis", label: "Team numbers", size: "full" },
      { key: "today", label: "Today", size: "wide" },
      { key: "insights", label: "What the numbers say", size: "third" },
      { key: "board", label: "Assignment board", size: "full" },
      { key: "portfolio", label: "Client portfolio", size: "full" },
      { key: "team", label: "Team's next two weeks", size: "full" },
      { key: "deadlines", label: "Delivery deadlines", size: "full" },
    ],
  },
  specialist: {
    name: "Specialist workspace",
    where: "Team app home for specialists",
    who: "Video editors, script writers, social media managers, developers, UX/UI and graphic designers",
    surface: "team",
    path: "/team",
    sections: [
      { key: "strip", label: "My Day strip", size: "full" },
      { key: "kpis", label: "My numbers with period picker", size: "full" },
      { key: "next", label: "What to do next", size: "wide" },
      { key: "insights", label: "What the numbers say", size: "third" },
      { key: "panels", label: "My specialty's panels", size: "full", hint: "Different for each specialty" },
      { key: "workload", label: "Weekly workload", size: "full" },
    ],
  },
  client_home: {
    name: "Client home",
    where: "Client portal home",
    who: "Every client user",
    surface: "client",
    path: "/client",
    sections: [
      { key: "tiles", label: "Summary numbers", size: "full" },
      { key: "needs_you", label: "What needs you", size: "full" },
      { key: "services", label: "Your services and milestones", size: "full" },
      { key: "account_manager", label: "Your Client Manager", size: "full" },
    ],
  },
};

export const isDashboardBuiltinKey = (v: string): v is DashboardBuiltinKey => (DASHBOARD_BUILTIN_KEYS as readonly string[]).includes(v);

// ---------------------------------------------------------------------------
// Widgets

export const DASHBOARD_WIDGET_TYPES = ["section", "kpi", "chart", "report", "list", "custom_field", "note", "links"] as const;
export type DashboardWidgetType = (typeof DASHBOARD_WIDGET_TYPES)[number];
export const dashboardWidgetTypeLabels: Record<DashboardWidgetType, string> = {
  section: "Built-in section",
  kpi: "Number",
  chart: "Chart",
  report: "Saved report",
  list: "List",
  custom_field: "Custom field breakdown",
  note: "Note",
  links: "Quick links",
};

const id = z.string().trim().min(1).max(40);
const size = z.enum(DASHBOARD_SIZES).default("half");
const title = z.string().trim().max(80).optional();
const period = z.enum(DASHBOARD_PERIODS, { error: "Pick a period" }).default("last_30");
const safeHref = z
  .string()
  .trim()
  .min(1, "Add the link")
  .max(300)
  .refine((h) => h.startsWith("/") || /^https:\/\//i.test(h), { message: "Links must start with / (a page here) or https://" });

export const dashboardWidgetSchema = z.discriminatedUnion("type", [
  z.object({
    id,
    type: z.literal("section"),
    size,
    dashboard: z.enum(DASHBOARD_BUILTIN_KEYS),
    section: z.string().trim().min(1).max(40),
  }),
  z.object({ id, type: z.literal("kpi"), size, title, metric: z.enum(OPS_METRICS, { error: "Pick a number to show" }), period }),
  z
    .object({
      id,
      type: z.literal("chart"),
      size,
      title,
      metric: z.enum(OPS_METRICS, { error: "Pick what to chart" }),
      dimension: z.enum(OPS_DIMENSIONS, { error: "Pick how to group it" }),
      chart: z.enum(OPS_CHARTS).default("columns"),
      period,
    })
    .refine((w) => opsMetricInfo[w.metric].dimensions.includes(w.dimension), { message: "That grouping is not available for this chart" }),
  z.object({ id, type: z.literal("report"), size, title, reportId: z.string().trim().min(1, "Pick a saved report").max(40) }),
  z.object({ id, type: z.literal("list"), size, title, source: z.enum(DASHBOARD_LIST_SOURCES, { error: "Pick a list" }), limit: z.number().int().min(3).max(20).default(6) }),
  z.object({
    id,
    type: z.literal("custom_field"),
    size,
    title,
    entity: z.enum(CUSTOM_FIELD_ENTITIES, { error: "Pick the record type" }),
    field: z.string().trim().regex(/^[a-z][a-z0-9_]{0,39}$/, "Pick a custom field"),
    scope: z.enum(["open", "all"]).default("open"),
  }),
  z.object({ id, type: z.literal("note"), size, title, text: z.string().trim().min(1, "Write the note").max(2000) }),
  z.object({
    id,
    type: z.literal("links"),
    size,
    title,
    links: z
      .array(z.object({ label: z.string().trim().min(1, "Name each link").max(60), href: safeHref }))
      .min(1, "Add at least one link")
      .max(12),
  }),
]);
export type DashboardWidget = z.infer<typeof dashboardWidgetSchema>;
export type DashboardWidgetOf<T extends DashboardWidgetType> = Extract<DashboardWidget, { type: T }>;

/** Checks section keys exist and widget ids are unique. Returns a plain-English problem or null. */
export function dashboardLayoutProblem(layout: DashboardWidget[], surface: DashboardSurface): string | null {
  const ids = new Set<string>();
  for (const w of layout) {
    if (ids.has(w.id)) return "Two widgets have the same id. Reload the editor and try again.";
    ids.add(w.id);
    if (w.type === "section") {
      const def = DASHBOARD_BUILTINS[w.dashboard];
      if (!def.sections.some((s) => s.key === w.section)) return `"${w.section}" is not a section of ${def.name}`;
      if (surface === "client" && w.dashboard !== "client_home") return "The client home can only show its own sections, notes and links";
      if (surface !== "client" && w.dashboard === "client_home") return "Client home sections only work in the client portal";
    } else if (surface === "client" && !["note", "links"].includes(w.type)) {
      return "The client home can only show its own sections, notes and links (team numbers are never shown to clients)";
    }
  }
  return null;
}

export const dashboardLayoutSchema = z.array(dashboardWidgetSchema).max(40, "A dashboard can hold up to 40 widgets");

/** The built-in dashboard's original layout: every section, in order, at its usual size. */
/**
 * v33: sections added to a built-in after it first shipped. A built-in saved before v33 (no knownSections) hasn't
 * offered these yet, so they are added to it; anything else missing was removed on purpose and stays removed.
 */
export const DASHBOARD_LATER_SECTIONS: Partial<Record<DashboardBuiltinKey, string[]>> = { command_centre: ["attendance_today", "new_clients"] };

export function dashboardDefaultLayout(key: DashboardBuiltinKey): DashboardWidget[] {
  return DASHBOARD_BUILTINS[key].sections.map((s) => ({ id: `${key}.${s.key}`, type: "section", size: s.size, dashboard: key, section: s.key }));
}

// ---------------------------------------------------------------------------
// Audience and placement

export const DASHBOARD_PLACEMENTS = ["menu", "team_home", "admin_home"] as const;
export type DashboardPlacement = (typeof DASHBOARD_PLACEMENTS)[number];
export const dashboardPlacementLabels: Record<DashboardPlacement, string> = {
  menu: "Extra dashboard (under Dashboards in the menu)",
  team_home: "Replaces their team app home page",
  admin_home: "Replaces their Command Centre home page",
};

export const dashboardAudienceSchema = z.object({
  everyone: z.boolean().default(false),
  roles: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  specialties: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  userIds: z.array(z.string().trim().min(1).max(40)).max(100).default([]),
});
export type DashboardAudience = z.infer<typeof dashboardAudienceSchema>;

/** How strongly a dashboard's audience matches a person: 3 named, 2 specialty, 1 role, 0 everyone, -1 not at all. */
export function dashboardAudienceRank(a: DashboardAudience, me: { id: string; roles: string[]; specialty?: string | null }): number {
  if (a.userIds.includes(me.id)) return 3;
  if (me.specialty && a.specialties.includes(me.specialty)) return 2;
  if (me.roles.some((r) => a.roles.includes(r))) return 1;
  if (a.everyone) return 0;
  return -1;
}

// ---------------------------------------------------------------------------
// Inputs

export const dashboardCreateSchema = z.object({
  name: z.string().trim().min(1, "Give the dashboard a name").max(80),
  description: z.string().trim().max(300).optional(),
  placement: z.enum(DASHBOARD_PLACEMENTS).default("menu"),
  audience: dashboardAudienceSchema.default({ everyone: false, roles: [], specialties: [], userIds: [] }),
  /** blank, a template key, or "copy" with copyFromId. */
  startFrom: z.string().trim().max(40).default("blank"),
  copyFromId: z.string().trim().max(40).optional(),
});
export type DashboardCreate = z.input<typeof dashboardCreateSchema>;

export const dashboardUpdateSchema = z.object({
  name: z.string().trim().min(1, "Give the dashboard a name").max(80).optional(),
  description: z.string().trim().max(300).nullable().optional(),
  placement: z.enum(DASHBOARD_PLACEMENTS).optional(),
  audience: dashboardAudienceSchema.optional(),
  layout: dashboardLayoutSchema.optional(),
  /** Optional note saved with this version ("Added sales numbers"). */
  note: z.string().trim().max(160).optional(),
});
export type DashboardUpdate = z.input<typeof dashboardUpdateSchema>;

export const dashboardArchiveSchema = z.object({ reason: z.string().trim().min(3, "Say why you are archiving it").max(300) });

// ---------------------------------------------------------------------------
// Views

export type DashboardView = {
  id: string;
  key: string;
  builtin: DashboardBuiltinKey | null;
  name: string;
  description: string | null;
  surface: DashboardSurface;
  placement: DashboardPlacement | null;
  audience: DashboardAudience | null;
  layout: DashboardWidget[];
  /** Built-in only: the layout differs from the original. */
  customised: boolean;
  archived: boolean;
  updatedAt: string;
  updatedBy: string | null;
  /** Founder and Branch Manager can open this in the Studio. */
  canEdit: boolean;
};

export type DashboardRow = {
  id: string;
  key: string;
  builtin: DashboardBuiltinKey | null;
  name: string;
  description: string | null;
  who: string;
  where: string;
  widgets: number;
  customised: boolean;
  archived: boolean;
  archivedReason: string | null;
  updatedAt: string;
  updatedBy: string | null;
};

export type DashboardStudio = {
  builtins: DashboardRow[];
  custom: DashboardRow[];
  archived: DashboardRow[];
  people: { id: string; name: string; roles: string[]; specialty: string | null }[];
  roles: { id: string; label: string }[];
  specialties: { id: string; label: string }[];
  templates: { key: string; name: string; hint: string }[];
};

export type DashboardMenuItem = { id: string; name: string; description: string | null; placement: DashboardPlacement };

export type DashboardVersionRow = { id: string; savedAt: string; savedBy: string | null; note: string | null; widgets: number; name: string; current: boolean };

/** Who sees a custom dashboard, in words. */
export function dashboardAudienceText(a: DashboardAudience | null, names: { roles: Record<string, string>; specialties: Record<string, string>; people: Record<string, string> }): string {
  if (!a) return "";
  if (a.everyone) return "Everyone in the team";
  const parts = [
    ...a.roles.map((r) => names.roles[r] ?? r),
    ...a.specialties.map((s) => names.specialties[s] ?? s),
    ...(a.userIds.length > 3 ? [`${a.userIds.length} people`] : a.userIds.map((u) => names.people[u] ?? "Someone")),
  ];
  return parts.length ? parts.join(", ") : "Nobody yet (only Founder and Branch Manager)";
}

// ---------------------------------------------------------------------------
// Templates for new dashboards

const kpi = (n: number, metric: OpsMetric, p: DashboardPeriod = "last_30"): DashboardWidget => ({ id: `w${n}`, type: "kpi", size: "third", metric, period: p });
const chart = (n: number, metric: OpsMetric, dimension: OpsDimension, c: OpsChart, s: DashboardSize = "half", p: DashboardPeriod = "last_90"): DashboardWidget => ({ id: `w${n}`, type: "chart", size: s, metric, dimension, chart: c, period: p });
const list = (n: number, source: DashboardListSource, s: DashboardSize = "half"): DashboardWidget => ({ id: `w${n}`, type: "list", size: s, source, limit: 6 });

export const DASHBOARD_TEMPLATES: Record<string, { name: string; hint: string; layout: DashboardWidget[] }> = {
  blank: { name: "Blank", hint: "Start empty and add widgets", layout: [] },
  sales: {
    name: "Sales overview",
    hint: "Leads, proposals, wins, sources and follow-ups",
    layout: [kpi(1, "leads"), kpi(2, "proposals_won"), kpi(3, "new_clients"), chart(4, "leads", "lead_source", "bars"), chart(5, "proposals_won", "month", "columns"), list(6, "new_leads"), list(7, "follow_ups_due")],
  },
  delivery: {
    name: "Delivery overview",
    hint: "Tasks done, hours, QC, overdue and blocked work",
    layout: [kpi(1, "tasks_completed"), kpi(2, "hours_logged"), kpi(3, "qc_pass_rate"), chart(4, "tasks_completed", "department", "bars"), chart(5, "hours_logged", "week", "line"), list(6, "overdue_tasks"), list(7, "blocked_tasks")],
  },
  service: {
    name: "Client service",
    hint: "Requests, reply times and what is waiting",
    layout: [kpi(1, "requests"), kpi(2, "sla_breaches"), kpi(3, "new_clients"), chart(4, "requests", "request_type", "bars"), chart(5, "sla_breaches", "week", "line"), list(6, "open_requests"), list(7, "late_requests")],
  },
  finance: {
    name: "Finance",
    hint: "Raised, collected and overdue (money roles only)",
    layout: [
      { id: "w1", type: "kpi", size: "half", metric: "revenue_raised", period: "this_month" },
      { id: "w2", type: "kpi", size: "half", metric: "revenue_collected", period: "this_month" },
      chart(3, "revenue_collected", "month", "columns", "wide", "this_fy"),
      list(4, "overdue_invoices", "third"),
      chart(5, "revenue_raised", "service", "bars", "full", "this_fy"),
    ],
  },
};
