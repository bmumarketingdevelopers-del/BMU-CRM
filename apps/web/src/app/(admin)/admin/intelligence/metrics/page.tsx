"use client";

// v20 metric layer: one definition per number, used by dashboards, alerts, goals, reports and AI.
import { useEffect, useState } from "react";
import { PeriodPicker, usePeriod } from "@/components/charts";
import { Panel } from "@/components/dash";
import { LoadState, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import type { MetricValueView } from "@bmu/shared";

export default function MetricsPage() {
  const { period, setPeriod } = usePeriod("30d");
  const [state, setState] = useState<{ key: string; data?: MetricValueView[]; error?: string }>();
  const key = `${period.from}|${period.to}`;
  useEffect(() => {
    let live = true;
    api.intelligence.metrics(period.from, period.to).then(
      (data) => live && setState({ key, data }),
      (e: Error) => live && setState({ key, error: e.message }),
    );
    return () => {
      live = false;
    };
  }, [key, period.from, period.to]);
  const rows = state?.data ?? [];
  return (
    <>
      <PageTitle title="Metrics" subtitle="Every number BMU Hub uses, with its formula. Dashboards, alerts, goals, scheduled reports and the AI all read these same definitions." action={<PeriodPicker value={period} onChange={setPeriod} />} />
      <LoadState loading={state?.key !== key && !state?.data} error={state?.error} />
      <Panel flush>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[11px] uppercase tracking-[0.12em] text-ink-muted">
                <th className="px-4 py-2">Metric</th>
                <th className="px-4 py-2 text-right">Value</th>
                <th className="px-4 py-2 text-right">vs previous period</th>
                <th className="px-4 py-2">How it is worked out</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => {
                const good = m.changePct === null ? null : m.direction === "higher" ? m.changePct >= 0 : m.changePct <= 0;
                return (
                  <tr key={m.key} className="border-b border-border align-top">
                    <td className="px-4 py-2 font-medium">{m.label}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{m.display}</td>
                    <td className={`px-4 py-2 text-right tabular-nums ${good === null ? "text-ink-muted" : good ? "text-[#5f8a12]" : "text-[#b4432c]"}`}>
                      {m.changePct === null ? "—" : `${m.changePct >= 0 ? "▲" : "▼"} ${Math.abs(Math.round(m.changePct))}%`}
                    </td>
                    <td className="px-4 py-2 text-xs text-ink-muted">{m.formula}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}
