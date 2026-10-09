import type { SettingsSection, SettingsValue } from "../settings.js";
import type { SettingsView } from "./settings.js";
import type {
  AdminPlatformAccess,
  ClientDataExport,
  DataOverview,
  ErrorLogInput,
  ErrorLogList,
  ErrorLogView,
  IntegrationStatus,
  SopInput,
  SopMeta,
  SopView,
  TenantInfo,
} from "../admin-platform-types.js";
import type { Transport } from "./transport.js";

export * from "../admin-platform-types.js";

/** Settings sections saved through the Command Centre's Operations/Platform pages (stricter role checks). */
export type AdminPlatformSection = Extract<SettingsSection, "requirementChecklists" | "sla" | "gateRules" | "notificationTemplates" | "branding" | "tenant">;

const qs = (p: Record<string, string | undefined>) => {
  const s = new URLSearchParams(Object.entries(p).filter((e): e is [string, string] => !!e[1])).toString();
  return s ? `?${s}` : "";
};

export const adminPlatformApi = (t: Transport) => ({
  adminPlatform: {
    access: () => t.get<AdminPlatformAccess>("/admin-platform/access"),
    saveSetting: <S extends AdminPlatformSection>(section: S, value: SettingsValue<S>) => t.put<SettingsView>(`/admin-platform/settings/${section}`, value),

    // SOP library (any team member can read)
    sops: (filter: { q?: string; departmentId?: string } = {}) => t.get<SopView[]>(`/admin-platform/sops${qs(filter)}`),
    sop: (id: string) => t.get<SopView>(`/admin-platform/sops/${id}`),
    sopMeta: () => t.get<SopMeta>("/admin-platform/sops/meta"),
    createSop: (input: SopInput) => t.post<SopView>("/admin-platform/sops", input),
    updateSop: (id: string, input: SopInput) => t.put<SopView>(`/admin-platform/sops/${id}`, input),
    setSopStatus: (id: string, status: "draft" | "published") => t.post<SopView>(`/admin-platform/sops/${id}/status`, { status }),

    // Error log
    errors: (filter: { q?: string; cause?: string } = {}) => t.get<ErrorLogList>(`/admin-platform/errors${qs(filter)}`),
    createError: (input: ErrorLogInput) => t.post<ErrorLogView>("/admin-platform/errors", input),
    updateError: (id: string, input: ErrorLogInput) => t.put<ErrorLogView>(`/admin-platform/errors/${id}`, input),

    // Platform
    integrations: () => t.get<IntegrationStatus[]>("/admin-platform/integrations"),
    tenant: () => t.get<TenantInfo>("/admin-platform/tenant"),
    dataClients: () => t.get<DataOverview>("/admin-platform/data/clients"),
    exportClient: (id: string) => t.get<ClientDataExport>(`/admin-platform/data/clients/${id}/export`),
    anonymiseClient: (id: string, confirmName: string) => t.post<{ anonymised: number }>(`/admin-platform/data/clients/${id}/anonymise`, { confirmName }),
  },
});
