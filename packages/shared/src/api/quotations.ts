import type { Transport } from "./transport.js";
import type { QuoteAcceptFileKind, QuoteDecisionInput, QuoteOverviewInput, QuotePaidInput, QuoteRow, QuoteSaveInput, QuoteTemplateInput, QuoteTemplateRow, QuoteView } from "../quotations.js";

const qs = (q: Record<string, string | undefined>) => {
  const p = new URLSearchParams(Object.entries(q).filter((e): e is [string, string] => !!e[1]));
  const s = p.toString();
  return s ? `?${s}` : "";
};

/** v45 quotations: the team makes and sends them; the client accepts in the app (the advance invoice follows). */
export const quotationsApi = (t: Transport) => ({
  quotes: {
    list: (q: { clientOrgId?: string; status?: string } = {}) => t.get<QuoteRow[]>(`/quotes${qs(q)}`),
    get: (id: string) => t.get<QuoteView>(`/quotes/${id}`),
    create: (body: QuoteSaveInput) => t.post<QuoteView>("/quotes", body),
    update: (id: string, body: QuoteSaveInput) => t.patch<QuoteView>(`/quotes/${id}`, body),
    send: (id: string) => t.post<QuoteView & { message: string }>(`/quotes/${id}/send`),
    cancel: (id: string) => t.post<QuoteView>(`/quotes/${id}/cancel`),
    overview: (body: QuoteOverviewInput) => t.post<{ text: string; ai: boolean }>("/quotes/overview", body),
    raiseAdvance: (id: string) => t.post<QuoteView & { message: string }>(`/quotes/${id}/advance-invoice`),
    raiseBalance: (id: string) => t.post<QuoteView & { message: string }>(`/quotes/${id}/balance-invoice`),
    confirmPayment: (id: string) => t.post<QuoteView & { message: string }>(`/quotes/${id}/confirm-payment`),
    templates: () => t.get<QuoteTemplateRow[]>("/quotes/templates"),
    saveTemplate: (body: QuoteTemplateInput, id?: string) => (id ? t.patch<QuoteTemplateRow>(`/quotes/templates/${id}`, body) : t.post<QuoteTemplateRow>("/quotes/templates", body)),
    deleteTemplate: (id: string) => t.del<{ ok: true }>(`/quotes/templates/${id}`),
    /** Client portal */
    mine: () => t.get<QuoteRow[]>("/client/quotes"),
    mineOne: (id: string) => t.get<QuoteView>(`/client/quotes/${id}`),
    decide: (id: string, body: QuoteDecisionInput) => t.post<QuoteView & { message: string }>(`/client/quotes/${id}/decision`, body),
    notifyPaid: (id: string, body: QuotePaidInput) => t.post<QuoteView & { message: string }>(`/client/quotes/${id}/paid`, body),
    uploadAcceptance: (id: string, kind: QuoteAcceptFileKind, file: Blob) => {
      const form = new FormData();
      form.append("file", file);
      return t.request<{ fileId: string }>(`/client/quotes/${id}/files/${kind}`, { method: "POST", body: form });
    },
  },
});
