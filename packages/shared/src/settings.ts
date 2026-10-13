// Organisation settings edited from the Command Centre. Stored in Organisation.settings[section].
import { z } from "zod";
import type { Capability } from "./permissions.js";
import { REQUEST_TYPES, SLA_FIRST_REPLY_MIN } from "./requests.js";

const hhmm = z.string().regex(/^\d{2}:\d{2}$/, "Use HH:MM");
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

export const settingsSchemas = {
  holidays: z.object({ list: z.array(z.object({ date: isoDate, name: z.string().trim().min(1).max(80) })).max(100) }),
  workingHours: z.object({ start: hhmm, end: hhmm, days: z.array(z.number().int().min(0).max(6)).min(1), timezone: z.string().min(1) }),
  discountLimits: z.record(z.string(), z.number().min(0).max(100)),
  documentTemplates: z.object({ proposalIntro: z.string().max(4000), proposalTerms: z.string().max(8000), agreementBody: z.string().max(20000) }),
  requirementChecklists: z.record(z.string(), z.array(z.object({ label: z.string().trim().min(1).max(200), type: z.string().min(1) })).max(50)),
  sla: z.object({ firstReplyMinutes: z.record(z.enum(REQUEST_TYPES), z.number().int().min(15).max(5400)), messageReply: z.enum(["same_working_day", "next_working_day"]) }),
  gateRules: z.object({ planDeadlineWorkingDays: z.number().int().min(1).max(30), blockProductionOnOverdueInvoice: z.boolean(), requireQcBeforeSend: z.literal(true), releaseFilesAfterFinalPayment: z.literal(true) }),
  gst: z.object({ gstin: z.string().trim().max(15), legalName: z.string().trim().max(200), state: z.string().trim().max(60), stateCode: z.string().trim().max(2), ratePct: z.number().min(0).max(28), sacCode: z.string().trim().max(10), invoicePrefix: z.string().trim().min(1).max(10), address: z.string().trim().max(500).optional(), upiId: z.string().trim().max(100).optional(), bankName: z.string().trim().max(100).optional(), bankAccount: z.string().trim().max(40).optional(), bankIfsc: z.string().trim().max(20).optional(), bankBranch: z.string().trim().max(100).optional() }),
  // v10 service: overdue invoice reminders (dunning) at these days past the due date.
  dunning: z.object({ enabled: z.boolean(), steps: z.array(z.number().int().min(1).max(120)).min(1).max(6), workingDays: z.boolean(), emailClient: z.boolean(), messageClient: z.boolean(), alertFinance: z.boolean() }),
  accounting: z.object({ tool: z.enum(["none", "tally", "zoho_books", "quickbooks"]), lastExportAt: z.string().nullable() }),
  notificationTemplates: z.record(
    z.string(),
    z
      .object({
        inApp: z.boolean(),
        email: z.boolean(),
        whatsapp: z.boolean(),
        text: z.string().max(500),
        /** v11 ops: Meta's approval status of the WhatsApp template (not_submitted | pending | approved | rejected). */
        whatsappStatus: z.enum(["not_submitted", "pending", "approved", "rejected"]).optional(),
      })
      .refine((t) => !t.whatsapp || t.whatsappStatus === "approved", { message: "WhatsApp can only be turned on once Meta has approved the template", path: ["whatsapp"] }),
  ),
  branding: z.object({ primary: z.string().regex(/^#[0-9a-fA-F]{6}$/), accent: z.string().regex(/^#[0-9a-fA-F]{6}$/), background: z.string().regex(/^#[0-9a-fA-F]{6}$/), logoUrl: z.string().max(500), clientAppName: z.string().max(60) }),
  costRates: z.object({ hourlyPaise: z.record(z.string(), z.number().int().min(0).max(10_000_000)), overheadPct: z.number().min(0).max(200) }),
  cashflow: z.object({ openingBalancePaise: z.number().int().min(-1_00_00_00_000).max(1_00_00_00_000), monthlyPayrollPaise: z.number().int().min(0).max(1_00_00_00_000), monthlyOverheadsPaise: z.number().int().min(0).max(1_00_00_00_000), asOf: isoDate.or(z.literal("")) }),
  forecast: z.object({ stageProbabilityPct: z.record(z.string(), z.number().min(0).max(100)), monthlyTargetPaise: z.number().int().min(0) }),
  ai: z.object({
    enabled: z.boolean(),
    monthlyBudgetPaise: z.number().int().min(0).max(1_00_00_000_00),
    monthlyTokenCap: z.number().int().min(0).max(1_000_000_000),
    perUserPerHour: z.number().int().min(1).max(500),
    features: z.object({ copilot: z.boolean(), sales: z.boolean(), delivery: z.boolean(), clientService: z.boolean(), management: z.boolean(), automations: z.boolean(), clientPortal: z.boolean(), agents: z.boolean().default(true) }),
  }),
  // v20 hardening: field-level permission overrides (field → role → edit | read | hidden) and sign-in security.
  fieldAccess: z.record(z.string(), z.record(z.string(), z.enum(["edit", "read", "hidden"]))),
  security: z.object({ require2faRoles: z.array(z.string()).max(30), sessionDays: z.number().int().min(1).max(90) }),
  tenant: z.object({ name: z.string().trim().min(1).max(120), supportEmail: z.string().max(200), supportPhone: z.string().max(30), website: z.string().max(200), address: z.string().max(500), dataRetentionDays: z.number().int().min(30).max(3650) }),
} as const;

export type SettingsSection = keyof typeof settingsSchemas;
export type SettingsValue<S extends SettingsSection> = z.infer<(typeof settingsSchemas)[S]>;
export type AllSettings = { [S in SettingsSection]: SettingsValue<S> };
export const SETTINGS_SECTIONS = Object.keys(settingsSchemas) as SettingsSection[];

/** Who may edit each section (read access: any Command Centre user). */
export const settingsCapability: Record<SettingsSection, Capability> = {
  holidays: "users_roles_hierarchy",
  workingHours: "users_roles_hierarchy",
  discountLimits: "catalogue_pricing_engine",
  documentTemplates: "catalogue_pricing_engine",
  requirementChecklists: "sop_checklists_flow_templates",
  sla: "sop_checklists_flow_templates",
  gateRules: "sop_checklists_flow_templates",
  gst: "invoices_payments",
  dunning: "invoices_payments",
  accounting: "invoices_payments",
  notificationTemplates: "users_roles_hierarchy",
  branding: "users_roles_hierarchy",
  tenant: "users_roles_hierarchy",
  costRates: "invoices_payments",
  cashflow: "invoices_payments",
  forecast: "invoices_payments",
  ai: "users_roles_hierarchy",
  fieldAccess: "users_roles_hierarchy",
  security: "users_roles_hierarchy",
};

export const NOTIFICATION_KINDS: { key: string; label: string; audience: "client" | "team" }[] = [
  { key: "draft_ready", label: "Draft ready for review", audience: "client" },
  { key: "invoice_issued", label: "Invoice issued", audience: "client" },
  { key: "request_quote", label: "Quote ready", audience: "client" },
  { key: "message", label: "New message", audience: "client" },
  { key: "request_created", label: "New client request", audience: "team" },
  { key: "qc_waiting", label: "Version waiting for QC", audience: "team" },
  { key: "qc_failed", label: "QC failed", audience: "team" },
  { key: "changes_requested", label: "Client asked for changes", audience: "team" },
  { key: "addon_paid", label: "Extra request paid", audience: "team" },
  { key: "leave_request", label: "Leave request", audience: "team" },
  // v10 service
  { key: "request_update", label: "Update on a request", audience: "client" },
  { key: "invoice_reminder", label: "Payment reminder", audience: "client" },
  { key: "final_delivery", label: "Final files released", audience: "client" },
  { key: "request_rated", label: "Client rated a request", audience: "team" },
  { key: "quote_decision", label: "Client approved or declined a quote", audience: "team" },
  { key: "payment_received", label: "Payment received / overdue alert", audience: "team" },
  { key: "task_assigned", label: "Task given to you", audience: "team" },
  { key: "automation", label: "Automation alert", audience: "team" },
  // v17 communications
  { key: "inbox_message", label: "WhatsApp or email in the inbox", audience: "team" },
  { key: "meeting", label: "Meeting booked, cancelled or starting", audience: "team" },
  { key: "doc_shared", label: "Document shared with you", audience: "client" },
  // v19 integrations
  { key: "integration", label: "Publishing or connected-account problem", audience: "team" },
];

export const settingsDefaults: AllSettings = {
  holidays: {
    list: [
      { date: "2026-10-02", name: "Gandhi Jayanti" },
      { date: "2026-10-20", name: "Dussehra" },
      { date: "2026-11-08", name: "Diwali" },
      { date: "2026-12-25", name: "Christmas" },
      { date: "2027-01-26", name: "Republic Day" },
    ],
  },
  workingHours: { start: "09:30", end: "18:30", days: [1, 2, 3, 4, 5, 6], timezone: "Asia/Kolkata" },
  discountLimits: { sales_manager: 10, admin: 20 },
  documentTemplates: {
    proposalIntro: "Thank you for considering BMU Marketing. Here is the plan and investment we recommend for your growth.",
    proposalTerms: "Prices exclude GST (18%). Monthly services are billed in advance. Projects are billed 50% to start and 50% before handover. Extra requests are quoted and need written approval before work starts.",
    agreementBody: "This agreement is between BMU Marketing (Build My Universee) and the client named above for the services listed in the accepted proposal. Each service follows five milestones: requirements, plan approval, production, client review and final delivery. Final files are released after written sign-off and payment of the final invoice.",
  },
  requirementChecklists: {
    default: [
      { label: "Brand logo files", type: "file" },
      { label: "Brand guidelines or references", type: "file" },
      { label: "Social media and website access", type: "access" },
      { label: "Kick-off call", type: "call" },
    ],
  },
  sla: { firstReplyMinutes: { ...SLA_FIRST_REPLY_MIN }, messageReply: "same_working_day" },
  gateRules: { planDeadlineWorkingDays: 4, blockProductionOnOverdueInvoice: true, requireQcBeforeSend: true, releaseFilesAfterFinalPayment: true },
  gst: { gstin: "", legalName: "BMU Marketing", state: "Karnataka", stateCode: "29", ratePct: 18, sacCode: "998361", invoicePrefix: "BMU", address: "", upiId: "", bankName: "", bankAccount: "", bankIfsc: "", bankBranch: "" },
  dunning: { enabled: true, steps: [1, 7, 14], workingDays: true, emailClient: true, messageClient: true, alertFinance: true },
  accounting: { tool: "none", lastExportAt: null },
  notificationTemplates: Object.fromEntries(NOTIFICATION_KINDS.map((k) => [k.key, { inApp: true, email: k.audience === "client", whatsapp: false, text: "" }])),
  branding: { primary: "#121F2F", accent: "#8BB72C", background: "#FFFFFF", logoUrl: "", clientAppName: "BMU Hub" },
  // Internal cost of one working hour by base role (for profitability). "default" covers roles not listed.
  costRates: {
    hourlyPaise: { default: 60_000, founder: 250_000, admin: 120_000, account_manager: 70_000, am_lead: 90_000, strategist: 80_000, producer: 60_000, qc: 50_000, sales_manager: 90_000, sales_executive: 50_000 },
    overheadPct: 20,
  },
  // v18 cash-flow forecast: bank balance today and the fixed monthly costs not entered as bills.
  cashflow: { openingBalancePaise: 0, monthlyPayrollPaise: 0, monthlyOverheadsPaise: 0, asOf: "" },
  // Chance an open lead becomes paid revenue, by stage (for the weighted pipeline forecast).
  forecast: { stageProbabilityPct: { new: 5, contacted: 10, discovery: 25, proposal_sent: 50 }, monthlyTargetPaise: 2_00_000_00 },
  // AI Copilot: on by default; works in basic mode until an Anthropic API key is added to apps/api/.env. 0 = no cap.
  ai: {
    enabled: true,
    monthlyBudgetPaise: 5_000_00,
    monthlyTokenCap: 0,
    perUserPerHour: 40,
    features: { copilot: true, sales: true, delivery: true, clientService: true, management: true, automations: true, clientPortal: true, agents: true },
  },
  fieldAccess: {},
  // Two-factor is required for these roles once someone turns it on (Founder, Branch Manager and Finance recommended).
  security: { require2faRoles: [], sessionDays: 30 },
  tenant: { name: "BMU Marketing", supportEmail: "hello@bmumarketing.in", supportPhone: "", website: "https://bmumarketing.in", address: "Bengaluru, Karnataka", dataRetentionDays: 730 },
};
