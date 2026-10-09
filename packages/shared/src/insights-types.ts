// Command Centre analytics (Weekly Review, Revenue, Collections, Capacity, Quality, Client Health) and Finance.
import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared bits

export type MonthPoint = { month: string; label: string; invoicedPaise: number; collectedPaise: number };
export type HealthRisk = "healthy" | "watch" | "at_risk";

// ---------------------------------------------------------------------------
// Weekly Review

export type WeeklyReviewView = {
  money: {
    revenueThisMonthPaise: number;
    revenueLastMonthPaise: number;
    collectedThisMonthPaise: number;
    outstandingPaise: number;
    byMonth: MonthPoint[];
  } | null;
  activeClients: number;
  openLeads: number;
  overdueTasks: number;
  slaBreachesThisWeek: number;
  qcPassRate: number | null;
  qcChecksThisWeek: number;
  pipeline: { stage: string; label: string; count: number }[];
  attention: {
    overdueInvoices: { id: string; number: string; client: string; balancePaise: number; daysOverdue: number }[] | null;
    atRiskClients: { id: string; name: string; score: number; reasons: string[] }[];
    blockedTasks: { id: string; title: string; owner: string | null; reason: string | null; deliverableId: string | null }[];
    slaRequests: { id: string; client: string; type: string; description: string; slaDue: string }[];
  };
};

// ---------------------------------------------------------------------------
// Revenue

export const REVENUE_PERIODS = ["month", "quarter", "fy"] as const;
export type RevenuePeriod = (typeof REVENUE_PERIODS)[number];

export type RevenueView = {
  period: RevenuePeriod;
  periodLabel: string;
  invoicedPaise: number; // incl. GST, after credit notes
  revenuePaise: number; // before GST, after credit notes
  collectedPaise: number;
  gstPaise: number;
  creditNotesPaise: number;
  mrrPaise: number;
  activeRetainers: number;
  retainers: { engagementId: string; client: string; service: string; tier: string; pricePaise: number }[];
  byMonth: MonthPoint[];
  byService: { label: string; valuePaise: number }[];
  byClient: { id: string; label: string; valuePaise: number }[];
  split: { label: string; valuePaise: number }[];
};

// ---------------------------------------------------------------------------
// Collections

export type UnpaidInvoiceRow = {
  id: string;
  number: string;
  clientId: string | null;
  client: string;
  kind: string;
  dueDate: string;
  daysOverdue: number;
  totalPaise: number;
  paidPaise: number;
  balancePaise: number;
};

export type CollectionsView = {
  outstandingPaise: number;
  overduePaise: number;
  aging: { label: string; valuePaise: number; count: number }[];
  unpaid: UnpaidInvoiceRow[];
  collectedThisMonthPaise: number;
  avgDaysToPay: number | null;
  canAct: boolean;
};

// ---------------------------------------------------------------------------
// Capacity

export type CapacityPerson = {
  id: string;
  name: string;
  department: string | null;
  openTasks: number;
  dueThisWeek: number;
  overdue: number;
  hoursThisWeek: number;
  utilisation: number; // % of a 45h week
  checkedIn: boolean;
  flag: "overloaded" | "idle" | null;
};

export type CapacityView = {
  weekHours: number;
  overloadAt: number;
  departments: { id: string | null; name: string; people: number; openTasks: number; dueThisWeek: number; overdue: number; hoursThisWeek: number; utilisation: number; checkedIn: number }[];
  people: CapacityPerson[];
};

// ---------------------------------------------------------------------------
// Quality

export type QualityView = {
  checks: number;
  passRate: number | null;
  firstTimeRight: number | null;
  avgRevisionRounds: number | null;
  clientChangeRequests: number;
  byDepartment: { label: string; checks: number; passRate: number }[];
  byFlow: { label: string; checks: number; passRate: number }[];
  topFailures: { label: string; count: number }[];
  trend: { week: string; label: string; checks: number; passRate: number | null }[];
};

// ---------------------------------------------------------------------------
// Client health

export type ClientHealthRow = {
  id: string;
  name: string;
  am: string | null;
  score: number;
  risk: HealthRisk;
  reasons: string[];
  activeEngagements: number;
  overdueInvoices: number;
  lastClientActivityAt: string | null;
};

// ---------------------------------------------------------------------------
// Finance

export const PAYMENT_METHODS = ["bank", "upi", "cash", "cheque"] as const;
export type OfflineMethod = (typeof PAYMENT_METHODS)[number];
export const paymentMethodLabels: Record<string, string> = { bank: "Bank transfer", upi: "UPI", cash: "Cash", cheque: "Cheque", razorpay: "Razorpay", test: "Test payment", tds: "TDS deducted by client" };
export const invoiceKindLabels: Record<string, string> = { first_payment: "First payment", retainer: "Retainer", project_balance: "Project balance", addon: "Add-on", standard: "Standard" };

/** What finance sees: "overdue" is worked out from the due date, "void" means cancelled. */
export type InvoiceDisplayStatus = "draft" | "issued" | "partially_paid" | "paid" | "overdue" | "void" | "credit_noted";
export const invoiceStatusLabels: Record<InvoiceDisplayStatus, string> = {
  draft: "Draft",
  issued: "Unpaid",
  partially_paid: "Part paid",
  paid: "Paid",
  overdue: "Overdue",
  void: "Cancelled",
  credit_noted: "Credited",
};

export type FinanceInvoiceRow = {
  id: string;
  number: string;
  clientId: string | null;
  client: string;
  kind: string;
  status: InvoiceDisplayStatus;
  createdAt: string;
  dueDate: string;
  subtotalPaise: number;
  gstPaise: number;
  totalPaise: number;
  paidPaise: number;
  creditedPaise: number;
  balancePaise: number;
};

export type FinanceInvoiceList = {
  rows: FinanceInvoiceRow[];
  totals: { count: number; totalPaise: number; paidPaise: number; balancePaise: number };
  clients: { id: string; name: string }[];
  canEdit: boolean;
};

export type PaymentRow = { id: string; invoiceId: string; invoiceNumber: string; client: string; amountPaise: number; method: string; ref: string | null; at: string };
export type CreditNoteRow = { id: string; number: string; invoiceId: string; invoiceNumber: string; client: string; amountPaise: number; gstPaise: number; totalPaise: number; reason: string; createdBy: string | null; createdAt: string };

export type FinanceInvoiceDetail = FinanceInvoiceRow & {
  lines: { label: string; amountPaise: number }[];
  service: string | null;
  payments: PaymentRow[];
  creditNotes: CreditNoteRow[];
  cancelReason: string | null;
  creditableTotalPaise: number;
  gstRatePct: number;
  canEdit: boolean;
};

export type PaymentsView = {
  rows: PaymentRow[];
  thisMonthPaise: number;
  totalPaise: number;
  byMethod: { method: string; label: string; valuePaise: number; count: number }[];
  razorpayPaise: number;
  offlinePaise: number;
};

export type CreditNotesView = {
  rows: CreditNoteRow[];
  totalPaise: number;
  gstRatePct: number;
  invoices: { id: string; number: string; client: string; creditableTotalPaise: number }[];
  canEdit: boolean;
};

export type PayoutRow = {
  id: string;
  creatorId: string;
  creator: string;
  brief: string | null;
  amountPaise: number;
  tdsPaise: number;
  netPaise: number;
  status: "pending" | "paid" | "on_hold";
  paidAt: string | null;
  ref: string | null;
  createdAt: string;
};

export type PayoutsView = {
  rows: PayoutRow[];
  pendingNetPaise: number;
  paidNetPaise: number;
  tdsPaise: number;
  creators: { id: string; name: string }[];
  canEdit: boolean;
};

export type GstSummaryView = {
  month: string;
  monthLabel: string;
  ratePct: number;
  invoiceCount: number;
  taxablePaise: number;
  gstPaise: number;
  totalPaise: number;
  creditNotes: { count: number; taxablePaise: number; gstPaise: number };
  rows: { id: string; number: string; date: string; client: string; gstin: string | null; taxablePaise: number; gstPaise: number; totalPaise: number; status: InvoiceDisplayStatus }[];
};

// ---------------------------------------------------------------------------
// Inputs

const paise = z.number().int("Amount must be in whole paise").positive("Enter an amount above zero").max(1_000_000_000_00, "Amount is too large");

export const recordPaymentSchema = z.object({
  amountPaise: paise,
  method: z.enum(PAYMENT_METHODS, { message: "Pick how it was paid" }),
  ref: z.string().trim().min(3, "Enter the bank, UPI or cheque reference").max(100),
  at: z.iso.date().optional(),
  /** v18: tax the client deducted (TDS). Recorded as its own "TDS" line and counts towards the invoice. */
  tdsPaise: z.number().int().min(0).max(1_00_00_00_000).optional(),
});
export type RecordPayment = z.infer<typeof recordPaymentSchema>;

export const cancelInvoiceSchema = z.object({ reason: z.string().trim().min(5, "Say why the invoice is cancelled").max(500) });

export const createCreditNoteSchema = z.object({
  invoiceId: z.string().min(1, "Pick an invoice"),
  amountPaise: paise,
  reason: z.string().trim().min(5, "Say why the credit note is issued").max(500),
});
export type CreateCreditNote = z.infer<typeof createCreditNoteSchema>;

export const createPayoutSchema = z.object({
  creatorId: z.string().min(1, "Pick a creator"),
  amountPaise: paise,
});
export type CreatePayout = z.infer<typeof createPayoutSchema>;

export const markPayoutPaidSchema = z.object({ ref: z.string().trim().min(3, "Enter the payment reference").max(100) });
