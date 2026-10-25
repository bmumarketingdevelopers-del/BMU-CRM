import type { EnquiryInput, Health } from "./schemas.js";
import type { Me } from "./auth.js";
import type { LeadRow, LeadUpdate } from "./crm.js";
import type { InviteUser, OrgTree, OrgUser, RoleWithPermissions, UpdateUser } from "./admin.js";
import type { CreateProposal, PricedAddOn, PricedBundle, PricedService, ProposalView } from "./proposals.js";
import type { ClientInvoice, ClientOverview, ClientRow } from "./client.js";
import type { ClientOnboarding, ClientPlanView, EngagementDetail, EngagementRow, PlanContent } from "./delivery.js";
import type {
  ClientDeliverableDetail,
  DeliverableDetail,
  EodInput,
  FlowTemplateInput,
  FlowTemplateView,
  MyDayView,
  QcQueueItem,
  QcSubmit,
  ReviewCommentInput,
  ReviewListItem,
  TaskView,
  UpdateTask,
} from "./production.js";
import type { Transport } from "./api/transport.js";
import { settingsApi } from "./api/settings.js";
import { insightsApi } from "./api/insights.js";
import { adminOrgApi } from "./api/admin-org.js";
import { adminPlatformApi } from "./api/admin-platform.js";
import { workspaceApi } from "./api/workspace.js";
import { automationsApi } from "./api/automations.js";
import { analyticsApi } from "./api/analytics.js";
import { opsAnalyticsApi } from "./api/ops-analytics.js";
import { flowsApi } from "./api/flows.js";
import { sellFlowsApi } from "./api/sell-flows.js";
import { serviceFlowsApi } from "./api/service-flows.js";
import { deliverFlowsApi } from "./api/deliver-flows.js";
import { craftFlowsApi } from "./api/craft-flows.js";
import { aiFlowsApi } from "./api/ai-flows.js";
import { teamFlowsApi } from "./api/team-flows.js";
import { coreActionsApi } from "./api/core-actions.js";
import { clientsActionsApi } from "./api/clients-actions.js";
import { peopleActionsApi } from "./api/people-actions.js";
import { opsActionsApi } from "./api/ops-actions.js";
import { dashboardsApi } from "./api/dashboards.js";
import { platformApi } from "./api/platform.js";
import { workflowsApi } from "./api/workflows.js";
import { customiseApi } from "./api/customise.js";
import { agentsApi } from "./api/agents.js";
import { creativeApi } from "./api/creative.js";
import { commsApi } from "./api/comms.js";
import { finance2Api } from "./api/finance2.js";
import { integrationsApi } from "./api/integrations.js";
import { v20Api, type SignInResult } from "./api/v20.js";
import type { ClientFile, CreateRequest, DecideRequest, FinalDeliveryView, NotificationView, RequestView, ThreadSummary, ThreadView } from "./requests.js";

export type QcTemplateView = { id: string; key: string; name: string; version: number; items: string[] };

export type PublicProposal = {
  proposal: ProposalView;
  payments: { razorpay: boolean; testMode: boolean };
  /** Proposal intro, terms and agreement text from Command Centre → Proposal & Agreement Templates. */
  documents?: { intro: string; terms: string; agreement: string };
};
export type Checkout =
  | { mode: "paid" | "test" | "unavailable" }
  | {
      mode: "razorpay";
      keyId: string;
      orderId: string;
      amountPaise: number;
      invoiceNumber: string;
      prefill: { name?: string; email?: string; contact?: string };
    };

export type ServiceSummary = {
  id: string;
  name: string;
  track: string;
  billingType: string;
  tiers: { tier: string; pricePaise: number }[];
};

export type AuditRow = {
  id: string;
  action: string;
  entity: string;
  entityId: string;
  at: string;
  actor: { id: string; name: string } | null;
  before: unknown;
  after: unknown;
};

/** Audit Log search (v44): filters, a page of entries and the choices for the filter menus. */
export type AuditQuery = { q?: string; actor?: string; area?: string; from?: string; to?: string; page?: number };
export type AuditPage = {
  rows: AuditRow[];
  total: number;
  page: number;
  size: number;
  /** "branch": a Branch Manager sees changes made by people in their branch. */
  scope: "all" | "branch";
  actors: { id: string; name: string }[];
  areas: string[];
};

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    /** A machine-readable reason when the API gives one (e.g. "two_factor_required"). */
    public code?: string,
  ) {
    super(message);
  }
}

type Options = {
  /** Returns a bearer token (mobile). The web app relies on the session cookie instead. */
  getToken?: () => string | null | Promise<string | null>;
  /** Extra headers on every request, e.g. a forwarded Cookie header on the server. */
  headers?: Record<string, string>;
  /** Called when the API answers 401 (signed out or session expired), e.g. to send the browser to sign-in. */
  onUnauthorized?: (path: string) => void;
  /** v20: called when the API says this person must set up two-factor before doing anything else. */
  onTwoFactorRequired?: (path: string) => void;
};

type UploadTicket = { direct: false } | { direct: true; key: string; url: string; token: string; exp: number; sig: string; apikey?: string };

const toBase64Url = (text: string) => {
  let bin = "";
  for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** Typed client for the BMU Hub API, used by the website and the mobile app. */
export function createApiClient(baseUrl: string, options: Options = {}) {
  /** v22: false once the API has said it keeps files on its own disk (no direct uploads). */
  let directUploads: boolean | undefined;

  /**
   * v22: uploads one file straight to Supabase Storage (the API runs on Vercel, which refuses requests over 4.5 MB)
   * and returns the header that tells the upload endpoint where it is. Null when the API stores files itself.
   */
  async function storeFile(file: Blob, field = "file"): Promise<Record<string, string> | null> {
    if (directUploads === false) return null;
    const name = (file as File).name || "file";
    const type = file.type || "application/octet-stream";
    const ticket = await request<UploadTicket>("/storage/uploads", { method: "POST", body: JSON.stringify({ name, type, size: file.size }) });
    if (!ticket.direct) {
      directUploads = false;
      return null;
    }
    directUploads = true;
    const put = await fetch(ticket.url, { method: "PUT", body: file, headers: { "Content-Type": type, "x-upsert": "false", ...(ticket.apikey ? { apikey: ticket.apikey } : {}) } });
    if (!put.ok) {
      let message = `Upload failed (${put.status})`;
      try {
        const body = (await put.json()) as { message?: unknown; error?: unknown };
        if (typeof body.message === "string") message = /maximum allowed size|too large/i.test(body.message) ? "That file is larger than storage allows" : body.message;
      } catch {
        // keep default message
      }
      throw new ApiError(put.status, message);
    }
    return { "X-BMU-Stored-File": toBase64Url(JSON.stringify({ field, key: ticket.key, name, type, exp: ticket.exp, sig: ticket.sig })) };
  }

  /** A form with exactly one file: upload the file directly and send the other fields as JSON instead. */
  async function directForm(form: FormData): Promise<RequestInit | null> {
    if (directUploads === false || typeof Blob === "undefined") return null;
    const entries: [string, FormDataEntryValue][] = [];
    form.forEach((v, k) => entries.push([k, v]));
    const files = entries.filter(([, v]) => v instanceof Blob);
    if (files.length !== 1) return null;
    const [field, file] = files[0] as [string, Blob];
    const headers = await storeFile(file, field);
    if (!headers) return null;
    const fields = Object.fromEntries(entries.filter(([, v]) => !(v instanceof Blob)).map(([k, v]) => [k, String(v)]));
    return { body: JSON.stringify(fields), headers };
  }

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (typeof FormData !== "undefined" && init.body instanceof FormData) {
      const direct = await directForm(init.body);
      if (direct) init = { ...init, body: direct.body, headers: { ...(init.headers as Record<string, string> | undefined), ...(direct.headers as Record<string, string>) } };
    }
    const token = await options.getToken?.();
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
      credentials: "include",
      ...init,
      headers: {
        ...(typeof FormData !== "undefined" && init.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...options.headers,
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    if (!res.ok) {
      let message = `Request failed (${res.status})`;
      let code: string | undefined;
      try {
        const body = (await res.json()) as { message?: unknown; code?: unknown };
        if (typeof body.code === "string") code = body.code;
        if (typeof body.message === "string") message = body.message;
        else if (Array.isArray(body.message)) message = String(body.message[0]?.message ?? body.message[0]);
      } catch {
        // keep default message
      }
      if (res.status === 401 && !path.startsWith("/auth/")) options.onUnauthorized?.(path);
      if (res.status === 403 && code === "two_factor_required") options.onTwoFactorRequired?.(path);
      throw new ApiError(res.status, message, code);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }
  const post = <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
  const patch = <T>(path: string, body: unknown) => request<T>(path, { method: "PATCH", body: JSON.stringify(body) });
  const t: Transport = {
    request,
    get: <T>(path: string) => request<T>(path),
    post,
    patch,
    put: <T>(path: string, body: unknown) => request<T>(path, { method: "PUT", body: JSON.stringify(body) }),
    del: <T>(path: string) => request<T>(path, { method: "DELETE" }),
    storeFile,
  };

  return {
    ...settingsApi(t),
    ...insightsApi(t),
    ...adminOrgApi(t),
    ...adminPlatformApi(t),
    ...workspaceApi(t),
    ...automationsApi(t),
    ...analyticsApi(t),
    ...opsAnalyticsApi(t),
    ...flowsApi(t),
    ...sellFlowsApi(t),
    ...serviceFlowsApi(t),
    ...deliverFlowsApi(t),
    ...craftFlowsApi(t),
    ...aiFlowsApi(t),
    ...teamFlowsApi(t),
    ...coreActionsApi(t),
    ...clientsActionsApi(t),
    ...peopleActionsApi(t),
    ...opsActionsApi(t),
    ...dashboardsApi(t),
    ...platformApi(t),
    ...workflowsApi(t),
    ...customiseApi(t),
    ...agentsApi(t),
    ...creativeApi(t),
    ...commsApi(t),
    ...finance2Api(t),
    ...integrationsApi(t),
    ...v20Api(t),
    health: () => request<Health>("/health"),
    services: () => request<ServiceSummary[]>("/catalogue/services"),
    createEnquiry: (input: EnquiryInput) => post<{ id: string }>("/leads/enquiry", input),

    auth: {
      requestOtp: (identifier: string) => post<{ sent: true; devCode?: string }>("/auth/otp/request", { identifier }),
      verifyOtp: (identifier: string, code: string) => post<SignInResult>("/auth/otp/verify", { identifier, code }),
      me: () => request<Me>("/auth/me"),
      /** Sign-in methods this server offers, e.g. { google: true } when "Continue with Google" is set up. */
      methods: () => request<{ google: boolean }>("/auth/methods"),
      logout: () => post<void>("/auth/logout"),
      demoAccounts: () => request<{ name: string; email: string; role: string }[]>("/auth/demo-accounts"),
    },

    org: {
      tree: () => request<OrgTree>("/org/tree"),
      users: () => request<OrgUser[]>("/org/users"),
      invite: (input: InviteUser) => post<OrgUser>("/org/users", input),
      updateUser: (id: string, input: UpdateUser) => patch<OrgUser>(`/org/users/${id}`, input),
      roles: () => request<RoleWithPermissions[]>("/org/roles"),
      setPermission: (roleId: string, capability: string, scope: string) =>
        patch<RoleWithPermissions>(`/org/roles/${roleId}/permissions`, { capability, scope }),
      cloneRole: (roleId: string, name: string) => post<RoleWithPermissions>(`/org/roles/${roleId}/clone`, { name }),
    },

    catalogue: {
      admin: () => request<CatalogueAdmin>("/catalogue/admin"),
      setTierPrice: (serviceKey: string, tier: string, priceRupees: number) =>
        patch<CatalogueAdmin>("/catalogue/tiers", { serviceKey, tier, priceRupees }),
      setBundleDiscount: (key: string, discountPct: number) => patch<CatalogueAdmin>(`/catalogue/bundles/${key}`, { discountPct }),
      saveAddOn: (name: string, input: { name: string; priceRupees: number | null; unit?: string | null; isCustomQuote: boolean }) =>
        request<CatalogueAdmin>(`/catalogue/add-ons/${encodeURIComponent(name)}`, { method: "PUT", body: JSON.stringify(input) }),
      removeAddOn: (name: string) => request<CatalogueAdmin>(`/catalogue/add-ons/${encodeURIComponent(name)}`, { method: "DELETE" }),
      versions: () => request<{ id: string; version: string; status: string; effectiveFrom: string; proposals: number }[]>("/catalogue/versions"),
    },

    leads: {
      list: (filters?: Record<string, string>) => request<LeadRow[]>(`/leads${filters && Object.keys(filters).length ? `?${new URLSearchParams(filters)}` : ""}`),
      assignees: () => request<{ id: string; name: string; roles: { baseRole: string }[] }[]>("/leads/assignees"),
      update: (id: string, input: LeadUpdate) => patch<LeadRow>(`/leads/${id}`, input),
    },

    audit: {
      list: () => request<AuditRow[]>("/audit"),
      /** Search, filter and page through every entry. */
      search: (q: AuditQuery = {}) => request<AuditPage>(`/audit/search?${new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => [k, String(v)]))}`),
    },

    proposals: {
      list: () => request<ProposalView[]>("/proposals"),
      pricing: () =>
        request<{ priceBookId: string; services: PricedService[]; addOns: PricedAddOn[]; bundles: PricedBundle[] }>("/proposals/pricing"),
      get: (id: string) => request<ProposalView>(`/proposals/${id}`),
      create: (input: Partial<CreateProposal> & Pick<CreateProposal, "leadId" | "lines">) => post<ProposalView>("/proposals", input),
      send: (id: string) => post<ProposalView>(`/proposals/${id}/send`),
      approveDiscount: (id: string) => post<ProposalView>(`/proposals/${id}/approve-discount`),
    },

    publicProposal: {
      view: (token: string, preview?: boolean) => request<PublicProposal>(`/public/proposals/${token}${preview ? "?preview=1" : ""}`),
      accept: (token: string, input: { signerName: string; signerEmail: string; signerDesignation?: string; agree: true }) =>
        post<PublicProposal>(`/public/proposals/${token}/accept`, input),
      checkout: (token: string) => post<Checkout>(`/public/proposals/${token}/checkout`),
      verify: (token: string, input: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }) =>
        post<PublicProposal>(`/public/proposals/${token}/verify`, input),
      payTest: (token: string) => post<PublicProposal>(`/public/proposals/${token}/pay-test`),
    },

    client: {
      overview: () => request<ClientOverview>("/client/overview"),
      invoices: () => request<ClientInvoice[]>("/client/invoices"),
      onboarding: () => request<ClientOnboarding>("/client/onboarding"),
      submitRequirement: (id: string, note: string) => post<ClientOnboarding>(`/client/requirements/${id}/submit`, { note }),
      plans: () => request<ClientPlanView[]>("/client/plans"),
      approvePlan: (planId: string) => post<ClientPlanView[]>(`/client/plans/${planId}/approve`),
      requestPlanChanges: (planId: string, comment: string) => post<ClientPlanView[]>(`/client/plans/${planId}/request-changes`, { comment }),
      reviews: () => request<ReviewListItem[]>("/client/reviews"),
      review: (id: string) => request<ClientDeliverableDetail>(`/client/reviews/${id}`),
      reviewComment: (id: string, input: Omit<ReviewCommentInput, "internal"> & { versionId: string }) =>
        post<ClientDeliverableDetail>(`/client/reviews/${id}/comments`, input),
      approveVersion: (id: string, versionId: string) => post<ClientDeliverableDetail>(`/client/reviews/${id}/approve`, { versionId }),
      requestVersionChanges: (id: string, comment?: string) => post<ClientDeliverableDetail>(`/client/reviews/${id}/request-changes`, { comment }),
      requests: () => request<RequestView[]>("/client/requests"),
      request: (id: string) => request<RequestView>(`/client/requests/${id}`),
      createRequest: (input: CreateRequest) => post<RequestView>("/client/requests", input),
      commentRequest: (id: string, body: string) => post<RequestView>(`/client/requests/${id}/comments`, { body }),
      approveQuote: (id: string) => post<RequestView>(`/client/requests/${id}/approve-quote`),
      declineQuote: (id: string, reason?: string) => post<RequestView>(`/client/requests/${id}/decline-quote`, { reason }),
      delivery: () => request<FinalDeliveryView[]>("/client/delivery"),
      signOff: (engagementId: string) => post<FinalDeliveryView[]>(`/client/engagements/${engagementId}/sign-off`),
      files: () => request<ClientFile[]>("/client/files"),
      thread: () => request<ThreadView>("/client/thread"),
      sendMessage: (body: string, attachmentIds: string[] = []) => post<ThreadView>("/client/thread/messages", { body, attachmentIds }),
      checkout: (invoiceId: string) => post<Checkout>(`/client/invoices/${invoiceId}/checkout`),
      verifyPayment: (invoiceId: string, body: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }) =>
        post<{ ok: true }>(`/client/invoices/${invoiceId}/verify`, body),
      payTest: (invoiceId: string) => post<{ ok: true }>(`/client/invoices/${invoiceId}/pay-test`),
    },

    requests: {
      list: () => request<RequestView[]>("/requests"),
      get: (id: string) => request<RequestView>(`/requests/${id}`),
      addOns: () => request<{ id: string; name: string; pricePaise: number | null; unit: string | null; isCustomQuote: boolean }[]>("/requests/add-ons"),
      decide: (id: string, input: DecideRequest) => post<RequestView>(`/requests/${id}/decide`, input),
    },

    threads: {
      list: () => request<ThreadSummary[]>("/threads"),
      get: (id: string) => request<ThreadView>(`/threads/${id}`),
      send: (id: string, body: string, internal = false, attachmentIds: string[] = []) => post<ThreadView>(`/threads/${id}/messages`, { body, internal, attachmentIds }),
    },

    notifications: {
      list: () => request<{ unread: number; items: NotificationView[] }>("/notifications"),
      read: (ids: string[] | "all") => post<{ unread: number; items: NotificationView[] }>("/notifications/read", { ids }),
    },

    tasks: {
      list: (view: "mine" | "team" = "mine") => request<TaskView[]>(`/tasks?view=${view}`),
      update: (id: string, input: UpdateTask) => patch<TaskView>(`/tasks/${id}`, input),
    },

    myDay: {
      get: () => request<MyDayView>("/my-day"),
      checkIn: () => post<MyDayView>("/my-day/check-in"),
      checkOut: () => post<MyDayView>("/my-day/check-out"),
      submitEod: (input: EodInput) => request<MyDayView>("/my-day/eod", { method: "PUT", body: JSON.stringify(input) }),
    },

    deliverables: {
      get: (id: string) => request<DeliverableDetail>(`/deliverables/${id}`),
      uploadVersion: (id: string, file: Blob, note?: string) => {
        const form = new FormData();
        form.append("file", file);
        if (note) form.append("note", note);
        return request<DeliverableDetail>(`/deliverables/${id}/versions`, { method: "POST", body: form });
      },
      addLinkVersion: (id: string, url: string, note?: string) => post<DeliverableDetail>(`/deliverables/${id}/versions/link`, { url, note }),
      comment: (id: string, input: ReviewCommentInput & { versionId: string }) => post<DeliverableDetail>(`/deliverables/${id}/comments`, input),
      submitQc: (versionId: string, input: QcSubmit) => post<DeliverableDetail>(`/deliverables/versions/${versionId}/qc`, input),
      send: (versionId: string) => post<DeliverableDetail>(`/deliverables/versions/${versionId}/send`),
    },

    qc: {
      queue: () => request<QcQueueItem[]>("/qc/queue"),
    },

    templates: {
      flows: () => request<FlowTemplateView[]>("/templates/flows"),
      saveFlow: (key: string, input: FlowTemplateInput) => request<FlowTemplateView[]>(`/templates/flows/${key}`, { method: "PUT", body: JSON.stringify(input) }),
      qc: () => request<QcTemplateView[]>("/templates/qc"),
      saveQc: (key: string, input: { name: string; items: string[] }) => request<QcTemplateView[]>(`/templates/qc/${key}`, { method: "PUT", body: JSON.stringify(input) }),
    },

    clients: {
      list: () => request<ClientRow[]>("/clients"),
      get: (id: string) => request<ClientRow>(`/clients/${id}`),
    },

    engagements: {
      list: () => request<EngagementRow[]>("/engagements"),
      get: (id: string) => request<EngagementDetail>(`/engagements/${id}`),
      updateRequirement: (itemId: string, input: { status: string; blockedReason?: string; waitingFor?: string }) =>
        patch<EngagementDetail>(`/engagements/requirements/${itemId}`, input),
      addRequirement: (id: string, label: string, type: string) => post<EngagementDetail>(`/engagements/${id}/requirements`, { label, type }),
      markRcd: (id: string) => post<EngagementDetail>(`/engagements/${id}/rcd`),
      savePlan: (id: string, content: PlanContent) => request<EngagementDetail>(`/engagements/${id}/plan`, { method: "PUT", body: JSON.stringify(content) }),
      submitPlan: (id: string) => post<EngagementDetail>(`/engagements/${id}/plan/submit`),
      sendPlan: (id: string) => post<EngagementDetail>(`/engagements/${id}/plan/send`),
    },
  };
}

export type CatalogueAdmin = {
  priceBook: { id: string; version: string; status: string };
  services: (ServiceSummary & { excludedNote: string | null })[];
  bundles: { key: string; name: string; serviceKeys: string[]; discountPct: number }[];
  addOns: { id: string; name: string; pricePaise: number | null; unit: string | null; isCustomQuote: boolean }[];
};

export type ApiClient = ReturnType<typeof createApiClient>;
