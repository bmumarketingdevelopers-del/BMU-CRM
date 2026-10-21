import type { Transport } from "./transport.js";
import type {
  CapacityView,
  ClientHealthRow,
  CollectionsView,
  CreateCreditNote,
  CreatePayout,
  CreditNotesView,
  FinanceInvoiceDetail,
  FinanceInvoiceList,
  GstSummaryView,
  PaymentsView,
  PayoutsView,
  QualityView,
  RecordPayment,
  RevenuePeriod,
  RevenueView,
  WeeklyReviewView,
  NewClientsView,
  ContentWeekView,
} from "../insights-types.js";

export * from "../insights-types.js";

const qs = (params: Record<string, string | undefined>) => {
  const s = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => !!e[1])).toString();
  return s ? `?${s}` : "";
};

export type InvoiceFilters = {
  status?: string;
  kind?: string;
  clientId?: string;
  q?: string;
  /** v30: issued, created or signed by this person ("system" = made by the CRM and not signed). */
  person?: string;
  /** v30: issued by a Founder, Client Manager, Branch Manager, Finance, team or the CRM. */
  role?: string;
  /** v30: signed | waiting (for a signature) | unsigned */
  signing?: string;
  /** v30: raised from / to (YYYY-MM-DD, India time). */
  from?: string;
  to?: string;
};

/** Command Centre analytics and the Finance desk. */
export const insightsApi = (t: Transport) => ({
  insights: {
    weekly: () => t.get<WeeklyReviewView>("/insights/weekly"),
    /** v33: clients added in the last 30 days and who added them. */
    newClients: () => t.get<NewClientsView>("/insights/new-clients"),
    /** v34: posts this week, waiting on clients, due to post and failed to publish. */
    contentWeek: () => t.get<ContentWeekView>("/insights/content-week"),
    revenue: (period: RevenuePeriod = "month") => t.get<RevenueView>(`/insights/revenue${qs({ period })}`),
    collections: () => t.get<CollectionsView>("/insights/collections"),
    capacity: () => t.get<CapacityView>("/insights/capacity"),
    quality: () => t.get<QualityView>("/insights/quality"),
    clientHealth: () => t.get<ClientHealthRow[]>("/insights/client-health"),
  },
  finance: {
    invoices: (f: InvoiceFilters = {}) => t.get<FinanceInvoiceList>(`/finance/invoices${qs(f)}`),
    invoice: (id: string) => t.get<FinanceInvoiceDetail>(`/finance/invoices/${id}`),
    recordPayment: (id: string, body: RecordPayment) => t.post<FinanceInvoiceDetail>(`/finance/invoices/${id}/payments`, body),
    cancelInvoice: (id: string, reason: string) => t.post<FinanceInvoiceDetail>(`/finance/invoices/${id}/cancel`, { reason }),
    remind: (id: string) => t.post<{ notified: number }>(`/finance/invoices/${id}/remind`),
    payments: () => t.get<PaymentsView>("/finance/payments"),
    creditNotes: () => t.get<CreditNotesView>("/finance/credit-notes"),
    issueCreditNote: (body: CreateCreditNote) => t.post<{ id: string | null; number: string | null; pending?: boolean; approvalId?: string | null; message?: string }>("/finance/credit-notes", body),
    payouts: () => t.get<PayoutsView>("/finance/payouts"),
    addPayout: (body: CreatePayout) => t.post<{ id: string }>("/finance/payouts", body),
    markPayoutPaid: (id: string, ref: string) => t.post<{ id: string }>(`/finance/payouts/${id}/pay`, { ref }),
    gst: (month?: string) => t.get<GstSummaryView>(`/finance/gst${qs({ month })}`),
    /** Paths for browser downloads (the session cookie authenticates them); prefix with the API base. */
    gstCsvPath: (month: string) => `/finance/gst.csv${qs({ month })}`,
    exportCsvPath: (from: string, to: string, format?: string) => `/finance/export.csv${qs({ from, to, format })}`,
  },
});
