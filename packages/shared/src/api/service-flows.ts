import type { Transport } from "./transport.js";
import type {
  ServiceBillingDetails,
  ServiceBillingDetailsInput,
  ServiceBillingRunInput,
  ServiceBillingRunLog,
  ServiceBillingRunPreview,
  ServiceBillingRunResult,
  ServiceClientBilling,
  ServiceCollectionsActions,
  ServiceDunningRunResult,
  ServiceNotificationPrefsInput,
  ServiceNotificationPrefsView,
  ServiceOutboxDetail,
  ServiceOutboxView,
  ServicePromiseInput,
  ServiceRateRequest,
  ServiceSatisfaction,
  ServiceTaxInvoice,
  ServiceUnread,
} from "../service-flows.js";
import type { InvoiceBrandingInput, InvoiceBrandingKind, InvoiceBrandingView, InvoiceSignResult } from "../invoice-branding.js";
import type { RequestView, ThreadAttachment } from "../requests.js";

export * from "../service-flows.js";

const serviceQs = (params: Record<string, string | undefined>) => {
  const s = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => !!e[1])).toString();
  return s ? `?${s}` : "";
};

/** v10 service flows: billing, tax invoices, dunning, billing run, outbox, preferences, ratings, unread counts. */
export const serviceFlowsApi = (t: Transport) => ({
  service: {
    // Notification preferences (any signed-in person)
    prefs: () => t.get<ServiceNotificationPrefsView>("/service/notification-preferences"),
    savePrefs: (body: ServiceNotificationPrefsInput) => t.put<ServiceNotificationPrefsView>("/service/notification-preferences", body),
    unread: () => t.get<ServiceUnread>("/service/unread"),
    // Message attachments (multipart form with "file"); thread is the team thread id, omitted for clients
    uploadAttachment: (file: File, threadId?: string) => {
      const fd = new FormData();
      fd.append("file", file);
      return t.request<ThreadAttachment>(threadId ? `/threads/${threadId}/attachments` : "/client/thread/attachments", { method: "POST", body: fd });
    },
    // Client billing
    clientBilling: () => t.get<ServiceClientBilling>("/service/client/billing"),
    clientTaxInvoice: (id: string) => t.get<ServiceTaxInvoice>(`/service/client/invoices/${id}/tax-invoice`),
    saveClientBillingDetails: (body: ServiceBillingDetailsInput) => t.put<ServiceBillingDetails>("/service/client/billing-details", body),
    // Request satisfaction
    rateRequest: (id: string, body: ServiceRateRequest) => t.post<RequestView>(`/client/requests/${id}/rate`, body),
    reopenRequest: (id: string, reason: string) => t.post<RequestView>(`/client/requests/${id}/reopen`, { reason }),
    satisfaction: (from?: string, to?: string) => t.get<ServiceSatisfaction>(`/service/satisfaction${serviceQs({ from, to })}`),
    // Finance
    taxInvoice: (id: string) => t.get<ServiceTaxInvoice>(`/service/finance/invoices/${id}/tax-invoice`),
    emailInvoice: (id: string) => t.post<{ sent: number }>(`/service/finance/invoices/${id}/email`),
    /** v27: the Founder's signature and company seal on invoices. */
    invoiceBranding: () => t.get<InvoiceBrandingView>("/finance/invoice-branding"),
    saveInvoiceBranding: (body: InvoiceBrandingInput) => t.put<InvoiceBrandingView>("/finance/invoice-branding", body),
    uploadInvoiceBranding: (kind: InvoiceBrandingKind, file: Blob) => {
      const form = new FormData();
      form.append("file", file);
      return t.request<InvoiceBrandingView>(`/finance/invoice-branding/${kind}`, { method: "POST", body: form });
    },
    removeInvoiceBranding: (kind: InvoiceBrandingKind) => t.del<InvoiceBrandingView>(`/finance/invoice-branding/${kind}`),
    /** v28: the signing password (Founders), the "require signature" rule, and signing an invoice with the password. */
    setSigningPassword: (password: string, confirm: string) => t.put<InvoiceBrandingView>("/finance/invoice-branding/password", { password, confirm }),
    setSigningRule: (requireSignature: boolean) => t.put<InvoiceBrandingView>("/finance/invoice-branding/rule", { requireSignature }),
    signInvoice: (id: string, password: string) => t.post<InvoiceSignResult>(`/finance/invoices/${id}/sign`, { password }),
    clientBillingDetails: (clientId: string) => t.get<ServiceBillingDetails>(`/service/finance/clients/${clientId}/billing-details`),
    saveBillingDetails: (clientId: string, body: ServiceBillingDetailsInput) => t.put<ServiceBillingDetails>(`/service/finance/clients/${clientId}/billing-details`, body),
    collectionsActions: () => t.get<ServiceCollectionsActions>("/service/finance/collections"),
    promise: (invoiceId: string, body: ServicePromiseInput) => t.post<ServiceCollectionsActions>(`/service/finance/invoices/${invoiceId}/promise`, body),
    remindNow: (invoiceId: string) => t.post<{ notified: number; emailed: number }>(`/service/finance/invoices/${invoiceId}/remind`),
    runDunning: () => t.post<ServiceDunningRunResult>("/service/finance/dunning/run"),
    billingRunPreview: (period?: string) => t.get<ServiceBillingRunPreview>(`/service/finance/billing-run${serviceQs({ period })}`),
    billingRunIssue: (body: ServiceBillingRunInput) => t.post<ServiceBillingRunResult>("/service/finance/billing-run", body),
    billingRuns: () => t.get<ServiceBillingRunLog[]>("/service/finance/billing-runs"),
    // Outbox (Founder / Admin)
    outbox: (q?: { status?: string; kind?: string; q?: string }) => t.get<ServiceOutboxView>(`/service/outbox${serviceQs(q ?? {})}`),
    outboxEmail: (id: string) => t.get<ServiceOutboxDetail>(`/service/outbox/${id}`),
    resendEmail: (id: string) => t.post<ServiceOutboxDetail>(`/service/outbox/${id}/resend`),
  },
});
