import type { Transport } from "./transport.js";
import type {
  BookingInput,
  BookingResult,
  BookingRow,
  BookingSuggestions,
  BookingUpdate,
  CashflowView,
  ExpenseDecision,
  ExpenseInput,
  ExpenseList,
  ExpensePaid,
  ExpenseRow,
  InvoiceScheduleInput,
  InvoiceScheduleRow,
  MatchPayment,
  MoneyOptions,
  PaymentLinkView,
  ProfitView,
  PublicPayView,
  ScheduleUpdate,
  SchedulePlan,
  TimerStart,
  TimerStopResult,
  TimerView,
  UnmatchedCreate,
  UnmatchedList,
  WorkloadView,
} from "../finance2-types.js";

export * from "../finance2-types.js";

const qs = (params: Record<string, string | undefined>) => {
  const s = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => !!e[1])).toString();
  return s ? `?${s}` : "";
};

/** v18: payment links, reconciliation, invoice schedules, expenses, stopwatch, profit, cash flow, workload and booking. */
export const finance2Api = (t: Transport) => ({
  money: {
    options: () => t.get<MoneyOptions>("/money/options"),
    links: (invoiceId: string) => t.get<PaymentLinkView[]>(`/money/invoices/${invoiceId}/links`),
    createLink: (invoiceId: string) => t.post<PaymentLinkView>(`/money/invoices/${invoiceId}/links`),
    cancelLink: (id: string) => t.post<PaymentLinkView>(`/money/links/${id}/cancel`),
    publicPay: (token: string) => t.get<PublicPayView>(`/public/pay/${encodeURIComponent(token)}`),
    publicPayTest: (token: string) => t.post<PublicPayView>(`/public/pay/${encodeURIComponent(token)}/test`),
    unmatched: () => t.get<UnmatchedList>("/money/unmatched"),
    addUnmatched: (body: UnmatchedCreate) => t.post<UnmatchedList>("/money/unmatched", body),
    match: (id: string, body: MatchPayment) => t.post<UnmatchedList>(`/money/unmatched/${id}/match`, body),
    ignore: (id: string) => t.post<UnmatchedList>(`/money/unmatched/${id}/ignore`),
    schedules: (q: { clientId?: string; engagementId?: string; status?: string } = {}) => t.get<InvoiceScheduleRow[]>(`/money/schedules${qs(q)}`),
    addSchedule: (body: InvoiceScheduleInput) => t.post<InvoiceScheduleRow>("/money/schedules", body),
    planSchedule: (body: SchedulePlan) => t.post<InvoiceScheduleRow[]>("/money/schedules/plan", body),
    updateSchedule: (id: string, body: ScheduleUpdate) => t.patch<InvoiceScheduleRow>(`/money/schedules/${id}`, body),
    issueSchedule: (id: string) => t.post<InvoiceScheduleRow>(`/money/schedules/${id}/issue`),
    expenses: (q: { kind?: string; status?: string; mine?: string } = {}) => t.get<ExpenseList>(`/money/expenses${qs(q)}`),
    addExpense: (body: ExpenseInput) => t.post<ExpenseRow>("/money/expenses", body),
    updateExpense: (id: string, body: ExpenseInput) => t.put<ExpenseRow>(`/money/expenses/${id}`, body),
    decideExpense: (id: string, body: ExpenseDecision) => t.post<ExpenseRow>(`/money/expenses/${id}/decide`, body),
    payExpense: (id: string, body: ExpensePaid) => t.post<ExpenseRow>(`/money/expenses/${id}/paid`, body),
    rebillExpenses: (clientOrgId: string) => t.post<{ invoiceId: string; number: string; count: number }>(`/money/expenses/rebill`, { clientOrgId }),
    deleteExpense: (id: string) => t.del<{ ok: true }>(`/money/expenses/${id}`),
    profit: (q: { from?: string; to?: string } = {}) => t.get<ProfitView>(`/money/profit${qs(q)}`),
    cashflow: () => t.get<CashflowView>("/money/cashflow"),
  },
  timer: {
    get: () => t.get<TimerView>("/timer"),
    start: (body: TimerStart) => t.post<TimerView>("/timer/start", body),
    stop: () => t.post<TimerStopResult>("/timer/stop"),
    discard: () => t.post<TimerView>("/timer/discard"),
  },
  capacity: {
    workload: (q: { from?: string; weeks?: string; team?: string } = {}) => t.get<WorkloadView>(`/capacity/workload${qs(q)}`),
    book: (body: BookingInput) => t.post<BookingResult>("/capacity/bookings", body),
    updateBooking: (id: string, body: BookingUpdate) => t.patch<BookingRow>(`/capacity/bookings/${id}`, body),
    deleteBooking: (id: string) => t.del<{ ok: true }>(`/capacity/bookings/${id}`),
    projectBookings: (engagementId: string) => t.get<BookingRow[]>(`/capacity/projects/${engagementId}/bookings`),
    suggest: (q: { weekStart: string; specialty?: string; hours?: string }) => t.get<BookingSuggestions>(`/capacity/suggest${qs(q)}`),
    setWeeklyHours: (userId: string, weeklyHours: number) => t.put<{ ok: true }>(`/capacity/people/${userId}/hours`, { weeklyHours }),
  },
});
