import { adminPageAllowed } from "@bmu/shared";
import type { NavSection } from "@/components/side-nav";

// admin_panel.navigation from the spec. Every item is built.
const built: Record<string, string> = {
  "Weekly Review": "/admin",
  Pipeline: "/admin/pipeline",
  "Hierarchy Tree": "/admin/hierarchy",
  Users: "/admin/users",
  "Roles & Permissions": "/admin/roles",
  "Services & Tiers": "/admin/catalogue",
  "Audit Log": "/admin/audit",
  Clients: "/admin/clients",
  "Department Flow Templates": "/admin/templates",
  // v57: its own page (was a section of Department Flow Templates).
  "QC Checklists": "/admin/qc-checklists",
  Revenue: "/admin/revenue",
  Collections: "/admin/collections",
  Capacity: "/admin/capacity",
  Quality: "/admin/quality",
  "Client Health": "/admin/client-health",
  "Departments & Teams": "/admin/departments",
  Branches: "/admin/branches",
  "Attendance & Leave": "/admin/attendance",
  "Holidays & Working Hours": "/admin/holidays",
  Engagements: "/admin/engagements",
  "CM Assignment": "/admin/am-assignment",
  "Requests & Add-ons": "/admin/requests",
  Offboarding: "/admin/offboarding",
  // v57: Bundles and Add-ons have their own pages (were sections of Services & Tiers).
  Bundles: "/admin/bundles",
  "Add-ons": "/admin/add-ons",
  "Discount Limits": "/admin/discount-limits",
  "Proposal & Agreement Templates": "/admin/document-templates",
  "Quotation Templates": "/admin/quote-templates",
  Quotations: "/team/quotes",
  "SOP Library": "/admin/sops",
  "Requirement Checklists": "/admin/requirement-checklists",
  "Gate Rules": "/admin/gate-rules",
  "SLA Rules": "/admin/sla-rules",
  "Error Log": "/admin/error-log",
  Invoices: "/admin/finance/invoices",
  Payments: "/admin/finance/payments",
  "Credit Notes": "/admin/finance/credit-notes",
  "Creator Payouts": "/admin/finance/payouts",
  "GST & Invoice Settings": "/admin/finance/gst",
  "Accounting Sync": "/admin/finance/accounting",
  "Notification Templates": "/admin/notification-templates",
  Integrations: "/admin/integrations",
  "Branding & Theme": "/admin/branding",
  "Data Export / Deletion (DPDP)": "/admin/data",
  "Tenant Settings": "/admin/tenant",
  // v9
  Scorecard: "/admin/analytics",
  "Sales Funnel": "/admin/analytics/funnel",
  "Revenue Forecast": "/admin/analytics/forecast",
  "MRR & Retention": "/admin/analytics/retention",
  Profitability: "/admin/analytics/profitability",
  "Team Performance": "/admin/analytics/team",
  "Delivery Speed": "/admin/analytics/delivery",
  "SLA & Response": "/admin/analytics/sla",
  "Report Builder": "/admin/analytics/explore",
  "Business Flow Map": "/admin/flow",
  Automations: "/admin/automations",
  "Automation Log": "/admin/automations/runs",
  // v10 service
  "Billing Run": "/admin/finance/billing-run",
  Outbox: "/admin/outbox",
  // v10 ai
  "AI Copilot": "/admin/ai",
  // v10
  "Onboarding & Offboarding": "/admin/people",
  Timesheets: "/admin/timesheets",
  // v11 core
  Approvals: "/admin/approvals",
  // v12
  "Dashboard Studio": "/admin/dashboards",
  // v13
  "System Health": "/admin/system",
  // v14
  Workflows: "/admin/workflows",
  "Workflow Runs": "/admin/workflows/runs",
  "Custom Fields": "/admin/custom-fields",
  Forms: "/admin/forms",
  "Pipeline Settings": "/admin/pipelines",
  // v15
  "AI Agents": "/admin/agents",
  "Agent Run Log": "/admin/agents/runs",
  // v18
  "Payments to Match": "/admin/finance/reconcile",
  "Invoice Plans": "/admin/finance/schedules",
  "Expenses & Bills": "/admin/finance/expenses",
  Profit: "/admin/finance/profit",
  "Cash Flow": "/admin/finance/cashflow",
  // v19
  "API & Webhooks": "/admin/developer",
  // v20
  "Forecast & Risks": "/admin/intelligence",
  Metrics: "/admin/intelligence/metrics",
  Alerts: "/admin/intelligence/alerts",
  "Scheduled Reports": "/admin/intelligence/reports",
  Goals: "/admin/intelligence/goals",
  Security: "/admin/security",
  "Privacy (DPDP)": "/admin/privacy",
  // v50: in the Team app (concerns raised with HR).
  "HR Issues": "/team/hr-issues",
};

// v57: Daily Reports, Agent Inbox, Specialist Dashboards, Workload, Renewals and Discount Approvals were Command Centre
// links to Team app pages (opening them switched apps). They live in the Team app menu only now.
const spec: [string, string[]][] = [
  ["Command", ["Weekly Review", "Pipeline", "Approvals", "Revenue", "Collections", "Capacity", "Quality", "Client Health"]],
  ["Dashboards", ["Dashboard Studio"]],
  ["Intelligence", ["Forecast & Risks", "Metrics", "Alerts", "Scheduled Reports", "Goals"]],
  ["Analytics", ["Scorecard", "Sales Funnel", "Revenue Forecast", "MRR & Retention", "Profitability", "Team Performance", "Delivery Speed", "SLA & Response", "Report Builder"]],
  ["Flow", ["Business Flow Map", "Workflows", "Workflow Runs", "Automations", "Automation Log"]],
  ["Agents", ["AI Agents", "Agent Run Log"]],
  ["Customise", ["Custom Fields", "Forms", "Pipeline Settings"]],
  ["Organisation", ["Hierarchy Tree", "Users", "Roles & Permissions", "Departments & Teams", "Branches", "Attendance & Leave", "Holidays & Working Hours", "Onboarding & Offboarding", "Timesheets", "HR Issues"]],
  ["Clients", ["Clients", "Engagements", "CM Assignment", "Requests & Add-ons", "Offboarding"]],
  ["Catalogue", ["Services & Tiers", "Bundles", "Add-ons", "Discount Limits", "Proposal & Agreement Templates", "Quotations", "Quotation Templates"]],
  ["Operations", ["SOP Library", "Requirement Checklists", "Department Flow Templates", "QC Checklists", "Gate Rules", "SLA Rules", "Error Log"]],
  ["Finance", ["Invoices", "Invoice Plans", "Billing Run", "Payments", "Payments to Match", "Expenses & Bills", "Credit Notes", "Creator Payouts", "Profit", "Cash Flow", "GST & Invoice Settings", "Accounting Sync"]],
  ["Platform", ["System Health", "AI Copilot", "Notification Templates", "Outbox", "Integrations", "API & Webhooks", "Branding & Theme", "Security", "Audit Log", "Privacy (DPDP)", "Data Export / Deletion (DPDP)", "Tenant Settings"]],
];

export const adminNav: NavSection[] = [
  { section: "Switch", items: [{ label: "Team app", href: "/team" }] },
  ...spec.map(([section, items]) => ({
  section,
  items: items.map((label) => ({ label, href: built[label] })),
  })),
];

// Pages limited to some roles live in @bmu/shared (ADMIN_PAGE_ROLES), shared with Ask BMU; the API enforces the same rules.
/** The Command Centre menu for this person: hides pages their role can't open. */
export function adminNavFor(roles: string[]): NavSection[] {
  const labelOf = new Map(Object.entries(built).map(([label, href]) => [href, label]));
  // The Switch link back to the Team app has no label in `built`; every other item follows the shared rules.
  const allowed = (href: string) => !labelOf.has(href) || adminPageAllowed(roles, labelOf.get(href)!);
  return adminNav.map((s) => ({ ...s, items: s.items.filter((i) => allowed(i.href ?? "")) })).filter((s) => s.items.length > 0);
}
