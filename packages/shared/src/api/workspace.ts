import type { Transport } from "./transport.js";
import type {
  BriefDetail,
  BriefOptions,
  BriefRow,
  CalendarView,
  TeamCapacityView,
  Client360,
  ClientReport,
  ClientTeamView,
  CreateBrief,
  CreatorPayouts,
  CreatorProfile,
  CreatorRow,
  InviteClientUser,
  LeaveRequestInput,
  MyProfile,
  SopDetail,
  SopRow,
  UpdateClientUser,
  UpdateCreatorProfile,
  UpdateMe,
} from "../workspace-types.js";

export * from "../workspace-types.js";

const upload = <T>(t: Transport, path: string, file: Blob, note?: string) => {
  const form = new FormData();
  form.append("file", file);
  if (note) form.append("note", note);
  return t.request<T>(path, { method: "POST", body: form });
};

/** Workspace: Client 360, calendar, capacity, SOPs, profile & leave, creators, client reports and team users. */
export const workspaceApi = (t: Transport) => ({
  workspace: {
    client360: (id: string) => t.get<Client360>(`/workspace/clients/${id}`),
    calendar: (month: string, view: "mine" | "team") => t.get<CalendarView>(`/workspace/calendar?month=${month}&view=${view}`),
    capacity: () => t.get<TeamCapacityView>("/workspace/capacity"),
    sops: () => t.get<SopRow[]>("/workspace/sops"),
    sop: (id: string) => t.get<SopDetail>(`/workspace/sops/${id}`),
    profile: () => t.get<MyProfile>("/workspace/profile"),
    updateMe: (input: UpdateMe) => t.patch<{ ok: true }>("/workspace/me", input),
    applyLeave: (input: LeaveRequestInput) => t.post<MyProfile>("/workspace/leave", input),
    cancelLeave: (id: string) => t.post<MyProfile>(`/workspace/leave/${id}/cancel`),
  },
  creatorAdmin: {
    creators: () => t.get<CreatorRow[]>("/workspace/creators"),
    options: () => t.get<BriefOptions>("/workspace/briefs/options"),
    briefs: () => t.get<BriefRow[]>("/workspace/briefs"),
    brief: (id: string) => t.get<BriefDetail>(`/workspace/briefs/${id}`),
    createBrief: (input: CreateBrief) => t.post<BriefDetail>("/workspace/briefs", input),
    feedback: (id: string, feedback: string) => t.post<BriefDetail>(`/workspace/briefs/${id}/feedback`, { feedback }),
    approve: (id: string) => t.post<BriefDetail>(`/workspace/briefs/${id}/approve`),
    cancel: (id: string) => t.post<BriefDetail>(`/workspace/briefs/${id}/cancel`),
    uploadSubmission: (id: string, file: Blob, note?: string) => upload<BriefDetail>(t, `/workspace/briefs/${id}/submissions`, file, note),
    linkSubmission: (id: string, url: string, note?: string) => t.post<BriefDetail>(`/workspace/briefs/${id}/submissions/link`, { url, note }),
  },
  creator: {
    briefs: () => t.get<BriefRow[]>("/workspace/creator/briefs"),
    brief: (id: string) => t.get<BriefDetail>(`/workspace/creator/briefs/${id}`),
    accept: (id: string) => t.post<BriefDetail>(`/workspace/creator/briefs/${id}/accept`),
    decline: (id: string) => t.post<BriefDetail>(`/workspace/creator/briefs/${id}/decline`),
    uploadSubmission: (id: string, file: Blob, note?: string) => upload<BriefDetail>(t, `/workspace/creator/briefs/${id}/submissions`, file, note),
    linkSubmission: (id: string, url: string, note?: string) => t.post<BriefDetail>(`/workspace/creator/briefs/${id}/submissions/link`, { url, note }),
    payouts: () => t.get<CreatorPayouts>("/workspace/creator/payouts"),
    profile: () => t.get<CreatorProfile>("/workspace/creator/profile"),
    saveProfile: (input: UpdateCreatorProfile) => t.put<CreatorProfile>("/workspace/creator/profile", input),
  },
  clientWorkspace: {
    report: (month: string) => t.get<ClientReport>(`/workspace/client/report?month=${month}`),
    team: () => t.get<ClientTeamView>("/workspace/client/team"),
    invite: (input: InviteClientUser) => t.post<ClientTeamView>("/workspace/client/team", input),
    updateMember: (userId: string, input: UpdateClientUser) => t.patch<ClientTeamView>(`/workspace/client/team/${userId}`, input),
  },
});
