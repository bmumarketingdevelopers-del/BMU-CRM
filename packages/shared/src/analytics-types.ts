// v9 sales & money analytics (Scorecard, Sales Funnel, Revenue Forecast, MRR & Retention, Profitability).
// Money is integer paise, before GST unless a field says otherwise.

/** The period a view covers and the previous period of the same length, as ISO dates (inclusive). */
export type SalesPeriod = { from: string; to: string; prevFrom: string; prevTo: string; days: number };

/** A computed, plain-English "what this means" line. */
export type SalesInsight = { text: string; tone: "default" | "good" | "warn" };

// ---------------------------------------------------------------------------
// Scorecard

export type SalesKpiUnit = "paise" | "pct" | "days" | "count" | "ratio";

export type SalesKpi = {
  key: string;
  label: string;
  value: number | null;
  previous: number | null;
  unit: SalesKpiUnit;
  lowerIsBetter?: boolean;
  hint: string;
  href: string;
};

export type SalesScorecardView = {
  period: SalesPeriod;
  month: {
    label: string;
    revenuePaise: number;
    targetPaise: number;
    /** Revenue so far as % of target. */
    pct: number | null;
    projectedPaise: number;
    retainersToBillPaise: number;
    workingDaysElapsed: number;
    workingDaysTotal: number;
    onTrack: boolean;
  };
  kpis: SalesKpi[];
  trend: { labels: string[]; revenuePaise: number[]; targetPaise: number };
  insights: SalesInsight[];
};

// ---------------------------------------------------------------------------
// Sales funnel

export type SalesFunnelStageKey = "lead" | "contacted" | "discovery" | "proposal_sent" | "won" | "paid";

export type SalesFunnelStage = {
  key: SalesFunnelStageKey;
  label: string;
  count: number;
  prevCount: number;
  /** Median calendar days from the previous stage to this one (leads that reached both). */
  medianDaysFromPrev: number | null;
};

export type SalesFunnelLead = {
  id: string;
  name: string;
  company: string | null;
  source: string;
  stage: string;
  reached: SalesFunnelStageKey;
  lost: boolean;
  lostReason: string | null;
  owner: string | null;
  createdAt: string;
  valuePaise: number | null;
  clientId: string | null;
};

export type SalesFunnelBreakdown = {
  key: string;
  label: string;
  leads: number;
  proposals: number;
  won: number;
  conversionPct: number | null;
  /** Revenue invoiced so far (before GST) from clients won from these leads. Null when money is hidden. */
  revenuePaise: number | null;
};

export type SalesFunnelView = {
  period: SalesPeriod;
  canSeeMoney: boolean;
  stages: SalesFunnelStage[];
  winRatePct: number | null;
  prevWinRatePct: number | null;
  leadsCount: number;
  prevLeadsCount: number;
  speed: { medianHours: number | null; prevMedianHours: number | null; within24hPct: number | null; measured: number };
  bySource: SalesFunnelBreakdown[];
  byService: SalesFunnelBreakdown[];
  lostReasons: { label: string; count: number }[];
  winRateTrend: { month: string; label: string; won: number; lost: number; winRatePct: number | null }[];
  leads: SalesFunnelLead[];
  insights: SalesInsight[];
};

// ---------------------------------------------------------------------------
// Revenue forecast

export type SalesForecastMonth = {
  month: string;
  label: string;
  future: boolean;
  actualPaise: number | null;
  committedPaise: number | null;
  weightedPaise: number | null;
  expectedPaise: number | null;
  bestPaise: number | null;
  worstPaise: number | null;
};

export type SalesForecastDeal = {
  leadId: string;
  name: string;
  stage: string;
  stageLabel: string;
  source: string;
  basis: "proposal" | "budget";
  proposalId: string | null;
  /** Unweighted value landing in the next 6 months. */
  valuePaise: number;
  probabilityPct: number;
  weightedPaise: number;
  expectedMonth: string;
};

export type SalesForecastRetainer = { engagementId: string; clientId: string; client: string; service: string; tier: string; monthlyPaise: number; atRisk: string | null };
export type SalesForecastBalance = { engagementId: string; clientId: string; client: string; service: string; amountPaise: number; month: string };

export type SalesForecastView = {
  months: SalesForecastMonth[];
  /** Index of the first future month (for the chart's splitAt). */
  splitAt: number;
  targetPaise: number;
  mrrPaise: number;
  atRiskMrrPaise: number;
  totals: { committedPaise: number; weightedPaise: number; expectedPaise: number; bestPaise: number; worstPaise: number; targetPaise: number };
  retainers: SalesForecastRetainer[];
  balances: SalesForecastBalance[];
  deals: SalesForecastDeal[];
  settings: { stageProbabilityPct: Record<string, number>; monthlyTargetPaise: number };
  canEdit: boolean;
  insights: SalesInsight[];
};

// ---------------------------------------------------------------------------
// MRR & retention

export type SalesMrrMovementKind = "new" | "expansion" | "contraction" | "churn";

export type SalesRetentionView = {
  period: SalesPeriod;
  mrrTrend: { month: string; label: string; mrrPaise: number; clients: number }[];
  waterfall: { startPaise: number; newPaise: number; expansionPaise: number; contractionPaise: number; churnPaise: number; endPaise: number };
  prevWaterfall: { startPaise: number; newPaise: number; expansionPaise: number; contractionPaise: number; churnPaise: number; endPaise: number };
  movements: { clientId: string; client: string; kind: SalesMrrMovementKind; startPaise: number; endPaise: number }[];
  retainerClients: number;
  prevRetainerClients: number;
  logoChurnPct: number | null;
  prevLogoChurnPct: number | null;
  revenueChurnPct: number | null;
  prevRevenueChurnPct: number | null;
  nrrPct: number | null;
  prevNrrPct: number | null;
  cohorts: { label: string; size: number; values: (number | null)[] }[];
  avgLifetimeMonths: number | null;
  churnedClients: number;
  topClients: { id: string; name: string; lifetimePaise: number; active: boolean; months: number }[];
  concentration: { top3Pct: number | null; totalPaise: number; top3: { id: string; name: string; revenuePaise: number }[] };
  insights: SalesInsight[];
};

// ---------------------------------------------------------------------------
// Profitability

export type SalesProfitRow = {
  id: string;
  name: string;
  revenuePaise: number;
  collectedPaise: number;
  hours: number;
  labourCostPaise: number;
  creatorCostPaise: number;
  costPaise: number;
  marginPaise: number;
  marginPct: number | null;
  hourlyRatePaise: number | null;
};

export type SalesProfitabilityView = {
  period: SalesPeriod;
  clients: SalesProfitRow[];
  services: SalesProfitRow[];
  totals: SalesProfitRow;
  prevTotals: SalesProfitRow;
  byRole: { role: string; hours: number; costPaise: number; ratePaise: number }[];
  /** Fully loaded cost of one average hour (team mix, with overhead). */
  avgCostPerHourPaise: number | null;
  costRates: { hourlyPaise: Record<string, number>; overheadPct: number };
  canEdit: boolean;
  insights: SalesInsight[];
};
