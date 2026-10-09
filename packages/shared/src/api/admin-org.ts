import type { Transport } from "./transport.js";
import type {
  AdminEngagementRow,
  AmWorkloadView,
  AttendanceView,
  BranchInput,
  DecideLeave,
  DepartmentInput,
  DepartmentUpdate,
  DiscountApprovalRow,
  EngagementLifecycle,
  LeaveRow,
  MoveMember,
  OffboardingCheckKey,
  OffboardingRow,
  OrgStructureView,
  TeamInput,
  TeamUpdate,
} from "../admin-org-types.js";

export * from "../admin-org-types.js";

/** Command Centre: organisation, clients and catalogue admin. */
export const adminOrgApi = (t: Transport) => ({
  adminOrg: {
    structure: () => t.get<OrgStructureView>("/admin-org/structure"),
    createBranch: (input: BranchInput) => t.post<OrgStructureView>("/admin-org/branches", input),
    updateBranch: (id: string, input: Partial<BranchInput>) => t.patch<OrgStructureView>(`/admin-org/branches/${id}`, input),
    createDepartment: (input: DepartmentInput) => t.post<OrgStructureView>("/admin-org/departments", input),
    updateDepartment: (id: string, input: DepartmentUpdate) => t.patch<OrgStructureView>(`/admin-org/departments/${id}`, input),
    deleteDepartment: (id: string) => t.del<OrgStructureView>(`/admin-org/departments/${id}`),
    createTeam: (input: TeamInput) => t.post<OrgStructureView>("/admin-org/teams", input),
    updateTeam: (id: string, input: TeamUpdate) => t.patch<OrgStructureView>(`/admin-org/teams/${id}`, input),
    deleteTeam: (id: string) => t.del<OrgStructureView>(`/admin-org/teams/${id}`),
    moveMember: (input: MoveMember) => t.post<OrgStructureView>("/admin-org/members/move", input),

    attendance: (month?: string) => t.get<AttendanceView>(`/admin-org/attendance${month ? `?month=${month}` : ""}`),
    leave: () => t.get<LeaveRow[]>("/admin-org/leave"),
    decideLeave: (id: string, input: DecideLeave) => t.post<LeaveRow>(`/admin-org/leave/${id}/decide`, input),

    engagements: () => t.get<AdminEngagementRow[]>("/admin-org/engagements"),
    amWorkload: () => t.get<AmWorkloadView>("/admin-org/am-workload"),
    reassignAm: (clientOrgId: string, amUserId: string) => t.post<AmWorkloadView>(`/admin-org/clients/${clientOrgId}/am`, { amUserId }),
    offboarding: () => t.get<OffboardingRow[]>("/admin-org/offboarding"),
    lifecycle: (engagementId: string, input: EngagementLifecycle) => t.post<OffboardingRow>(`/admin-org/engagements/${engagementId}/lifecycle`, input),
    tickOffboarding: (engagementId: string, key: OffboardingCheckKey, done: boolean) =>
      t.post<OffboardingRow>(`/admin-org/engagements/${engagementId}/offboarding-checklist`, { key, done }),

    discountApprovals: () => t.get<DiscountApprovalRow[]>("/admin-org/discount-approvals"),
  },
});
