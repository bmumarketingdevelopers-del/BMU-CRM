import type { Transport } from "./transport.js";
import type { LeadRow } from "../crm.js";
import type { CoreUndo } from "../core-actions.js";
import type { FinanceInvoiceDetail } from "../insights-types.js";
import type {
  OpsAnnouncementInput,
  OpsAnnouncementOptions,
  OpsAnnouncementRow,
  OpsClientAccountInput,
  OpsClientAccountRow,
  OpsCreatorCreate,
  OpsCreatorDetail,
  OpsCreatorEdit,
  OpsCreatorRating,
  OpsCreatorRow,
  OpsDueDate,
  OpsDuplicateMatch,
  OpsFileList,
  OpsClientFileFeed,
  OpsFileUpdate,
  OpsIntegrationRow,
  OpsInvoiceCreate,
  OpsInvoiceDescribe,
  OpsInvoiceDescribeResult,
  OpsLeadBulk,
  OpsLeadConvert,
  OpsLeadCreate,
  OpsLeadCreated,
  OpsMaybeApproval,
  OpsMessageToRequest,
  OpsOfflinePayment,
  OpsPayoutPropose,
  OpsPublicShare,
  OpsShareCreate,
  OpsShareLinkView,
  OpsThreadCreate,
  OpsThreadSummary,
  OpsThreadView,
  SentFile,
} from "../ops-actions.js";

const qs = (params: Record<string, string | undefined>) => {
  const p = Object.entries(params).filter(([, v]) => v);
  return p.length ? `?${p.map(([k, v]) => `${k}=${encodeURIComponent(v!)}`).join("&")}` : "";
};
type Msg = { message: string };

export type OpsLeadOptions = { team: { id: string; name: string; manager: boolean }[]; canPickOwner: boolean; referralOnly: boolean; nextOwner: string | null; firstReplyMinutes: number };
export type OpsFinanceOptions = { clients: { id: string; name: string; gstin: string | null; engagements: { id: string; name: string }[] }[]; gstRatePct: number };
export type OpsDraftInvoice = { id: string; number: string; client: string; clientId: string | null; totalPaise: number; dueDate: string; createdAt: string };
export type OpsThreadOptions = { clients: { id: string; name: string; engagements: { id: string; name: string }[] }[]; people: { id: string; name: string }[] };
export type OpsClientFiles = {
  uploads: { id: string; name: string; tags: string[]; sizeBytes: number | null; at: string; url: string }[];
  released: { id: string; name: string; tags: string[]; sizeBytes: number | null; at: string; url: string }[];
  openItems: { id: string; label: string; service: string; engagementId: string }[];
  services: { id: string; name: string }[];
};

/** v11 ops: leads & sales, finance, creators, files, communication and admin configuration actions. */
export const opsActionsApi = (t: Transport) => ({
  ops: {
    leads: {
      options: () => t.get<OpsLeadOptions>("/ops/leads/options"),
      duplicates: (q: { phone?: string; email?: string; company?: string; excludeId?: string }) => t.get<OpsDuplicateMatch[]>(`/ops/leads/duplicates${qs(q)}`),
      create: (body: OpsLeadCreate) => t.post<OpsLeadCreated>("/ops/leads", body),
      bulk: (body: OpsLeadBulk) => t.post<Msg & { ok: true; undo: CoreUndo | null }>("/ops/leads/bulk", body),
      lost: (id: string, reason: string) => t.post<LeadRow>(`/ops/leads/${id}/lost`, { reason }),
      merge: (id: string, intoId: string) => t.post<Msg>(`/ops/leads/${id}/merge`, { intoId }),
      note: (id: string, body: { kind: "note" | "meeting"; body: string; at?: string }) => t.post<Msg & { ok: true }>(`/ops/leads/${id}/notes`, body),
      convertOptions: (id: string) => t.get<{ id: string; label: string; firstPaymentPaise: number }[]>(`/ops/leads/${id}/convert-options`),
      convert: (id: string, body: OpsLeadConvert) => t.post<OpsMaybeApproval>(`/ops/leads/${id}/convert`, body),
    },
    finance: {
      options: () => t.get<OpsFinanceOptions>("/ops/finance/options"),
      createInvoice: (body: OpsInvoiceCreate) => t.post<Msg & { id: string; number: string; status: string; totalPaise: number }>("/ops/finance/invoices", body),
      /** v27: invoice wording (AI when on) for short line descriptions, to review before creating the invoice. */
      describe: (body: OpsInvoiceDescribe) => t.post<OpsInvoiceDescribeResult>("/ops/finance/invoices/describe", body),
      drafts: () => t.get<OpsDraftInvoice[]>("/ops/finance/drafts"),
      issue: (id: string) => t.post<Msg & { id: string }>(`/ops/finance/invoices/${id}/issue`),
      offlinePayment: (id: string, body: OpsOfflinePayment) => t.post<FinanceInvoiceDetail>(`/ops/finance/invoices/${id}/offline-payment`, body),
      dueDate: (id: string, body: OpsDueDate) => t.post<OpsMaybeApproval & { undo?: CoreUndo }>(`/ops/finance/invoices/${id}/due-date`, body),
      proposePayout: (body: OpsPayoutPropose) => t.post<OpsMaybeApproval>("/ops/finance/payouts", body),
    },
    creators: {
      list: (archived = false) => t.get<OpsCreatorRow[]>(`/ops/creators${archived ? "?archived=1" : ""}`),
      get: (id: string) => t.get<OpsCreatorDetail>(`/ops/creators/${id}`),
      duplicates: (q: { phone?: string; handle?: string; email?: string; excludeId?: string }) => t.get<OpsDuplicateMatch[]>(`/ops/creators/duplicates${qs(q)}`),
      create: (body: OpsCreatorCreate) => t.post<Msg & { id: string }>("/ops/creators", body),
      edit: (id: string, body: OpsCreatorEdit) => t.patch<Msg & { id: string }>(`/ops/creators/${id}`, body),
      rate: (briefId: string, body: OpsCreatorRating) => t.post<Msg & { id: string; rating: number; ratingCount: number }>(`/ops/creators/briefs/${briefId}/rating`, body),
    },
    files: {
      list: (q: { clientOrgId?: string; engagementId?: string; folder?: string; archived?: string; direction?: string } = {}) => t.get<OpsFileList>(`/ops/files${qs(q)}`),
      /** v35: files sent to and received from clients (Founder). */
      clientFeed: (days = 7) => t.get<OpsClientFileFeed>(`/ops/files/client-feed?days=${days}`),
      upload: (file: Blob, meta: { clientOrgId: string; engagementId?: string; folder?: string; tags?: string[]; name?: string; departmentId?: string }) => {
        const form = new FormData();
        form.append("file", file);
        form.append("clientOrgId", meta.clientOrgId);
        if (meta.engagementId) form.append("engagementId", meta.engagementId);
        if (meta.folder) form.append("folder", meta.folder);
        if (meta.tags?.length) form.append("tags", meta.tags.join(","));
        if (meta.name) form.append("name", meta.name);
        if (meta.departmentId) form.append("departmentId", meta.departmentId);
        return t.request<Msg & { id: string; name: string }>("/ops/files", { method: "POST", body: form });
      },
      update: (id: string, body: OpsFileUpdate) => t.patch<Msg & { id: string }>(`/ops/files/${id}`, body),
      release: (id: string) => t.post<Msg & { id: string }>(`/ops/files/${id}/release`),
      shares: (id: string) => t.get<OpsShareLinkView[]>(`/ops/files/${id}/shares`),
      share: (id: string, body: OpsShareCreate) => t.post<OpsShareLinkView & Msg>(`/ops/files/${id}/shares`, body),
      revokeShare: (shareId: string) => t.del<Msg & { ok: true }>(`/ops/shares/${shareId}`),
      /** Payment slip / cheque photo for offline payments and manual conversions. */
      proof: (file: Blob) => {
        const form = new FormData();
        form.append("file", file);
        return t.request<{ id: string; name: string; url: string }>("/ops/uploads/proof", { method: "POST", body: form });
      },
      clientList: () => t.get<OpsClientFiles>("/ops/client/files"),
      clientUpload: (file: Blob, meta: { engagementId?: string; requirementItemId?: string; tags?: string[]; note?: string } = {}) => {
        const form = new FormData();
        form.append("file", file);
        if (meta.engagementId) form.append("engagementId", meta.engagementId);
        if (meta.requirementItemId) form.append("requirementItemId", meta.requirementItemId);
        if (meta.tags?.length) form.append("tags", meta.tags.join(","));
        if (meta.note) form.append("note", meta.note);
        return t.request<Msg & { id: string; name: string; ticked: string[] }>("/ops/client/files", { method: "POST", body: form });
      },
      publicShare: (token: string) => t.get<OpsPublicShare>(`/ops/public/share/${token}`),
      unlock: (token: string, password?: string) => t.post<{ downloadUrl: string }>(`/ops/public/share/${token}/unlock`, { password }),
    },
    threads: {
      list: (q: { clientOrgId?: string; kind?: string } = {}) => t.get<OpsThreadSummary[]>(`/ops/threads${qs(q)}`),
      options: () => t.get<OpsThreadOptions>("/ops/threads/options"),
      create: (body: OpsThreadCreate) => t.post<Msg & { id: string }>("/ops/threads", body),
      get: (id: string) => t.get<OpsThreadView>(`/ops/threads/${id}`),
      post: (id: string, body: string, attachmentIds: string[] = []) => t.post<OpsThreadView>(`/ops/threads/${id}/messages`, { body, attachmentIds }),
      /** v38: upload a file to send with the next message (it goes to Files for the people in the discussion). */
      attach: (id: string, file: Blob) => {
        const form = new FormData();
        form.append("file", file);
        return t.request<SentFile>(`/ops/threads/${id}/attachments`, { method: "POST", body: form });
      },
      toRequest: (body: OpsMessageToRequest) => t.post<Msg & { id: string; href: string }>("/ops/messages/to-request", body),
    },
    announcements: {
      list: () => t.get<OpsAnnouncementRow[]>("/ops/announcements"),
      options: () => t.get<OpsAnnouncementOptions>("/ops/announcements/options"),
      send: (body: OpsAnnouncementInput) => t.post<Msg & { id: string; recipientCount: number }>("/ops/announcements", body),
    },
    admin: {
      integrations: () => t.get<OpsIntegrationRow[]>("/ops/admin/integrations"),
      connect: (key: string) => t.post<Msg & { ok: true }>(`/ops/admin/integrations/${key}/connect`),
      disconnect: (key: string, reason: string) => t.post<Msg & { ok: true }>(`/ops/admin/integrations/${key}/disconnect`, { reason }),
      clientAccounts: (clientOrgId: string) => t.get<OpsClientAccountRow[]>(`/ops/admin/clients/${clientOrgId}/accounts`),
      connectClientAccount: (clientOrgId: string, body: OpsClientAccountInput) => t.post<Msg & { id: string }>(`/ops/admin/clients/${clientOrgId}/accounts`, body),
      disconnectClientAccount: (id: string, reason: string) => t.post<Msg & { ok: true }>(`/ops/admin/accounts/${id}/disconnect`, { reason }),
    },
  },
});
