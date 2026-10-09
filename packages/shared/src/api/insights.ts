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
} from "../insights-types.js";

export * from "../insights-types.js";

const qs = (params: Record<string, string | undefined>) => {
  const s = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => !!e[1])).toString();
  return s ? `?${s}` : "";
};

export type InvoiceFilters = { status?: string; kind?: string; clientId?: string; q?: string };

/** Command Centre analytics and the Finance desk. */
export const insightsApi = (t: Transport) => ({
  insights: {
    weekly: () => t.get<WeeklyReviewView>("/insights/weekly"),
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
