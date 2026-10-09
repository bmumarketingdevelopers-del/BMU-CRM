import type { Transport } from "./transport.js";
import type { CoreUndo } from "../core-actions.js";
import type {
  ClientsAccount,
  ClientsAmSuggestion,
  ClientsBrandInput,
  ClientsBulk,
  ClientsConvert,
  ClientsConvertPreview,
  ClientsCreate,
  ClientsCreateResult,
  ClientsCustomQuote,
  ClientsDetail,
  ClientsDuplicate,
  ClientsDuplicateQuery,
  ClientsEdit,
  ClientsFormOptions,
  ClientsFromLead,
  ClientsInternalApproval,
  ClientsInvite,
  ClientsListQuery,
  ClientsListRow,
  ClientsPastInvoice,
  ClientsQuoteInput,
  ClientsRaiseRequest,
} from "../clients-actions.js";

const qs = (params: Record<string, string | undefined>) => {
  const p = Object.entries(params).filter(([, v]) => v);
  return p.length ? `?${p.map(([k, v]) => `${k}=${encodeURIComponent(v!)}`).join("&")}` : "";
};

type Done = { ok: true; message: string; approval?: { id: string; summary: string } | null; undo?: CoreUndo | null };

/** v11 clients: add/edit clients, users, brands, services, tiers, pause, offboarding, health, and request actions. */
export const clientsActionsApi = (t: Transport) => ({
  clientsActions: {
    formOptions: () => t.get<ClientsFormOptions>("/clients-actions/form-options"),
    amSuggest: (industry?: string) => t.get<ClientsAmSuggestion[]>(`/clients-actions/am-suggest${qs({ industry })}`),
    duplicates: (q: ClientsDuplicateQuery) => t.post<ClientsDuplicate[]>("/clients-actions/duplicates", q),
    create: (input: ClientsCreate) => t.post<ClientsCreateResult>("/clients-actions", input),
    list: (q: ClientsListQuery = {}) => t.get<ClientsListRow[]>(`/clients-actions/list${qs(q)}`),
    bulk: (input: ClientsBulk) => t.post<Done & { changed: number }>("/clients-actions/bulk", input),
    get: (id: string) => t.get<ClientsDetail>(`/clients-actions/${id}`),
    edit: (id: string, input: ClientsEdit) => t.patch<ClientsDetail & { undo: CoreUndo | null; ignored: string[] }>(`/clients-actions/${id}`, input),
    addBrand: (id: string, input: ClientsBrandInput) => t.post<ClientsDetail>(`/clients-actions/${id}/brands`, input),
    removeBrand: (id: string, brandId: string) => t.del<ClientsDetail>(`/clients-actions/${id}/brands/${brandId}`),
    invite: (id: string, input: ClientsInvite) => t.post<ClientsDetail & { message: string }>(`/clients-actions/${id}/users`, input),
    health: (id: string, input: { status: string; reason: string }) => t.post<ClientsDetail>(`/clients-actions/${id}/health`, input),
    quote: (id: string, input: ClientsQuoteInput) => t.post<ClientsDetail & { message: string }>(`/clients-actions/${id}/quotes`, input),
    sendQuote: (quoteId: string) => t.post<ClientsDetail>(`/clients-actions/quotes/${quoteId}/send`),
    cancelQuote: (quoteId: string) => t.post<ClientsDetail>(`/clients-actions/quotes/${quoteId}/cancel`),
    pause: (engagementId: string, input: { reason: string; until: string }) => t.post<Done>(`/clients-actions/engagements/${engagementId}/pause`, input),
    resume: (engagementId: string) => t.post<Done>(`/clients-actions/engagements/${engagementId}/resume`),
    setGate: (engagementId: string, input: { gate: string; reason: string }) => t.post<Done>(`/clients-actions/engagements/${engagementId}/gate`, input),
    offboard: (id: string, input: { reason: string; lastCycle: string }) => t.post<Done>(`/clients-actions/${id}/offboard`, input),
    offboardTick: (id: string, input: { key: string; done: boolean }) => t.post<ClientsDetail>(`/clients-actions/${id}/offboard/checklist`, input),
    offboardComplete: (id: string) => t.post<ClientsDetail>(`/clients-actions/${id}/offboard/complete`),
    importInvoices: (id: string, invoices: ClientsPastInvoice[]) => t.post<{ ok: true; created: number }>(`/clients-actions/${id}/past-invoices`, { invoices }),
    fromLead: (leadId: string, input: ClientsFromLead) => t.post<ClientsCreateResult>(`/clients-actions/from-lead/${leadId}`, input),
    // Requests
    raiseRequest: (input: ClientsRaiseRequest) => t.post<{ id: string; message: string }>("/clients-actions/requests", input),
    customQuote: (requestId: string, input: ClientsCustomQuote) => t.post<Done>(`/clients-actions/requests/${requestId}/custom-quote`, input),
    convertPreview: (requestId: string) => t.get<ClientsConvertPreview>(`/clients-actions/requests/${requestId}/convert`),
    convert: (requestId: string, input: ClientsConvert) => t.post<{ ok: true; taskIds: string[]; message: string }>(`/clients-actions/requests/${requestId}/convert`, input),
    internalApproval: (input: ClientsInternalApproval) => t.post<Done>("/clients-actions/internal-approval", input),
  },
  clientAccount: {
    get: () => t.get<ClientsAccount>("/client-actions/account"),
    contact: (input: { contactName: string; contactPhone: string; contactEmail: string }) => t.patch<ClientsAccount>("/client-actions/contact", input),
    addBrand: (input: ClientsBrandInput) => t.post<ClientsAccount>("/client-actions/brands", input),
    requestQuote: (input: ClientsQuoteInput) => t.post<ClientsAccount>("/client-actions/quotes", input),
    approveQuote: (id: string) => t.post<ClientsAccount>(`/client-actions/quotes/${id}/approve`),
    declineQuote: (id: string, reason?: string) => t.post<ClientsAccount>(`/client-actions/quotes/${id}/decline`, { reason }),
    decideInvite: (approvalId: string, decision: "approve" | "reject") => t.post<ClientsAccount>(`/client-actions/owner-invites/${approvalId}`, { decision }),
    confirmOffboarding: () => t.post<ClientsAccount>("/client-actions/offboarding/confirm"),
  },
});
