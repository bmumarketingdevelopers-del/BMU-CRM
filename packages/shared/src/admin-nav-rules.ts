// Who may open each Command Centre page. Shared by the menu (apps/web/src/lib/admin-nav.ts) and Ask BMU, so the
// assistant only answers about pages the person actually has. The API enforces the same rules on each endpoint.

/** Roles that can open the Command Centre at all. */
export const ADMIN_ROLES = ["founder", "admin", "department_head", "finance", "hr_ops", "am_lead"];

const FA = ["founder", "admin"];
const MONEY = [...FA, "finance"];
const NOT_HR = [...FA, "finance", "am_lead", "department_head"];
const PEOPLE = [...FA, "hr_ops", "department_head"];
const CLIENT_OPS = [...FA, "am_lead"];
const LEADERS = [...FA, "am_lead", "department_head"];

/** Pages limited to some roles, by menu label; every other page is open to every Command Centre user. */
export const ADMIN_PAGE_ROLES: Record<string, string[]> = {
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

/** Whether someone with these roles sees this Command Centre page in their menu. */
export function adminPageAllowed(roles: string[], label: string): boolean {
  if (!roles.some((r) => ADMIN_ROLES.includes(r))) return false;
  const allowed = ADMIN_PAGE_ROLES[label];
  return !allowed || roles.some((r) => allowed.includes(r));
}
