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
  Bundles: "/admin/catalogue#bundles",
  "Add-ons": "/admin/catalogue#addons",
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

// Pages limited to some roles (the API enforces the same rules); everything else is open to every Command Centre user.
const FA = ["founder", "admin"];
const MONEY = [...FA, "finance"];
const NOT_HR = [...FA, "finance", "am_lead", "department_head"];
const PEOPLE = [...FA, "hr_ops", "department_head"];
const CLIENT_OPS = [...FA, "am_lead"];
const LEADERS = [...FA, "am_lead", "department_head"];
const restricted: Record<string, string[]> = {
  Revenue: MONEY,
  Collections: MONEY,
  Scorecard: MONEY,
  "Sales Funnel": MONEY,
  "Revenue Forecast": MONEY,
  "MRR & Retention": MONEY,
  Profitability: MONEY,
  Invoices: MONEY,
  Payments: MONEY,
  "Credit Notes": MONEY,
  "Creator Payouts": MONEY,
  "GST & Invoice Settings": MONEY,
  "Accounting Sync": MONEY,
  "Payments to Match": MONEY,
  "Invoice Plans": MONEY,
  "Expenses & Bills": MONEY,
  "Cash Flow": MONEY,
  Profit: [...FA, "finance", "am_lead"],
  Capacity: NOT_HR,
  // v53: HR can read QC pass rates (read-only page).
  Quality: [...NOT_HR, "hr_ops"],
  "Client Health": NOT_HR,
  // v53: HR adds clients and sees every client.
  Clients: [...NOT_HR, "hr_ops"],
  "Delivery Speed": NOT_HR,
  "SLA & Response": NOT_HR,
  "Report Builder": NOT_HR,
  Automations: NOT_HR,
  "Automation Log": NOT_HR,
  "Team Performance": LEADERS,
  "Business Flow Map": LEADERS,
  "Hierarchy Tree": [...PEOPLE, "am_lead"],
  Users: PEOPLE,
  "Roles & Permissions": PEOPLE,
  "Departments & Teams": PEOPLE,
  Branches: PEOPLE,
  "Attendance & Leave": PEOPLE,
  "Onboarding & Offboarding": PEOPLE,
  Timesheets: PEOPLE,
  "HR Issues": ["hr_ops"],
  "CM Assignment": CLIENT_OPS,
  Engagements: CLIENT_OPS,
  Offboarding: CLIENT_OPS,
  "Requests & Add-ons": [...FA, "am_lead", "finance"],
  "Services & Tiers": FA,
  "Quotation Templates": CLIENT_OPS,
  Quotations: [...CLIENT_OPS, "finance"],
  Bundles: FA,
  "Add-ons": FA,
  "Discount Limits": FA,
  "Audit Log": FA,
  Integrations: FA,
  // v43: client data and privacy: the Founder and the Client Manager Lead here (all clients); Client Managers in the Team app (their own).
  "Data Export / Deletion (DPDP)": ["founder", "am_lead"],
  "Tenant Settings": FA,
  "Billing Run": MONEY,
  Outbox: FA,
  "AI Copilot": FA,
  Approvals: LEADERS,
  "Dashboard Studio": FA,
  "System Health": FA,
  Workflows: NOT_HR,
  "Workflow Runs": NOT_HR,
  "Custom Fields": FA,
  Forms: [...FA, "sales_manager"],
  "Pipeline Settings": FA,
  "AI Agents": FA,
  "Agent Run Log": FA,
  "API & Webhooks": FA,
  Security: FA,
  "Privacy (DPDP)": ["founder", "am_lead"],
  "Forecast & Risks": NOT_HR,
  Metrics: NOT_HR,
};

/** The Command Centre menu for this person: hides pages their role can't open. */
export function adminNavFor(roles: string[]): NavSection[] {
  const hidden = new Set(Object.entries(restricted).filter(([, allowed]) => !roles.some((r) => allowed.includes(r))).map(([label]) => built[label]));
  return adminNav.map((s) => ({ ...s, items: s.items.filter((i) => !hidden.has(i.href ?? "")) })).filter((s) => s.items.length > 0);
}
