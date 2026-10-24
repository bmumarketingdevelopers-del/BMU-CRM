import type { Transport } from "./transport.js";
import type { Me } from "../auth.js";
import type {
  AuditChainView,
  DataRequestView,
  DpdpOverview,
  FieldAccessView,
  SecondFactorChallenge,
  SecurityOverview,
  SessionView,
  TotpSetup,
  ViewAsView,
} from "../security-types.js";
import type { GoalInput, GoalView, IntelligenceOverview, MetricAlertEventView, MetricAlertInput, MetricAlertView, MetricUnit, MetricValueView, ScheduledReportInput, ScheduledReportView } from "../metrics/index.js";
import type { QuickActionInput, SyncOpInput, SyncOpResult, SyncPullView } from "../sync/index.js";

const qs = (params: Record<string, string | undefined>) => {
  const s = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => !!e[1])).toString();
  return s ? `?${s}` : "";
};

export type SignInResult = { token: string; me: Me } | SecondFactorChallenge;
export const needsSecondFactor = (r: SignInResult): r is SecondFactorChallenge => "needsSecondFactor" in r && r.needsSecondFactor === true;

/** v20: sign-in second step, passkeys, sessions, field access, privacy (DPDP), intelligence, offline sync and push. */
export const v20Api = (t: Transport) => ({
  signIn: {
    verify: (identifier: string, code: string) => t.post<SignInResult>("/auth/otp/verify", { identifier, code }),
    secondFactor: (challenge: string, code: string) => t.post<{ token: string; me: Me }>("/auth/2fa", { challenge, code }),
    passkeyOptions: () => t.post<{ options: Record<string, unknown>; token: string }>("/auth/passkey/options"),
    passkey: (token: string, response: unknown, challenge?: string) => t.post<{ token: string; me: Me }>("/auth/passkey/verify", { token, response, challenge }),
  },
  security: {
    me: () => t.get<SecurityOverview>("/security/me"),
    totpSetup: () => t.post<TotpSetup>("/security/totp/setup"),
    totpEnable: (code: string) => t.post<{ recoveryCodes: string[] }>("/security/totp/enable", { code }),
    totpDisable: (code: string) => t.post<{ ok: true }>("/security/totp/disable", { code }),
    passkeyOptions: () => t.post<{ options: Record<string, unknown>; token: string }>("/security/passkeys/options"),
    addPasskey: (token: string, response: unknown, name: string) => t.post<SecurityOverview["passkeys"][number]>("/security/passkeys", { token, response, name }),
    removePasskey: (id: string) => t.del<{ ok: true }>(`/security/passkeys/${id}`),
    /** v42: untie "Continue with Google" from the Google account it was first used with. */
    unlinkGoogle: () => t.del<SecurityOverview>("/security/google"),
    sessions: () => t.get<SessionView[]>("/security/sessions"),
    revokeSession: (id: string) => t.del<{ ok: true }>(`/security/sessions/${id}`),
    signOutOthers: () => t.post<{ signedOut: number }>("/security/sessions/sign-out-others"),
    signOutUser: (userId: string) => t.post<{ signedOut: number }>(`/security/users/${userId}/sign-out`),
  },
  securityAdmin: {
    fields: () => t.get<FieldAccessView>("/security-admin/fields"),
    saveFields: (fields: Record<string, Record<string, "edit" | "read" | "hidden">>) => t.put<FieldAccessView>("/security-admin/fields", { fields }),
    viewAs: (userId: string) => t.get<ViewAsView>(`/security-admin/view-as/${userId}`),
    auditChain: (fromSeq?: number) => t.get<AuditChainView>(`/security-admin/audit-chain${qs({ fromSeq: fromSeq ? String(fromSeq) : undefined })}`),
    privacy: () => t.get<DpdpOverview>("/security-admin/privacy"),
    createRequest: (body: { kind: string; requesterName: string; requesterEmail: string; details?: string }) => t.post<DataRequestView>("/security-admin/privacy/requests", body),
    updateRequest: (id: string, body: Partial<{ status: string; assigneeId: string | null; resolution: string; subjectType: string; subjectId: string | null }>) => t.patch<DataRequestView>(`/security-admin/privacy/requests/${id}`, body),
    exportSubject: (type: "lead" | "user", id: string) => t.get<Record<string, unknown>>(`/security-admin/privacy/export/${type}/${id}`),
    eraseLead: (id: string) => t.post<{ ok: true }>(`/security-admin/privacy/erase-lead/${id}`),
    withdrawConsent: (id: string) => t.post<{ ok: true }>(`/security-admin/privacy/consents/${id}/withdraw`),
    saveRetention: (rules: { recordType: string; keepDays: number; action: "anonymise" | "delete"; enabled: boolean }[]) => t.put<DpdpOverview["retention"]>("/security-admin/privacy/retention", { rules }),
    runRetention: () => t.post<{ ran: Record<string, number> }>("/security-admin/privacy/retention/run"),
  },
  publicPrivacy: {
    request: (body: { kind: string; requesterName: string; requesterEmail: string; details?: string }) => t.post<{ id: string; dueAt: string }>("/public/privacy/requests", body),
    withdraw: (email: string, purpose: string) => t.post<{ withdrawn: number }>("/public/privacy/withdraw", { email, purpose }),
  },
  intelligence: {
    overview: () => t.get<IntelligenceOverview>("/intelligence/overview"),
    refresh: () => t.post<{ refreshed: Record<string, number> }>("/intelligence/refresh"),
    metrics: (from?: string, to?: string) => t.get<MetricValueView[]>(`/intelligence/metrics${qs({ from, to })}`),
    metric: (key: string, q: { from?: string; to?: string; clientOrgId?: string } = {}) => t.get<MetricValueView>(`/intelligence/metrics/${key}${qs(q)}`),
    alerts: () => t.get<{ alerts: MetricAlertView[]; events: MetricAlertEventView[]; canEdit: boolean }>("/intelligence/alerts"),
    createAlert: (body: MetricAlertInput) => t.post<MetricAlertView>("/intelligence/alerts", body),
    updateAlert: (id: string, body: Partial<MetricAlertInput>) => t.patch<MetricAlertView>(`/intelligence/alerts/${id}`, body),
    removeAlert: (id: string) => t.del<{ ok: true }>(`/intelligence/alerts/${id}`),
    checkAlerts: () => t.post<{ fired: MetricAlertEventView[] }>("/intelligence/alerts/check"),
    reports: () => t.get<{ reports: ScheduledReportView[]; metrics: { key: string; label: string; unit: MetricUnit }[]; dashboards: { id: string; name: string }[] }>("/intelligence/reports"),
    createReport: (body: ScheduledReportInput) => t.post<ScheduledReportView>("/intelligence/reports", body),
    updateReport: (id: string, body: Partial<ScheduledReportInput>) => t.patch<ScheduledReportView>(`/intelligence/reports/${id}`, body),
    removeReport: (id: string) => t.del<{ ok: true }>(`/intelligence/reports/${id}`),
    sendReport: (id: string) => t.post<{ sent: number; error?: string }>(`/intelligence/reports/${id}/send`),
    goals: (archived = false) => t.get<{ goals: GoalView[]; canCreateCompany: boolean }>(`/intelligence/goals${archived ? "?archived=1" : ""}`),
    createGoal: (body: GoalInput) => t.post<GoalView>("/intelligence/goals", body),
    goal: (id: string) => t.get<GoalView>(`/intelligence/goals/${id}`),
    updateGoal: (id: string, body: Partial<GoalInput> & { archived?: boolean }) => t.patch<GoalView>(`/intelligence/goals/${id}`, body),
    checkIn: (id: string, value: number, note?: string) => t.post<GoalView>(`/intelligence/goals/${id}/check-ins`, { value, note }),
  },
  sync: {
    push: (ops: SyncOpInput[]) => t.post<{ results: SyncOpResult[] }>("/sync/push", { ops }),
    pull: (since?: string) => t.get<SyncPullView>(`/sync/pull${qs({ since })}`),
  },
  devices: {
    registerPush: (token: string, platform: "ios" | "android" | "web") => t.post<{ ok: true }>("/devices/push-token", { token, platform }),
    unregisterPush: (token: string) => t.del<{ ok: true }>(`/devices/push-token/${encodeURIComponent(token)}`),
    quickAction: (body: QuickActionInput) => t.post<{ ok: true; message: string }>("/devices/quick-action", body),
  },
});
