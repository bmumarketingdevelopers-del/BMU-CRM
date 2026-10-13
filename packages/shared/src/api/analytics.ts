import type { Transport } from "./transport.js";
import type { SalesForecastView, SalesFunnelView, SalesProfitabilityView, SalesRetentionView, SalesScorecardView } from "../analytics-types.js";

export * from "../analytics-types.js";

/** Optional ISO dates (yyyy-mm-dd). The API defaults to the last 90 days. */
export type SalesRange = { from?: string; to?: string };

const salesRange = (r: SalesRange = {}) => {
  const s = new URLSearchParams(Object.entries(r).filter((e): e is [string, string] => !!e[1])).toString();
  return s ? `?${s}` : "";
};

/** v9 sales & money analytics (Founder, Branch Manager, Finance). */
export const analyticsApi = (t: Transport) => ({
  analytics: {
    scorecard: (r?: SalesRange) => t.get<SalesScorecardView>(`/analytics/scorecard${salesRange(r)}`),
    funnel: (r?: SalesRange) => t.get<SalesFunnelView>(`/analytics/funnel${salesRange(r)}`),
    forecast: () => t.get<SalesForecastView>("/analytics/forecast"),
    retention: (r?: SalesRange) => t.get<SalesRetentionView>(`/analytics/retention${salesRange(r)}`),
    profitability: (r?: SalesRange) => t.get<SalesProfitabilityView>(`/analytics/profitability${salesRange(r)}`),
  },
});
