import type { Transport } from "./transport.js";
import type {
  OpsClientView,
  OpsDeliveryView,
  OpsExploreConfig,
  OpsExploreResult,
  OpsMyView,
  OpsPeriodQuery,
  OpsReportsList,
  OpsSaveReport,
  OpsSavedReport,
  OpsSlaView,
  OpsTeamView,
  OpsUpdateReport,
} from "../ops-analytics-types.js";

export * from "../ops-analytics-types.js";

const opsQs = (params: Record<string, string | undefined>) => {
  const s = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => !!e[1])).toString();
  return s ? `?${s}` : "";
};

/** v9 operations analytics: team, delivery, SLA, report builder, my performance and client insights. */
export const opsAnalyticsApi = (t: Transport) => ({
  opsAnalytics: {
    team: (q: OpsPeriodQuery & { departmentId?: string } = {}) => t.get<OpsTeamView>(`/ops-analytics/team${opsQs(q)}`),
    delivery: (q: OpsPeriodQuery = {}) => t.get<OpsDeliveryView>(`/ops-analytics/delivery${opsQs(q)}`),
    sla: (q: OpsPeriodQuery = {}) => t.get<OpsSlaView>(`/ops-analytics/sla${opsQs(q)}`),
    me: (q: OpsPeriodQuery = {}) => t.get<OpsMyView>(`/ops-analytics/me${opsQs(q)}`),
    client: (q: OpsPeriodQuery = {}) => t.get<OpsClientView>(`/ops-analytics/client${opsQs(q)}`),
    explore: (config: Partial<OpsExploreConfig>) => t.post<OpsExploreResult>("/ops-analytics/explore", config),
    reports: () => t.get<OpsReportsList>("/ops-analytics/reports"),
    report: (id: string) => t.get<OpsSavedReport>(`/ops-analytics/reports/${id}`),
    saveReport: (input: OpsSaveReport) => t.post<OpsSavedReport>("/ops-analytics/reports", input),
    updateReport: (id: string, input: OpsUpdateReport) => t.patch<OpsSavedReport>(`/ops-analytics/reports/${id}`, input),
    deleteReport: (id: string) => t.del<{ ok: true }>(`/ops-analytics/reports/${id}`),
  },
});
