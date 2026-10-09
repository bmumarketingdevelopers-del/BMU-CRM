"use client";

/** v12: change one widget — title, width and what it shows. */
import { useState } from "react";
import {
  DASHBOARD_LIST_SOURCES,
  DASHBOARD_PERIODS,
  DASHBOARD_SIZES,
  OPS_CHARTS,
  OPS_METRICS,
  dashboardListInfo,
  dashboardPeriodLabels,
  dashboardSizeLabels,
  dashboardWidgetSchema,
  opsChartLabels,
  opsDimensionLabels,
  opsMetricInfo,
  type DashboardBuiltinKey,
  type DashboardSize,
  type DashboardWidget,
  type OpsReportsList,
} from "@bmu/shared";
import { ActionDrawer, Field, TextArea } from "@/components/actions/action-drawer";
import { Button, Input, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { widgetLabel, widgetKind } from "./studio-kit";

export function WidgetSettings({ widget, host, onClose, onApply }: { widget: DashboardWidget; host: DashboardBuiltinKey | null; onClose: () => void; onApply: (w: DashboardWidget) => void }) {
  const [w, setW] = useState<DashboardWidget>(widget);
  const [error, setError] = useState<string | null>(null);
  const reports = useLoad<OpsReportsList | null>(() => (widget.type === "report" ? api.opsAnalytics.reports() : Promise.resolve(null)));
  const set = (patch: Partial<DashboardWidget>) => setW((cur) => ({ ...cur, ...patch }) as DashboardWidget);

  function apply() {
    const r = dashboardWidgetSchema.safeParse(w);
    if (!r.success) return setError(r.error.issues[0]?.message ?? "Check the settings");
    onApply(r.data);
    onClose();
  }

  return (
    <ActionDrawer open title={`Change: ${widgetLabel(widget, host)}`} subtitle={widgetKind(widget)} onClose={onClose} onSubmit={apply} error={error} saveLabel="Apply" testId="widget-settings">
      {w.type !== "section" && (
        <Field label="Title" htmlFor="w-title" hint="Leave empty to use the standard name">
          <Input id="w-title" value={w.title ?? ""} onChange={(e) => set({ title: e.target.value || undefined })} className="w-full" maxLength={80} />
        </Field>
      )}
      <Field label="Width on a computer" htmlFor="w-size" hint="On a phone every widget is full width">
        <Select id="w-size" value={w.size} onChange={(e) => set({ size: e.target.value as DashboardSize })} className="w-full">
          {DASHBOARD_SIZES.map((s) => (
            <option key={s} value={s}>
              {dashboardSizeLabels[s]}
            </option>
          ))}
        </Select>
      </Field>

      {(w.type === "kpi" || w.type === "chart") && (
        <>
          <Field label={w.type === "kpi" ? "Number" : "What to chart"} htmlFor="w-metric">
            <Select
              id="w-metric"
              value={w.metric}
              onChange={(e) => {
                const metric = e.target.value as (typeof OPS_METRICS)[number];
                set(w.type === "chart" && !opsMetricInfo[metric].dimensions.includes(w.dimension) ? { metric, dimension: "month" } : { metric });
              }}
              className="w-full"
            >
              {OPS_METRICS.map((m) => (
                <option key={m} value={m}>
                  {opsMetricInfo[m].label}
                  {opsMetricInfo[m].money ? " (money)" : ""}
                </option>
              ))}
            </Select>
          </Field>
          {w.type === "chart" && (
            <>
              <Field label="Group by" htmlFor="w-dim">
                <Select id="w-dim" value={w.dimension} onChange={(e) => set({ dimension: e.target.value as typeof w.dimension })} className="w-full">
                  {opsMetricInfo[w.metric].dimensions.map((d) => (
                    <option key={d} value={d}>
                      {opsDimensionLabels[d]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Chart" htmlFor="w-chart">
                <Select id="w-chart" value={w.chart} onChange={(e) => set({ chart: e.target.value as typeof w.chart })} className="w-full">
                  {OPS_CHARTS.map((c) => (
                    <option key={c} value={c}>
                      {c === "table" ? "Table" : opsChartLabels[c]}
                    </option>
                  ))}
                </Select>
              </Field>
            </>
          )}
          <Field label="Period" htmlFor="w-period" hint="Always counted up to today, and compared with the period before">
            <Select id="w-period" value={w.period} onChange={(e) => set({ period: e.target.value as typeof w.period })} className="w-full">
              {DASHBOARD_PERIODS.map((p) => (
                <option key={p} value={p}>
                  {dashboardPeriodLabels[p]}
                </option>
              ))}
            </Select>
          </Field>
        </>
      )}

      {w.type === "list" && (
        <>
          <Field label="List" htmlFor="w-source">
            <Select id="w-source" value={w.source} onChange={(e) => set({ source: e.target.value as typeof w.source })} className="w-full">
              {DASHBOARD_LIST_SOURCES.map((s) => (
                <option key={s} value={s}>
                  {dashboardListInfo[s].label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="How many rows" htmlFor="w-limit">
            <Input id="w-limit" type="number" min={3} max={20} value={w.limit} onChange={(e) => set({ limit: Math.max(3, Math.min(20, Number(e.target.value) || 6)) })} className="w-32" />
          </Field>
        </>
      )}

      {w.type === "report" && (
        <Field label="Saved report" htmlFor="w-report">
          <Select id="w-report" value={w.reportId} onChange={(e) => set({ reportId: e.target.value })} className="w-full">
            {[...(reports.data?.mine ?? []), ...(reports.data?.shared ?? [])].map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
            {!reports.data && <option value={w.reportId}>Loading…</option>}
          </Select>
        </Field>
      )}

      {w.type === "custom_field" && (
        <Field label="Which records" htmlFor="w-scope">
          <Select id="w-scope" value={w.scope} onChange={(e) => set({ scope: e.target.value as "open" | "all" })} className="w-full">
            <option value="open">Open ones only (not won, lost, closed or archived)</option>
            <option value="all">All of them</option>
          </Select>
        </Field>
      )}

      {w.type === "note" && (
        <Field label="Text" required htmlFor="w-text">
          <TextArea id="w-text" rows={6} value={w.text} onChange={(e) => set({ text: e.target.value })} maxLength={2000} />
        </Field>
      )}

      {w.type === "links" && (
        <Field label="Links" hint="A page here starts with / (like /team/tasks). Other sites start with https://">
          <div className="space-y-2">
            {w.links.map((l, i) => (
              <div key={i} className="grid grid-cols-[1fr_1.4fr_auto] gap-2">
                <Input aria-label={`Link ${i + 1} name`} value={l.label} placeholder="Name" onChange={(e) => set({ links: w.links.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} />
                <Input aria-label={`Link ${i + 1} address`} value={l.href} placeholder="/team/tasks" onChange={(e) => set({ links: w.links.map((x, j) => (j === i ? { ...x, href: e.target.value } : x)) })} />
                <button type="button" className="px-2 text-ink-muted hover:text-ink" aria-label={`Remove link ${i + 1}`} onClick={() => set({ links: w.links.filter((_, j) => j !== i) })}>
                  ✕
                </button>
              </div>
            ))}
            {w.links.length < 12 && (
              <Button type="button" variant="secondary" className="px-3 py-1 text-xs" onClick={() => set({ links: [...w.links, { label: "", href: "/" }] })}>
                + Add link
              </Button>
            )}
          </div>
        </Field>
      )}
    </ActionDrawer>
  );
}
