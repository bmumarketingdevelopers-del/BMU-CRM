import type { Transport } from "./transport.js";
import type {
  BookingPageInput,
  BookingPageView,
  BookingSlots,
  DocCreate,
  DocDetail,
  DocRow,
  DocUpdate,
  InboxDetail,
  InboxList,
  InboxQuery,
  InboxReply,
  InboxSimulate,
  InboxUpdate,
  MeetingCreate,
  MeetingList,
  MeetingNotesInput,
  MeetingView,
  PublicBooking,
  ReplyTemplateInput,
  ReplyTemplateView,
} from "../comms-types.js";

export * from "../comms-types.js";

const qs = (params: Record<string, string | undefined>) => {
  const s = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => !!e[1])).toString();
  return s ? `?${s}` : "";
};

/** v17: shared inbox, reply templates, collaborative documents, booking pages and meetings. */
export const commsApi = (t: Transport) => ({
  inbox: {
    list: (q: InboxQuery = {}) => t.get<InboxList>(`/inbox${qs(q)}`),
    get: (id: string) => t.get<InboxDetail>(`/inbox/${id}`),
    reply: (id: string, body: InboxReply) => t.post<InboxDetail>(`/inbox/${id}/reply`, body),
    update: (id: string, body: InboxUpdate) => t.patch<InboxDetail>(`/inbox/${id}`, body),
    draft: (id: string) => t.post<{ body: string; basic: boolean }>(`/inbox/${id}/draft`),
    simulate: (body: InboxSimulate) => t.post<InboxDetail>("/inbox/simulate", body),
    templates: () => t.get<ReplyTemplateView[]>("/inbox/templates"),
    saveTemplate: (body: ReplyTemplateInput, id?: string) => (id ? t.put<ReplyTemplateView>(`/inbox/templates/${id}`, body) : t.post<ReplyTemplateView>("/inbox/templates", body)),
    deleteTemplate: (id: string) => t.del<{ ok: true }>(`/inbox/templates/${id}`),
  },
  docs: {
    list: (q: { engagementId?: string; leadId?: string; clientOrgId?: string } = {}) => t.get<DocRow[]>(`/docs${qs(q)}`),
    create: (body: DocCreate) => t.post<DocDetail>("/docs", body),
    get: (id: string) => t.get<DocDetail>(`/docs/${id}`),
    update: (id: string, body: DocUpdate) => t.patch<DocDetail>(`/docs/${id}`, body),
    /** Sends one editing step; returns what this tab is missing, given its state vector. */
    edit: (id: string, update: string, sv: string) => t.post<{ update: string; version: number }>(`/docs/${id}/edit`, { update, sv }),
    pull: (id: string, sv: string) => t.post<{ update: string; version: number }>(`/docs/${id}/pull`, { sv }),
    clientList: () => t.get<DocRow[]>("/client/docs"),
  },
  meetings: {
    list: () => t.get<MeetingList>("/meetings"),
    get: (id: string) => t.get<MeetingView>(`/meetings/${id}`),
    create: (body: MeetingCreate) => t.post<MeetingView>("/meetings", body),
    saveNotes: (id: string, body: MeetingNotesInput) => t.patch<MeetingView>(`/meetings/${id}`, body),
    summarise: (id: string) => t.post<{ summary: string; actionItems: string[]; basic: boolean }>(`/meetings/${id}/summarise`),
    createTasks: (id: string, items: number[], engagementId?: string | null) => t.post<MeetingView>(`/meetings/${id}/tasks`, { items, engagementId }),
    cancel: (id: string) => t.post<MeetingView>(`/meetings/${id}/cancel`),
    bookingPage: () => t.get<BookingPageView>("/meetings/booking-page"),
    saveBookingPage: (body: BookingPageInput) => t.put<BookingPageView>("/meetings/booking-page", body),
    clientList: () => t.get<MeetingList & { am: { name: string } | null }>("/client/meetings"),
    clientSlots: () => t.get<BookingSlots>("/client/meetings/slots"),
    clientBook: (startAt: string, agenda?: string) => t.post<MeetingView>("/client/meetings", { startAt, agenda }),
    clientCancel: (id: string) => t.post<MeetingView>(`/client/meetings/${id}/cancel`),
    publicSlots: (slug: string) => t.get<BookingSlots>(`/public/book/${slug}`),
    publicBook: (slug: string, body: PublicBooking) => t.post<{ ok: true; startAt: string; host: string }>(`/public/book/${slug}`, body),
  },
});
