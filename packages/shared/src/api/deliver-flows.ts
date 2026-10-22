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
  HandoffAssignInput,
  HandoffDeliverable,
  HandoffInbox,
  HandoffOptions,
  HandoffSendInput,
  ProjectHandoffView,
  ClientProgressView,
  EstimateInboxRow,
  EstimateRequestInput,
  EstimateSubmitInput,
  MilestoneCreateInput,
  MilestoneDecisionInput,
  ProjectFlowView,
  ProjectTaskAssignInput,
  ProjectTaskCreateInput,
} from "../deliver-flows.js";
import type { SentFile, SentLink } from "../ops-actions.js";
import type { ClientOnboarding } from "../delivery.js";

export * from "../deliver-flows.js";

const range = (from: string, to: string) => `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;

/** v10 deliver area: retainer cycles, content calendar, approval rules, delivery SLA, handover pack. */
export const deliverFlowsApi = (t: Transport) => ({
  /** v37 manual hand-off: the Client Manager sends work to Department Heads, who pick their people. */
  handoff: {
    project: (engagementId: string) => t.get<ProjectHandoffView>(`/handoff/projects/${engagementId}`),
    send: (engagementId: string, body: HandoffSendInput) => t.post<ProjectHandoffView>(`/handoff/projects/${engagementId}/send`, body),
    inbox: () => t.get<HandoffInbox>("/handoff/inbox"),
    options: (deliverableId: string) => t.get<HandoffOptions>(`/handoff/deliverables/${deliverableId}/options`),
    assign: (deliverableId: string, body: HandoffAssignInput) => t.post<HandoffDeliverable>(`/handoff/deliverables/${deliverableId}/assign`, body),
  },
  /** v40 project flow: finish dates from Department Heads, and finished parts the client approves. */
  projectFlow: {
    get: (engagementId: string) => t.get<ProjectFlowView>(`/project-flow/projects/${engagementId}`),
    requestEstimates: (engagementId: string, body: EstimateRequestInput) => t.post<ProjectFlowView>(`/project-flow/projects/${engagementId}/estimates`, body),
    submitEstimate: (id: string, body: EstimateSubmitInput) => t.post<ProjectFlowView>(`/project-flow/estimates/${id}`, body),
    shareEstimates: (engagementId: string, ids: string[]) => t.post<ProjectFlowView>(`/project-flow/projects/${engagementId}/estimates/share`, { ids }),
    inbox: () => t.get<EstimateInboxRow[]>("/project-flow/inbox"),
    stageFile: (engagementId: string, file: Blob) => {
      const form = new FormData();
      form.append("file", file);
      return t.request<SentFile>(`/project-flow/projects/${engagementId}/milestone-files`, { method: "POST", body: form });
    },
    stageLink: (engagementId: string, body: SentLink) => t.post<SentFile>(`/project-flow/projects/${engagementId}/milestone-links`, body),
    /** v41: requirement documents to send with a request to Department Heads. */
    stageBriefFile: (engagementId: string, file: Blob) => {
      const form = new FormData();
      form.append("file", file);
      return t.request<SentFile>(`/project-flow/projects/${engagementId}/brief-files`, { method: "POST", body: form });
    },
    stageBriefLink: (engagementId: string, body: SentLink) => t.post<SentFile>(`/project-flow/projects/${engagementId}/brief-links`, body),
    /** v41: the Department Head adds a task for their team, or gives an existing one a person and hours. */
    addTask: (engagementId: string, body: ProjectTaskCreateInput) => t.post<ProjectFlowView>(`/project-flow/projects/${engagementId}/tasks`, body),
    assignTask: (taskId: string, body: ProjectTaskAssignInput) => t.post<ProjectFlowView>(`/project-flow/tasks/${taskId}/assign`, body),
    shareMilestone: (engagementId: string, body: MilestoneCreateInput) => t.post<ProjectFlowView>(`/project-flow/projects/${engagementId}/milestones`, body),
    clientProgress: () => t.get<ClientProgressView>("/project-flow/client/progress"),
    decide: (milestoneId: string, body: MilestoneDecisionInput) => t.post<ClientProgressView>(`/project-flow/client/milestones/${milestoneId}/decision`, body),
  },
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
