// v10 service flows: notification preferences, email outbox, GST tax invoice, client billing details,
// dunning (overdue reminders), promises to pay, monthly billing run and request satisfaction.
import { z } from "zod";
import { NOTIFICATION_KINDS } from "./settings.js";

// ---------------------------------------------------------------------------
// Notification groups: every notification kind maps to one template / preference key.

const SERVICE_KIND_TO_GROUP: Record<string, string> = {
  draft_ready: "draft_ready",
  invoice_issued: "invoice_issued",
  request_quote: "request_quote",
  message: "message",
  request_created: "request_created",
  request_client_reply: "request_created",
  request_reopened: "request_created",
  qc_waiting: "qc_waiting",
  qc_passed: "qc_waiting",
  qc_failed: "qc_failed",
  changes_requested: "changes_requested",
  draft_approved: "changes_requested",
  addon_paid: "addon_paid",
  leave_request: "leave_request",
  request_reply: "request_update",
  request_in_scope: "request_update",
  request_accept_urgent: "request_update",
  request_reschedule: "request_update",
  request_done: "request_update",
  request_decline: "request_update",
  invoice_reminder: "invoice_reminder",
  final_delivery: "final_delivery",
  request_rated: "request_rated",
  quote_approved: "quote_decision",
  quote_declined: "quote_decision",
  payment_received: "payment_received",
  dunning_alert: "payment_received",
  task_assigned: "task_assigned",
  automation: "automation",
};

/** The template / preference key a notification kind belongs to (unknown kinds are their own group). */
export function serviceNoticeGroup(kind: string): string {
  return SERVICE_KIND_TO_GROUP[kind] ?? kind;
}

/** Kinds that always show in the app (people cannot switch them off). */
export const SERVICE_ALWAYS_IN_APP = ["request_quote", "invoice_reminder"];

export type ServiceNotificationPref = {
  kind: string;
  label: string;
  inApp: boolean;
  email: boolean;
  /** v17: a WhatsApp copy (needs a phone number on the profile). */
  whatsapp: boolean;
  /** Turned off for everyone in Command Centre → Notification Templates. */
  orgInApp: boolean;
  orgEmail: boolean;
  /** Cannot be switched off in the app (important money and approval alerts). */
  locked: boolean;
};
export type ServiceNotificationPrefsView = {
  email: string | null;
  audience: "client" | "team";
  prefs: ServiceNotificationPref[];
  /** v17: quiet hours (IST, "HH:MM") and the daily digest. */
  phone: string | null;
  quietStart: string | null;
  quietEnd: string | null;
  digest: "off" | "daily";
  digestHour: number;
  /** Alerts held back for quiet hours or the digest, not sent yet. */
  waiting: number;
};
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a time like 21:00");
export const serviceNotificationPrefsSchema = z.object({
  prefs: z.array(z.object({ kind: z.string().min(1).max(60), inApp: z.boolean(), email: z.boolean(), whatsapp: z.boolean().optional() })).max(50),
  quietStart: hhmm.nullable().optional(),
  quietEnd: hhmm.nullable().optional(),
  digest: z.enum(["off", "daily"]).optional(),
  digestHour: z.number().int().min(6).max(22).optional(),
});
export type ServiceNotificationPrefsInput = z.infer<typeof serviceNotificationPrefsSchema>;

/** Notification kinds a client or team member can tune. */
export function serviceNoticeKindsFor(audience: "client" | "team") {
  return NOTIFICATION_KINDS.filter((k) => k.audience === audience);
}

// ---------------------------------------------------------------------------
// Email outbox

export const SERVICE_EMAIL_STATUSES = ["simulated", "sent", "failed", "skipped"] as const;
export type ServiceEmailStatus = (typeof SERVICE_EMAIL_STATUSES)[number];
export const serviceEmailStatusLabels: Record<string, string> = {
  simulated: "Not sent (no email server)",
  sent: "Sent",
  failed: "Failed",
  skipped: "Skipped",
  sending: "Sending",
};
export const serviceEmailKindLabels: Record<string, string> = {
  otp: "Sign-in code",
  invoice_issued: "Invoice issued",
  invoice_reminder: "Payment reminder",
  request_quote: "Quote ready",
  draft_ready: "Draft ready",
  automation: "Automation",
  message: "New message",
};

export type ServiceOutboxRow = {
  id: string;
  to: string;
  toName: string | null;
  subject: string;
  kind: string;
  status: string;
  error: string | null;
  entity: string | null;
  entityId: string | null;
  createdAt: string;
  sentAt: string | null;
};
export type ServiceOutboxDetail = ServiceOutboxRow & { text: string; html: string };
export type ServiceOutboxView = {
  rows: ServiceOutboxRow[];
  smtp: { configured: boolean; host: string | null; from: string };
  counts: { total: number; last7Days: number; failed: number; byKind: { kind: string; count: number }[] };
  canResend: boolean;
};

// ---------------------------------------------------------------------------
// GST states and the tax invoice

export const SERVICE_GST_STATES: { code: string; name: string }[] = [
  ["01", "Jammu and Kashmir"], ["02", "Himachal Pradesh"], ["03", "Punjab"], ["04", "Chandigarh"], ["05", "Uttarakhand"], ["06", "Haryana"],
  ["07", "Delhi"], ["08", "Rajasthan"], ["09", "Uttar Pradesh"], ["10", "Bihar"], ["11", "Sikkim"], ["12", "Arunachal Pradesh"], ["13", "Nagaland"],
  ["14", "Manipur"], ["15", "Mizoram"], ["16", "Tripura"], ["17", "Meghalaya"], ["18", "Assam"], ["19", "West Bengal"], ["20", "Jharkhand"],
  ["21", "Odisha"], ["22", "Chhattisgarh"], ["23", "Madhya Pradesh"], ["24", "Gujarat"], ["26", "Dadra and Nagar Haveli and Daman and Diu"],
  ["27", "Maharashtra"], ["29", "Karnataka"], ["30", "Goa"], ["31", "Lakshadweep"], ["32", "Kerala"], ["33", "Tamil Nadu"], ["34", "Puducherry"],
  ["35", "Andaman and Nicobar Islands"], ["36", "Telangana"], ["37", "Andhra Pradesh"], ["38", "Ladakh"],
].map(([code, name]) => ({ code, name }));
export const serviceGstStateName = (code: string | null | undefined) => SERVICE_GST_STATES.find((s) => s.code === code)?.name ?? null;

/** GSTIN: 2-digit state code, 10-character PAN, entity number, Z, check character. */
export const SERVICE_GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
function twoDigits(n: number) {
  return n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ""}`;
}
function threeDigits(n: number) {
  const h = Math.floor(n / 100);
  const r = n % 100;
  return [h ? `${ONES[h]} Hundred` : "", r ? twoDigits(r) : ""].filter(Boolean).join(" ");
}
/** Whole number in Indian words (crore, lakh, thousand). */
export function serviceNumberInWords(n: number): string {
  n = Math.floor(Math.abs(n));
  if (n === 0) return "Zero";
  const parts: string[] = [];
  const crore = Math.floor(n / 1_00_00_000);
  n %= 1_00_00_000;
  const lakh = Math.floor(n / 1_00_000);
  n %= 1_00_000;
  const thousand = Math.floor(n / 1000);
  n %= 1000;
  if (crore) parts.push(`${crore >= 100 ? serviceNumberInWords(crore) : twoDigits(crore)} Crore`);
  if (lakh) parts.push(`${twoDigits(lakh)} Lakh`);
  if (thousand) parts.push(`${twoDigits(thousand)} Thousand`);
  if (n) parts.push(threeDigits(n));
  return parts.join(" ");
}
/** e.g. 11800050 paise → "Rupees One Lakh Eighteen Thousand and Fifty Paise Only". */
export function serviceAmountInWords(paise: number): string {
  const rupees = Math.floor(Math.abs(paise) / 100);
  const p = Math.abs(paise) % 100;
  return `Rupees ${serviceNumberInWords(rupees)}${p ? ` and ${twoDigits(p)} Paise` : ""} Only`;
}

export type ServiceTaxInvoice = {
  id: string;
  number: string;
  date: string;
  dueDate: string;
  status: string;
  kind: string;
  title: "Tax Invoice";
  seller: { legalName: string; gstin: string; address: string; state: string; stateCode: string; email: string; phone: string; website: string };
  buyer: { name: string; legalName: string; gstin: string | null; address: string | null; placeOfSupply: string; placeOfSupplyName: string; email: string | null };
  sacCode: string;
  lines: { label: string; sac: string; taxablePaise: number }[];
  taxablePaise: number;
  ratePct: number;
  interState: boolean;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  gstPaise: number;
  totalPaise: number;
  paidPaise: number;
  creditedPaise: number;
  balancePaise: number;
  amountInWords: string;
  payment: { upiId: string | null; upiUri: string | null; payeeName: string; bank: { name: string; account: string; ifsc: string; branch: string } | null; payLink: string };
  payments: { at: string; amountPaise: number; method: string; ref: string | null }[];
  creditNotes: { number: string; at: string; totalPaise: number; reason: string }[];
  reverseCharge: false;
};

export type ServiceBillingDetails = {
  name: string;
  legalName: string | null;
  gstin: string | null;
  billingAddress: string | null;
  placeOfSupply: string | null;
  billingEmail: string | null;
  canEdit: boolean;
};
export const serviceBillingDetailsSchema = z.object({
  legalName: z.string().trim().max(200).nullable().optional(),
  gstin: z
    .string()
    .trim()
    .toUpperCase()
    .max(15)
    .nullable()
    .optional()
    .refine((v) => !v || SERVICE_GSTIN_RE.test(v), "That GSTIN does not look right (15 characters, e.g. 29ABCDE1234F1Z5)"),
  billingAddress: z.string().trim().max(500).nullable().optional(),
  placeOfSupply: z
    .string()
    .trim()
    .nullable()
    .optional()
    .refine((v) => !v || SERVICE_GST_STATES.some((s) => s.code === v), "Pick a state"),
  billingEmail: z.string().trim().max(200).email("Enter a valid email").nullable().optional().or(z.literal("")),
});
export type ServiceBillingDetailsInput = z.infer<typeof serviceBillingDetailsSchema>;

// ---------------------------------------------------------------------------
// Client billing page

export type ServiceClientInvoiceRow = {
  id: string;
  number: string;
  kind: string;
  status: string;
  createdAt: string;
  dueDate: string;
  subtotalPaise: number;
  gstPaise: number;
  totalPaise: number;
  paidPaise: number;
  creditedPaise: number;
  balancePaise: number;
  daysOverdue: number;
  label: string;
};
export type ServiceClientBilling = {
  invoices: ServiceClientInvoiceRow[];
  duePaise: number;
  overduePaise: number;
  paidThisYearPaise: number;
  details: ServiceBillingDetails;
  online: "razorpay" | "test" | "unavailable";
};

// ---------------------------------------------------------------------------
// Dunning and promises to pay

export type ServiceDunningStep = { step: number; days: number; tone: "friendly" | "firm" | "final" };
export type ServiceCollectionsInvoiceActions = {
  invoiceId: string;
  reminders: { step: number; days: number; at: string; manual: boolean; channels: string[] }[];
  promise: { promisedFor: string; note: string | null; by: string; at: string; broken: boolean } | null;
  nextReminder: { step: number; days: number; on: string } | null;
  daysOverdueWorking: number;
};
export type ServiceCollectionsActions = {
  rows: ServiceCollectionsInvoiceActions[];
  settings: { enabled: boolean; steps: number[]; workingDays: boolean; emailClient: boolean; messageClient: boolean; alertFinance: boolean };
  sentLast30Days: number;
  promisesOpen: number;
  promisesBroken: number;
  canEdit: boolean;
};
export const servicePromiseSchema = z.object({
  promisedFor: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a date"),
  note: z.string().trim().max(500).optional(),
});
export type ServicePromiseInput = z.infer<typeof servicePromiseSchema>;
export type ServiceDunningRunResult = { checked: number; sent: number; paused: number; details: string[] };

// ---------------------------------------------------------------------------
// Monthly billing run (retainers)

export type ServiceBillingRunLine = {
  engagementId: string;
  clientId: string;
  client: string;
  service: string;
  tier: string;
  amountPaise: number;
  gstPaise: number;
  totalPaise: number;
  status: "ready" | "already_issued" | "started_this_month" | "no_price";
  note: string;
  existingInvoice: { id: string; number: string } | null;
};
export type ServiceBillingRunPreview = {
  period: string;
  periodLabel: string;
  lines: ServiceBillingRunLine[];
  readyCount: number;
  readyTotalPaise: number;
  canIssue: boolean;
};
export type ServiceBillingRunLog = {
  id: string;
  period: string;
  by: string;
  issuedCount: number;
  skippedCount: number;
  totalPaise: number;
  createdAt: string;
  invoices: { id: string; number: string; client: string }[];
};
export const serviceBillingRunSchema = z.object({
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Pick a month"),
  engagementIds: z.array(z.string()).min(1, "Pick at least one retainer").max(500),
  dueInDays: z.number().int().min(0).max(60).default(7),
});
export type ServiceBillingRunInput = z.infer<typeof serviceBillingRunSchema>;
export type ServiceBillingRunResult = { runId: string; issued: { id: string; number: string; client: string }[]; skipped: { engagementId: string; reason: string }[] };

// ---------------------------------------------------------------------------
// Request satisfaction

export const serviceRateRequestSchema = z.object({ rating: z.enum(["up", "down"]), comment: z.string().trim().max(1000).optional() });
export type ServiceRateRequest = z.infer<typeof serviceRateRequestSchema>;
export const serviceReopenRequestSchema = z.object({ reason: z.string().trim().min(3, "Tell us what still needs fixing").max(2000) });
export const SERVICE_REOPEN_DAYS = 7;

export type ServiceSatisfaction = {
  up: number;
  down: number;
  rated: number;
  done: number;
  /** Thumbs up as % of rated requests, null when nothing was rated. */
  happyPct: number | null;
  reopened: number;
  byClient: { clientId: string; client: string; up: number; down: number }[];
  recent: { requestId: string; client: string; value: "up" | "down"; comment: string | null; at: string }[];
};

export type ServiceUnread = { messages: number };
