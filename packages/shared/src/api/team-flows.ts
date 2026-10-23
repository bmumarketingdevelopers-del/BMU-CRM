import type { Transport } from "./transport.js";
import type {
  TeamActivityEntity,
  TeamActivityFeed,
  TeamDecideTimesheet,
  TeamLeaveCover,
  TeamPeopleOptions,
  TeamPeopleProcess,
  TeamReassign,
  TeamSearchResult,
  TeamStartOffboarding,
  TeamStartOnboarding,
  TeamTimeEntryInput,
  TeamTimesheet,
  TeamTimesheetRow,
  TeamWhoIsOut,
  TeamBranding,
} from "../team-flows.js";

const qs = (params: Record<string, string | undefined>) => {
  const p = Object.entries(params).filter(([, v]) => v);
  return p.length ? `?${p.map(([k, v]) => `${k}=${encodeURIComponent(v!)}`).join("&")}` : "";
};

/** v10 team flows: onboarding/offboarding, timesheets, leave cover, search, activity. */
export const teamFlowsApi = (t: Transport) => ({
  teamFlows: {
    people: {
      list: (kind?: "onboarding" | "offboarding") => t.get<TeamPeopleProcess[]>(`/team-flows/people${qs({ kind })}`),
      /** Onboarding history: every onboarding the signed-in person is part of. */
      involved: () => t.get<TeamPeopleProcess[]>("/team-flows/people/involved"),
      options: () => t.get<TeamPeopleOptions>("/team-flows/people/options"),
      get: (id: string) => t.get<TeamPeopleProcess>(`/team-flows/people/${id}`),
      mine: () => t.get<TeamPeopleProcess[]>("/team-flows/people/mine"),
      startOnboarding: (input: TeamStartOnboarding) => t.post<TeamPeopleProcess>("/team-flows/people/onboarding", input),
      startOffboarding: (input: TeamStartOffboarding) => t.post<TeamPeopleProcess>("/team-flows/people/offboarding", input),
      tick: (id: string, key: string, done: boolean) => t.post<TeamPeopleProcess>(`/team-flows/people/${id}/tick`, { key, done }),
      addItem: (id: string, label: string, group: string) => t.post<TeamPeopleProcess>(`/team-flows/people/${id}/items`, { label, group }),
      reassign: (id: string, input: TeamReassign) => t.post<TeamPeopleProcess>(`/team-flows/people/${id}/reassign`, input),
      complete: (id: string) => t.post<TeamPeopleProcess>(`/team-flows/people/${id}/complete`),
      cancel: (id: string) => t.post<TeamPeopleProcess>(`/team-flows/people/${id}/cancel`),
      acknowledgeSop: (sopId: string) => t.post<{ ok: true; version: number }>(`/team-flows/sops/${sopId}/acknowledge`),
    },
    timesheets: {
      week: (weekStart?: string, userId?: string) => t.get<TeamTimesheet>(`/team-flows/timesheets/week${qs({ week: weekStart, userId })}`),
      addEntry: (input: TeamTimeEntryInput) => t.post<TeamTimesheet>("/team-flows/timesheets/entries", input),
      removeEntry: (id: string) => t.del<TeamTimesheet>(`/team-flows/timesheets/entries/${id}`),
      submit: (weekStart: string) => t.post<TeamTimesheet>("/team-flows/timesheets/submit", { weekStart }),
      get: (id: string) => t.get<TeamTimesheet>(`/team-flows/timesheets/${id}`),
      approvals: (status?: string) => t.get<TeamTimesheetRow[]>(`/team-flows/timesheets/approvals${qs({ status })}`),
      decide: (id: string, input: TeamDecideTimesheet) => t.post<TeamTimesheet>(`/team-flows/timesheets/${id}/decide`, input),
    },
    leave: {
      cover: (leaveId: string) => t.get<TeamLeaveCover>(`/team-flows/leave/${leaveId}/cover`),
      reassign: (leaveId: string, taskIds: string[], toUserId: string) => t.post<TeamLeaveCover>(`/team-flows/leave/${leaveId}/reassign`, { taskIds, toUserId }),
      whoIsOut: (from?: string, to?: string) => t.get<TeamWhoIsOut>(`/team-flows/leave/out${qs({ from, to })}`),
    },
    /** Client-app name, colours and support contacts (any signed-in user). */
    branding: () => t.get<TeamBranding>("/team-flows/branding"),
    search: (q: string, surface: "team" | "admin" = "team", kinds?: string) => t.get<TeamSearchResult>(`/team-flows/search${qs({ q, surface, kinds })}`),
    activity: (entity: TeamActivityEntity, id: string, opts: { actor?: string; take?: number } = {}) =>
      t.get<TeamActivityFeed>(`/team-flows/activity${qs({ entity, id, actor: opts.actor, take: opts.take ? String(opts.take) : undefined })}`),
  },
});

export type TeamFlowsApi = ReturnType<typeof teamFlowsApi>["teamFlows"];
