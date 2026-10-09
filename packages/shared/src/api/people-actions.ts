import type { Transport } from "./transport.js";
import type {
  PeopleAddPerson,
  PeopleBulk,
  PeopleChangeRole,
  PeopleCreateUnit,
  PeopleCustomRole,
  PeopleDuplicate,
  PeopleEditPerson,
  PeopleMove,
  PeopleMovePreview,
  PeopleMutationResult,
  PeopleOffboard,
  PeopleOffboardingStatus,
  PeopleOptions,
  PeoplePersonDetail,
  PeoplePersonRow,
  PeoplePod,
  PeoplePodInput,
  PeopleRolePreview,
  PeopleTree,
} from "../people-actions.js";

const pqs = (params: Record<string, string | undefined>) => {
  const p = Object.entries(params).filter(([, v]) => v);
  return p.length ? `?${p.map(([k, v]) => `${k}=${encodeURIComponent(v!)}`).join("&")}` : "";
};

/** v11 people & hierarchy actions. */
export const peopleActionsApi = (t: Transport) => ({
  peopleActions: {
    options: () => t.get<PeopleOptions>("/people-actions/options"),
    tree: () => t.get<PeopleTree>("/people-actions/tree"),
    list: (f: { q?: string; departmentId?: string; roleId?: string; status?: string; branchId?: string; employmentType?: string; former?: string } = {}) => t.get<PeoplePersonRow[]>(`/people-actions/people${pqs(f)}`),
    get: (id: string) => t.get<PeoplePersonDetail>(`/people-actions/people/${id}`),
    duplicates: (input: { email?: string; phone?: string; name?: string }) => t.post<PeopleDuplicate[]>("/people-actions/people/duplicates", input),
    add: (input: PeopleAddPerson) => t.post<PeopleMutationResult>("/people-actions/people", input),
    edit: (id: string, input: PeopleEditPerson) => t.patch<PeopleMutationResult>(`/people-actions/people/${id}`, input),
    resendInvite: (id: string) => t.post<PeopleMutationResult>(`/people-actions/people/${id}/invite`),
    movePreview: (id: string, input: PeopleMove) => t.post<PeopleMovePreview>(`/people-actions/people/${id}/move/preview`, input),
    move: (id: string, input: PeopleMove) => t.post<PeopleMutationResult>(`/people-actions/people/${id}/move`, input),
    rolePreview: (id: string, input: PeopleChangeRole) => t.post<PeopleRolePreview>(`/people-actions/people/${id}/role/preview`, input),
    changeRole: (id: string, input: PeopleChangeRole) => t.post<PeopleMutationResult>(`/people-actions/people/${id}/role`, input),
    cancelScheduled: (changeId: string) => t.post<PeopleMutationResult>(`/people-actions/scheduled/${changeId}/cancel`),
    offboarding: (id: string) => t.get<PeopleOffboardingStatus>(`/people-actions/people/${id}/offboarding`),
    offboard: (id: string, input: PeopleOffboard) => t.post<PeopleOffboardingStatus>(`/people-actions/people/${id}/offboard`, input),
    handover: (id: string, input: { kind: "approvals" | "briefs"; toUserId: string }) => t.post<PeopleOffboardingStatus>(`/people-actions/people/${id}/handover`, input),
    confirmOffboarding: (id: string) => t.post<PeopleMutationResult>(`/people-actions/people/${id}/offboard/confirm`),
    createUnit: (input: PeopleCreateUnit) => t.post<PeopleMutationResult>("/people-actions/units", input),
    pods: () => t.get<PeoplePod[]>("/people-actions/pods"),
    createPod: (input: PeoplePodInput) => t.post<PeopleMutationResult>("/people-actions/pods", input),
    updatePod: (id: string, input: Partial<PeoplePodInput>) => t.patch<PeopleMutationResult>(`/people-actions/pods/${id}`, input),
    removePod: (id: string) => t.del<PeopleMutationResult>(`/people-actions/pods/${id}`),
    customRole: (input: PeopleCustomRole) => t.post<PeopleMutationResult>("/people-actions/roles", input),
    bulk: (input: PeopleBulk) => t.post<PeopleMutationResult & { applied: number; failed: { id: string; name: string; error: string }[] }>("/people-actions/bulk", input),
    runJobs: () => t.post<{ applied: number; suspended: number }>("/people-actions/jobs/run"),
  },
});
