import type { Transport } from "./transport.js";
import type { OpsExploreConfig, OpsExploreResult } from "../ops-analytics-types.js";
import type {
  DashboardCreate,
  DashboardFieldBreakdown,
  DashboardListResult,
  DashboardListSource,
  DashboardMenuItem,
  DashboardStudio,
  DashboardSurface,
  DashboardUpdate,
  DashboardVersionRow,
  DashboardView,
} from "../dashboards.js";

/** v12 Dashboard Studio: built-in and custom dashboards, their versions and the list widget data. */
export const dashboardsApi = (t: Transport) => ({
  dashboards: {
    studio: () => t.get<DashboardStudio>("/dashboards"),
    mine: () => t.get<DashboardMenuItem[]>("/dashboards/mine"),
    home: (surface: DashboardSurface) => t.get<DashboardView>(`/dashboards/home/${surface}`),
    builtin: (key: string) => t.get<DashboardView>(`/dashboards/builtin/${key}`),
    get: (id: string) => t.get<DashboardView>(`/dashboards/${id}`),
    create: (input: DashboardCreate) => t.post<DashboardView>("/dashboards", input),
    update: (id: string, input: DashboardUpdate) => t.patch<DashboardView>(`/dashboards/${id}`, input),
    duplicate: (id: string) => t.post<DashboardView>(`/dashboards/${id}/duplicate`),
    archive: (id: string, reason: string) => t.post<DashboardView>(`/dashboards/${id}/archive`, { reason }),
    restore: (id: string) => t.post<DashboardView>(`/dashboards/${id}/restore`),
    reset: (id: string) => t.post<DashboardView>(`/dashboards/${id}/reset`),
    versions: (id: string) => t.get<DashboardVersionRow[]>(`/dashboards/${id}/versions`),
    restoreVersion: (id: string, versionId: string) => t.post<DashboardView>(`/dashboards/${id}/versions/${versionId}/restore`),
    explore: (config: Partial<OpsExploreConfig>) => t.post<OpsExploreResult & { ownOnly: boolean }>("/dashboards/data/explore", config),
    report: (id: string) => t.get<OpsExploreResult & { ownOnly: boolean; name: string }>(`/dashboards/data/report/${id}`),
    fieldBreakdown: (entity: string, field: string, scope: "open" | "all" = "open") => t.get<DashboardFieldBreakdown>(`/dashboards/data/field/${entity}/${field}?scope=${scope}`),
    list: (source: DashboardListSource, limit = 6) => t.get<DashboardListResult>(`/dashboards/data/list/${source}?limit=${limit}`),
  },
});
