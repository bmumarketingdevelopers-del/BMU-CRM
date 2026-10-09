import { z } from "zod";

// v18 Finance 2.0 and capacity: payment links, unmatched payments, invoice schedules, expenses and vendor bills,
// a stopwatch for time, profit per client / project / service / person, cash-flow forecast, workload and booking.

const paise = z.number().int("Whole paise only").min(1, "Enter an amount").max(1_00_00_00_000, "That amount is too large");
const paiseOrZero = z.number().int().min(0).max(1_00_00_00_000);
const day = z.iso.date({ message: "Pick a date" });
const optText = (max: number) => z.string().trim().max(max).optional().nullable();

// ---------------------------------------------------------------------------
// Payment links and reconciliation

export type PaymentLinkStatus = "active" | "paid" | "cancelled";
export type PaymentLinkView = {
  id: string;
  invoiceId: string;
  invoiceNumber: string;
  /** Our page (works with and without Razorpay) */
  url: string;
  /** Razorpay's own short link, when Razorpay is set up */
  shortUrl: string | null;
  provider: "razorpay" | "test";
  amountPaise: number;
  status: PaymentLinkStatus;
  createdAt: string;
  paidAt: string | null;
};

export type PublicPayView = {
  invoiceNumber: string;
  client: string;
  company: string;
  totalPaise: number;
  balancePaise: number;
  dueDate: string;
  status: "due" | "paid" | "cancelled";
  provider: "razorpay" | "test";
  shortUrl: string | null;
  /** Development without Razorpay keys: a "Pay (test)" button is shown */
  testMode: boolean;
};

export type UnmatchedStatus = "open" | "matched" | "ignored";
export type UnmatchedSuggestion = { invoiceId: string; number: string; client: string; balancePaise: number; reason: string };
export type UnmatchedPaymentRow = {
  id: string;
  provider: string;
  ref: string;
  amountPaise: number;
  payerName: string | null;
  payerEmail: string | null;
  payerPhone: string | null;
  note: string | null;
  receivedAt: string;
  status: UnmatchedStatus;
  invoiceId: string | null;
  invoiceNumber: string | null;
  suggestions: UnmatchedSuggestion[];
};
export type UnmatchedList = { open: UnmatchedPaymentRow[]; done: UnmatchedPaymentRow[] };

export const matchPaymentSchema = z.object({ invoiceId: z.string().min(1, "Pick an invoice") });
export type MatchPayment = z.infer<typeof matchPaymentSchema>;

/** A bank or UPI credit typed in from the statement, to be matched to an invoice. */
export const unmatchedCreateSchema = z.object({
  amountPaise: paise,
  ref: z.string().trim().min(3, "Enter the bank or UPI reference").max(100),
  payerName: optText(120),
  note: optText(300),
  receivedOn: day.optional(),
});
export type UnmatchedCreate = z.infer<typeof unmatchedCreateSchema>;

// ---------------------------------------------------------------------------
// Invoice schedules

export const SCHEDULE_KINDS = ["milestone", "retainer", "one_off"] as const;
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number];
export const scheduleKindLabels: Record<ScheduleKind, string> = { milestone: "Milestone", retainer: "Retainer instalment", one_off: "One-off" };
export type ScheduleStatus = "planned" | "issued" | "skipped";

export type InvoiceScheduleRow = {
  id: string;
  clientId: string;
  client: string;
  engagementId: string | null;
  project: string | null;
  label: string;
  amountPaise: number;
  dueOn: string;
  kind: ScheduleKind;
  status: ScheduleStatus;
  invoiceId: string | null;
  invoiceNumber: string | null;
  error: string | null;
};

export const invoiceScheduleSchema = z.object({
  clientOrgId: z.string().min(1, "Pick a client"),
  engagementId: z.string().min(1).optional().nullable(),
  label: z.string().trim().min(2, "Name the milestone").max(160),
  amountPaise: paise,
  dueOn: day,
  kind: z.enum(SCHEDULE_KINDS).default("milestone"),
});
export type InvoiceScheduleInput = z.input<typeof invoiceScheduleSchema>;

/** Split a project fee into instalments (e.g. 50 / 30 / 20). */
export const schedulePlanSchema = z.object({
  clientOrgId: z.string().min(1, "Pick a client"),
  engagementId: z.string().min(1).optional().nullable(),
  totalPaise: paise,
  parts: z
    .array(z.object({ label: z.string().trim().min(2).max(160), pct: z.number().min(1).max(100), dueOn: day }))
    .min(1, "Add at least one instalment")
    .max(12)
    .refine((p) => Math.round(p.reduce((s, x) => s + x.pct, 0)) === 100, "Instalments must add up to 100%"),
});
export type SchedulePlan = z.infer<typeof schedulePlanSchema>;

export const scheduleUpdateSchema = z.object({
  label: z.string().trim().min(2).max(160).optional(),
  amountPaise: paise.optional(),
  dueOn: day.optional(),
  status: z.enum(["planned", "skipped"]).optional(),
});
export type ScheduleUpdate = z.infer<typeof scheduleUpdateSchema>;

// ---------------------------------------------------------------------------
// Expenses and vendor bills

export const EXPENSE_KINDS = ["expense", "vendor_bill"] as const;
export type ExpenseKind = (typeof EXPENSE_KINDS)[number];
export const EXPENSE_CATEGORIES = ["software", "freelancer", "ad_spend", "production", "travel", "equipment", "printing", "office", "food", "other"] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];
export const expenseCategoryLabels: Record<ExpenseCategory, string> = {
  software: "Software and tools",
  freelancer: "Freelancer",
  ad_spend: "Ad spend",
  production: "Shoot and production",
  travel: "Travel",
  equipment: "Equipment",
  printing: "Printing",
  office: "Office",
  food: "Food and hospitality",
  other: "Other",
};
export type ExpenseStatus = "submitted" | "approved" | "rejected" | "paid";
export const expenseStatusLabels: Record<ExpenseStatus, string> = { submitted: "Waiting for approval", approved: "Approved", rejected: "Rejected", paid: "Paid" };

export type ExpenseRow = {
  id: string;
  kind: ExpenseKind;
  category: ExpenseCategory;
  vendorName: string | null;
  billNumber: string | null;
  description: string;
  date: string;
  dueDate: string | null;
  amountPaise: number;
  gstPaise: number;
  tdsPaise: number;
  /** amount + GST - TDS: what leaves the bank */
  payablePaise: number;
  clientId: string | null;
  client: string | null;
  engagementId: string | null;
  project: string | null;
  billable: boolean;
  invoiceId: string | null;
  status: ExpenseStatus;
  receiptFileId: string | null;
  paidAt: string | null;
  paidRef: string | null;
  createdBy: string;
  createdById: string;
  decidedBy: string | null;
  decisionNote: string | null;
  createdAt: string;
};
export type ExpenseList = {
  rows: ExpenseRow[];
  totals: { waitingPaise: number; approvedUnpaidPaise: number; paidThisMonthPaise: number; billableUnbilledPaise: number };
  canDecide: boolean;
};

export const expenseSchema = z
  .object({
    kind: z.enum(EXPENSE_KINDS).default("expense"),
    category: z.enum(EXPENSE_CATEGORIES, { message: "Pick a category" }),
    vendorName: optText(120),
    billNumber: optText(60),
    description: z.string().trim().min(3, "Say what it was for").max(500),
    date: day,
    dueDate: day.optional().nullable(),
    amountPaise: paise,
    gstPaise: paiseOrZero.default(0),
    tdsPaise: paiseOrZero.default(0),
    clientOrgId: z.string().min(1).optional().nullable(),
    engagementId: z.string().min(1).optional().nullable(),
    billable: z.boolean().default(false),
    receiptFileId: z.string().min(1).optional().nullable(),
  })
  .refine((e) => e.kind !== "vendor_bill" || !!e.vendorName?.trim(), { message: "Enter the vendor", path: ["vendorName"] })
  .refine((e) => !e.billable || !!e.clientOrgId, { message: "Pick the client to re-bill", path: ["clientOrgId"] })
  .refine((e) => e.tdsPaise <= e.amountPaise, { message: "TDS cannot be more than the amount", path: ["tdsPaise"] });
export type ExpenseInput = z.input<typeof expenseSchema>;

export const expenseDecisionSchema = z.object({ approve: z.boolean(), note: optText(500) });
export type ExpenseDecision = z.infer<typeof expenseDecisionSchema>;
export const expensePaidSchema = z.object({ ref: z.string().trim().min(3, "Enter the payment reference").max(100), paidOn: day.optional() });
export type ExpensePaid = z.infer<typeof expensePaidSchema>;

// ---------------------------------------------------------------------------
// Stopwatch

export type TimerView = {
  running: null | { taskId: string | null; taskTitle: string | null; engagementId: string | null; project: string | null; note: string | null; startedAt: string };
};
export const timerStartSchema = z.object({ taskId: z.string().min(1).optional().nullable(), engagementId: z.string().min(1).optional().nullable(), note: optText(300) });
export type TimerStart = z.infer<typeof timerStartSchema>;
export type TimerStopResult = { minutes: number; entryId: string | null; note: string };

// ---------------------------------------------------------------------------
// Profit 2.0

export type ProfitRow = {
  key: string;
  label: string;
  sub?: string;
  revenuePaise: number;
  labourPaise: number;
  payoutsPaise: number;
  expensesPaise: number;
  profitPaise: number;
  marginPct: number | null;
  hours: number;
};
export type PersonProfitRow = { userId: string; name: string; role: string; hours: number; clientHours: number; ratePaise: number; costPaise: number; utilisationPct: number };
export type ProfitView = {
  from: string;
  to: string;
  formula: string[];
  totals: Omit<ProfitRow, "key" | "label" | "sub">;
  byClient: ProfitRow[];
  byEngagement: ProfitRow[];
  byService: ProfitRow[];
  byPerson: PersonProfitRow[];
};

// ---------------------------------------------------------------------------
// Cash-flow forecast

export type CashflowItem = { label: string; amountPaise: number; kind: "invoice" | "schedule" | "bill" | "payout" | "payroll" | "overheads"; link?: string };
export type CashflowWeek = { weekStart: string; inPaise: number; outPaise: number; netPaise: number; closingPaise: number; items: CashflowItem[] };
export type CashflowView = { openingPaise: number; asOf: string; weeks: CashflowWeek[]; lowestPaise: number; lowestWeek: string; assumptions: string[] };

// ---------------------------------------------------------------------------
// Capacity: workload heatmap and resource booking

export type WorkloadCell = {
  weekStart: string;
  availableHours: number;
  bookedHours: number;
  taskHours: number;
  leaveDays: number;
  holidayDays: number;
  /** (booked + task hours) / available, or null when not available that week */
  loadPct: number | null;
};
export type WorkloadPerson = { userId: string; name: string; specialty: string | null; role: string; weeklyHours: number; cells: WorkloadCell[] };
export type BookingStatus = "booked" | "requested";
export type BookingRow = {
  id: string;
  engagementId: string;
  project: string;
  client: string;
  userId: string | null;
  person: string | null;
  specialty: string | null;
  weekStart: string;
  hours: number;
  note: string | null;
  status: BookingStatus;
};
export type WorkloadView = { weeks: string[]; people: WorkloadPerson[]; bookings: BookingRow[]; requests: BookingRow[]; canBook: boolean; holidays: { date: string; name: string }[] };

export const bookingSchema = z
  .object({
    engagementId: z.string().min(1, "Pick a project"),
    userId: z.string().min(1).optional().nullable(),
    specialty: z.string().trim().min(2).max(60).optional().nullable(),
    weekStart: day,
    weeks: z.number().int().min(1).max(12).default(1),
    hours: z.number().int().min(1, "Book at least an hour").max(80, "At most 80 hours a week"),
    note: optText(300),
  })
  .refine((b) => !!b.userId || !!b.specialty, { message: "Pick a person or the skill you need", path: ["userId"] });
export type BookingInput = z.input<typeof bookingSchema>;
export type BookingResult = { created: BookingRow[]; skipped: { weekStart: string; reason: string }[] };

export const bookingUpdateSchema = z.object({ hours: z.number().int().min(1).max(80).optional(), userId: z.string().min(1).optional(), note: optText(300) });
export type BookingUpdate = z.infer<typeof bookingUpdateSchema>;

export type BookingSuggestion = { userId: string; name: string; specialty: string | null; freeHours: number; qualityPct: number | null; score: number; reason: string };
export type BookingSuggestions = { weekStart: string; specialty: string | null; candidates: BookingSuggestion[] };

export const weeklyHoursSchema = z.object({ weeklyHours: z.number().int().min(0).max(80) });

/** Pickers for the v18 forms: clients with their projects (the person's own scope) and active team members. */
export type MoneyOptions = {
  clients: { id: string; name: string; projects: { id: string; label: string }[] }[];
  people: { id: string; name: string; specialty: string | null }[];
  specialties: { id: string; label: string }[];
};
