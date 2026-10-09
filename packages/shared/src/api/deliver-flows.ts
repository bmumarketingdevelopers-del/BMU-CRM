import type { Transport } from "./transport.js";
import type {
  DeliverApprovalMode,
  DeliverApprovalSettings,
  DeliverCalendarView,
  DeliverChannel,
  DeliverCyclesView,
  DeliverHandoverItemInput,
  DeliverHandoverView,
  DeliverRetainerRun,
  DeliverSlaView,
} from "../deliver-flows.js";
import type { ClientOnboarding } from "../delivery.js";

export * from "../deliver-flows.js";

const range = (from: string, to: string) => `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;

/** v10 deliver area: retainer cycles, content calendar, approval rules, delivery SLA, handover pack. */
export const deliverFlowsApi = (t: Transport) => ({
  deliver: {
    cycles: (engagementId: string) => t.get<DeliverCyclesView>(`/deliver/engagements/${engagementId}/cycles`),
    startNextCycle: (engagementId: string) => t.post<DeliverCyclesView>(`/deliver/engagements/${engagementId}/cycles/next`),
    runRetainers: () => t.post<DeliverRetainerRun>("/deliver/retainers/run"),

    calendar: (from: string, to: string) => t.get<DeliverCalendarView>(`/deliver/calendar${range(from, to)}`),
    clientCalendar: (from: string, to: string) => t.get<DeliverCalendarView>(`/deliver/client/calendar${range(from, to)}`),
    schedule: (deliverableId: string, scheduledAt: string, channel: DeliverChannel) =>
      t.patch<DeliverCalendarView["items"][number]>(`/deliver/deliverables/${deliverableId}/schedule`, { scheduledAt, channel }),
    unschedule: (deliverableId: string) => t.post<DeliverCalendarView["items"][number]>(`/deliver/deliverables/${deliverableId}/unschedule`),
    publish: (deliverableId: string, liveUrl: string) => t.post<DeliverCalendarView["items"][number]>(`/deliver/deliverables/${deliverableId}/publish`, { liveUrl }),

    approvalSettings: () => t.get<DeliverApprovalSettings>("/deliver/client/approval-settings"),
    saveApprovalSettings: (mode: DeliverApprovalMode) => t.put<DeliverApprovalSettings>("/deliver/client/approval-settings", { mode }),
    clientApprovalSettings: (clientOrgId: string) => t.get<DeliverApprovalSettings>(`/deliver/clients/${clientOrgId}/approval-mode`),
    setClientApprovalMode: (clientOrgId: string, mode: DeliverApprovalMode) => t.put<DeliverApprovalSettings>(`/deliver/clients/${clientOrgId}/approval-mode`, { mode }),
    remind: (target: "deliverable" | "plan", id: string) => t.post<{ reminded: string[] }>("/deliver/approvals/remind", { target, id }),

    sla: () => t.get<DeliverSlaView>("/deliver/sla"),
    runSla: () => t.post<{ escalated: number }>("/deliver/sla/run"),

    handover: (engagementId: string) => t.get<DeliverHandoverView>(`/deliver/engagements/${engagementId}/handover`),
    addHandoverItem: (engagementId: string, input: DeliverHandoverItemInput) => t.post<DeliverHandoverView>(`/deliver/engagements/${engagementId}/handover/items`, input),
    removeHandoverItem: (itemId: string) => t.del<DeliverHandoverView>(`/deliver/handover/items/${itemId}`),
    feedback: (engagementId: string, score: number, comment?: string) => t.post<DeliverHandoverView>(`/deliver/engagements/${engagementId}/feedback`, { score, comment }),

    uploadRequirement: (itemId: string, file: Blob, note?: string) => {
      const form = new FormData();
      form.append("file", file);
      if (note) form.append("note", note);
      return t.request<ClientOnboarding>(`/deliver/client/requirements/${itemId}/upload`, { method: "POST", body: form });
    },
  },
});
