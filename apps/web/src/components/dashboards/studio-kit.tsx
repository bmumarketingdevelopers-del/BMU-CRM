"use client";

import { DASHBOARD_BUILTINS, customFieldEntityLabels, dashboardListInfo, dashboardWidgetTypeLabels, opsDimensionLabels, opsMetricInfo, type DashboardBuiltinKey, type DashboardWidget } from "@bmu/shared";

export const newWidgetId = () => `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/** A widget's name in the editor toolbar and the history. */
export function widgetLabel(w: DashboardWidget, host?: DashboardBuiltinKey | null): string {
  switch (w.type) {
    case "section": {
      const def = DASHBOARD_BUILTINS[w.dashboard];
      const label = def.sections.find((s) => s.key === w.section)?.label ?? w.section;
      return w.dashboard === host ? label : `${label} (from ${def.name})`;
    }
    case "kpi":
      return w.title || opsMetricInfo[w.metric].label;
    case "chart":
      return w.title || `${opsMetricInfo[w.metric].label} by ${opsDimensionLabels[w.dimension].toLowerCase()}`;
    case "report":
      return w.title || "Saved report";
    case "list":
      return w.title || dashboardListInfo[w.source].label;
    case "custom_field":
      return w.title || `${customFieldEntityLabels[w.entity].many} by ${w.field.replace(/_/g, " ")}`;
    case "note":
      return w.title || "Note";
    case "links":
      return w.title || "Quick links";
  }
}

export const widgetKind = (w: DashboardWidget) => dashboardWidgetTypeLabels[w.type];

/** Money widgets only show numbers to the Founder, Branch Manager and Finance. */
export const isMoneyWidget = (w: DashboardWidget) =>
  ((w.type === "kpi" || w.type === "chart") && opsMetricInfo[w.metric].money) ||
  (w.type === "list" && !!dashboardListInfo[w.source].money) ||
  (w.type === "section" && ["money_tiles", "money_chart", "overdue_invoices"].includes(w.section)) ||
  (w.type === "section" && w.dashboard === "scorecard");
