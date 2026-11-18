import type { Transport } from "./transport.js";
import type { HrIssueInput, HrIssueSetup, HrIssueStatus, HrIssueUpdate, HrIssueView } from "../hr-issues.js";
import type { TeamEodView } from "../production.js";

/** v50: Raise an issue with HR, and Daily reports (end-of-day reports from the people someone oversees). */
export const hrIssuesApi = (t: Transport) => ({
  hrIssues: {
    raise: (body: HrIssueInput) => t.post<HrIssueView>("/hr-issues", body),
    mine: () => t.get<HrIssueView[]>("/hr-issues/mine"),
    /** Who my issues go to (HR, or leadership for HR people) and which issues I answer. */
    setup: () => t.get<HrIssueSetup>("/hr-issues/setup"),
    /** HR: issues raised with HR. Branch Manager / Founder: issues raised by HR. */
    inbox: (status?: HrIssueStatus | "all") => t.get<HrIssueView[]>(`/hr-issues${status ? `?status=${status}` : ""}`),
    update: (id: string, body: HrIssueUpdate) => t.patch<HrIssueView>(`/hr-issues/${id}`, body),
  },
  dailyReports: {
    /** One day (YYYY-MM-DD, default today) of end-of-day reports from the people I oversee. */
    team: (date?: string) => t.get<TeamEodView>(`/my-day/eod/team${date ? `?date=${date}` : ""}`),
  },
});
