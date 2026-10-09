"use client";

// v12: the Scorecard as sections, laid out by the Dashboard Studio (default: the original order).
import Link from "next/link";
import type { ReactNode } from "react";
import { dashboardDefaultLayout, type SalesScorecardView } from "@bmu/shared";
import { CsvButton, LineChart, usePeriod, type Period } from "@/components/charts";
import { DataTable, KeyValues, Meter, Panel, StatRow, StatTile } from "@/components/dash";
import { DashGrid, type DashLayoutProps } from "@/components/dashboards/grid";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { AiPanel } from "@/components/ai/ai-panel";
import { Insights, PeriodLine, WithData, change, fmtValue, inr, inrShort, rupees } from "./_sales/kit";

export function ScorecardBody({ period, layout, wrap }: { period: Period } & DashLayoutProps) {
  const state = useLoad(() => api.analytics.scorecard({ from: period.from, to: period.to }));
  return <WithData state={state}>{(d) => <Scorecard d={d} layout={layout} wrap={wrap} />}</WithData>;
}

/** A Scorecard section shown on another dashboard: this financial year. */
export function ScorecardEmbed(props: DashLayoutProps) {
  const { period } = usePeriod("fy");
  return <ScorecardBody period={period} {...props} />;
}

function Scorecard({ d, layout, wrap }: { d: SalesScorecardView } & DashLayoutProps) {
  const m = d.month;
  const months = d.trend.labels.map((label, i) => ({ label, revenuePaise: d.trend.revenuePaise[i], gap: d.trend.revenuePaise[i] - d.trend.targetPaise }));
  const sections: Record<string, ReactNode> = {
    ai_notes: (
      <AiPanel feature="anomaly_notes" options={{ page: "scorecard" }} title="What stands out" description="Unusual moves against target and last month. Worked out from these numbers only." buttonLabel="Explain the numbers" />
    ),
    month_target: (
      <Panel
        title={`${m.label}: revenue against target`}
        subtitle={`${m.workingDaysElapsed} of ${m.workingDaysTotal} working days gone`}
        action={
          <Link href="/admin/analytics/forecast#targets" className="text-sm text-ink-muted hover:text-ink">
            Change target
          </Link>
        }
      >
        {m.targetPaise > 0 ? (
          <div className="grid gap-6 md:grid-cols-[1.2fr_1fr]">
            <div>
              <p className="text-[28px] leading-none font-semibold tabular-nums">
                {inr(m.revenuePaise)} <span className="text-base font-normal text-ink-muted">of {inr(m.targetPaise)}</span>
              </p>
              <div className="mt-4">
                <Meter value={m.pct ?? 0} tone={m.onTrack ? "good" : "warn"} label="Share of monthly target invoiced" />
              </div>
              <p className={`mt-3 text-sm ${m.onTrack ? "text-[#5f8a12]" : "text-[#9a6b00]"}`}>
                {m.onTrack ? "On track" : "Behind pace"}: on track to reach {inr(m.projectedPaise)} by month end{m.onTrack ? "." : `, ${inr(m.targetPaise - m.projectedPaise)} short.`}
              </p>
            </div>
            <KeyValues
              items={[
                { k: "Invoiced so far", v: inr(m.revenuePaise) },
                { k: "Retainers still to bill", v: inr(m.retainersToBillPaise) },
                { k: "Expected by month end", v: inr(m.projectedPaise) },
              ]}
            />
          </div>
        ) : (
          <p className="text-sm text-ink-muted">No monthly target set yet. Set one on the Revenue Forecast page.</p>
        )}
      </Panel>
    ),
    kpis: (
      <StatRow cols={4}>
        {d.kpis.map((k) => (
          <StatTile key={k.key} label={k.label} value={fmtValue(k.unit, k.value, k.unit === "paise")} delta={change(k.value, k.previous, { unit: k.unit, lowerIsBetter: k.lowerIsBetter })} hint={k.hint} href={k.href} tone={k.key === "net_new_mrr" && (k.value ?? 0) < 0 ? "bad" : "default"} />
        ))}
      </StatRow>
    ),
    trend: (
      <Panel className="min-w-0 h-full" title="Revenue against target, last 12 months" subtitle="Invoiced each month, before GST, after credit notes">
        <LineChart labels={d.trend.labels} series={[{ key: "rev", label: "Revenue", values: d.trend.revenuePaise, area: true }]} target={d.trend.targetPaise ? { value: d.trend.targetPaise, label: `Target ${inrShort(d.trend.targetPaise)}` } : undefined} format={inrShort} height={220} />
        <Insights items={d.insights} />
      </Panel>
    ),
    month_table: (
      <Panel
        className="min-w-0 h-full"
        title="Month by month"
        subtitle="Revenue and the gap to target"
        flush
        action={
          <CsvButton
            rows={months}
            filename="revenue-vs-target"
            columns={[
              { header: "Month", value: (r) => r.label },
              { header: "Revenue (₹, before GST)", value: (r) => rupees(r.revenuePaise) },
              { header: "Target (₹)", value: () => rupees(d.trend.targetPaise) },
              { header: "Gap (₹)", value: (r) => rupees(r.gap) },
            ]}
          />
        }
      >
        <DataTable
          rows={[...months].reverse()}
          rowKey={(r) => r.label}
          columns={[
            { key: "m", header: "Month", cell: (r) => r.label },
            { key: "r", header: "Revenue", align: "right", cell: (r) => inr(r.revenuePaise) },
            { key: "t", header: "Target", align: "right", cell: () => (d.trend.targetPaise ? inr(d.trend.targetPaise) : "—") },
            { key: "g", header: "Gap", align: "right", cell: (r) => (d.trend.targetPaise ? <span className={r.gap >= 0 ? "text-[#5f8a12]" : "text-[#b4432c]"}>{r.gap >= 0 ? "+" : "−"}{inr(Math.abs(r.gap))}</span> : "—") },
          ]}
        />
      </Panel>
    ),
  };
  return (
    <div className="space-y-8">
      <PeriodLine period={d.period} />
      <DashGrid host="scorecard" items={layout ?? dashboardDefaultLayout("scorecard")} sections={sections} wrap={wrap} />
    </div>
  );
}
