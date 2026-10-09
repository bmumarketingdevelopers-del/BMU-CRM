"use client";

import { useState } from "react";
import Link from "next/link";
import {
  OPS_CHARTS,
  OPS_METRICS,
  opsChartLabels,
  opsDimensionLabels,
  opsMetricInfo,
  type OpsChart,
  type OpsDimension,
  type OpsExploreResult,
  type OpsMetric,
  type OpsReportsList,
  type OpsSavedReport,
} from "@bmu/shared";
import { CsvButton, LineChart, PERIOD_PRESETS, resolvePeriod, usePeriod, type Period, type PeriodPreset } from "@/components/charts";
import { BarList, ColumnChart, DataTable, Panel, StatRow, StatTile, Tabs } from "@/components/dash";
import { Badge, Button, Input, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { OpsPage, type PeriodState, deltaOf, fmtDay, inr, inrShort, num, pctText, usePeriodData } from "../team/ops-kit";

type Config = { metric: OpsMetric; dimension: OpsDimension; chart: OpsChart };

const valueText = (unit: OpsExploreResult["unit"], n: number | null, short = false) =>
  n === null ? "—" : unit === "paise" ? (short ? inrShort(n) : inr(n)) : unit === "pct" ? pctText(n) : unit === "hours" ? `${num(n)}h` : num(n);

export default function ReportBuilderPage() {
  const { period, setPeriod } = usePeriod("90d");
  const [cfg, setCfg] = useState<Config>({ metric: "tasks_completed", dimension: "month", chart: "columns" });
  const reports = usePeriodData(() => api.opsAnalytics.reports(), ["reports"]);
  const state = usePeriodData(
    () => api.opsAnalytics.explore({ metric: cfg.metric, dimension: cfg.dimension, chart: cfg.chart, from: period.from, to: period.to, preset: period.preset }),
    [cfg.metric, cfg.dimension, period.from, period.to],
  );
  const canSeeMoney = reports.data?.canSeeMoney ?? false;
  const metrics = OPS_METRICS.filter((m) => canSeeMoney || !opsMetricInfo[m].money);
  const setMetric = (metric: OpsMetric) => {
    const dims = opsMetricInfo[metric].dimensions;
    setCfg((c) => ({ ...c, metric, dimension: dims.includes(c.dimension) ? c.dimension : dims[0] }));
  };
  const open = (r: OpsSavedReport) => {
    setCfg({ metric: r.config.metric, dimension: r.config.dimension, chart: r.config.chart });
    const preset = (r.config.preset ?? "custom") as PeriodPreset;
    setPeriod(preset === "custom" ? { preset, from: r.config.from.slice(0, 10), to: r.config.to.slice(0, 10) } : resolvePeriod(preset));
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <OpsPage
      title="Report builder"
      subtitle="Pick what to measure and how to group it. Save the ones you use often, and share them with the team."
      period={period}
      onPeriod={setPeriod}
      state={state}
      filters={
        <div className="flex flex-wrap items-center gap-2">
          <Select aria-label="Metric" value={cfg.metric} onChange={(e) => setMetric(e.target.value as OpsMetric)}>
            {metrics.map((m) => (
              <option key={m} value={m}>
                {opsMetricInfo[m].label}
              </option>
            ))}
          </Select>
          <span className="text-sm text-ink-muted">by</span>
          <Select aria-label="Group by" value={cfg.dimension} onChange={(e) => setCfg((c) => ({ ...c, dimension: e.target.value as OpsDimension }))}>
            {opsMetricInfo[cfg.metric].dimensions.map((d) => (
              <option key={d} value={d}>
                {opsDimensionLabels[d]}
              </option>
            ))}
          </Select>
        </div>
      }
    >
      {(res) => (
        <div className="space-y-8">
          <Reports state={reports} onOpen={open} />
          <Result res={res} chart={cfg.chart} onChart={(chart) => setCfg((c) => ({ ...c, chart }))} />
          <SaveForm cfg={cfg} period={period} onSaved={reports.reload} />
        </div>
      )}
    </OpsPage>
  );
}

function Result({ res, chart, onChart }: { res: OpsExploreResult; chart: OpsChart; onChart: (c: OpsChart) => void }) {
  const time = res.config.dimension === "month" || res.config.dimension === "week";
  const lower = res.config.metric === "sla_breaches";
  const empty = !res.rows.length || res.rows.every((r) => !r.value);
  const best = !time && res.rows.length ? res.rows[0] : null;
  return (
    <>
      <div>
        <StatRow cols={3}>
          <StatTile label={`${res.metricLabel}, total`} value={valueText(res.unit, res.total)} delta={res.total === null ? undefined : deltaOf({ value: res.total, prev: res.prevTotal }, { lowerIsBetter: lower })} hint={`${fmtDay(res.range.from)} – ${fmtDay(res.range.to)}`} />
          <StatTile label="Previous period" value={valueText(res.unit, res.prevTotal)} hint={`${fmtDay(res.range.prevFrom)} – ${fmtDay(res.range.prevTo)}`} />
          <StatTile label={time ? `${res.dimensionLabel}s shown` : `Top ${res.dimensionLabel.toLowerCase()}`} value={time ? res.rows.length : (best?.label ?? "—")} hint={best ? valueText(res.unit, best.value) : opsMetricInfo[res.config.metric].hint} />
        </StatRow>
      </div>
      <Panel
        className="min-w-0"
        title={`${res.metricLabel} by ${res.dimensionLabel.toLowerCase()}`}
        subtitle={opsMetricInfo[res.config.metric].hint}
        action={<Tabs value={chart} onChange={onChart} options={OPS_CHARTS.map((c) => ({ value: c, label: opsChartLabels[c] }))} />}
      >
        {empty ? (
          <p className="py-8 text-center text-sm text-ink-muted">Nothing to show for this period. Try a longer period or another metric.</p>
        ) : chart === "line" ? (
          <LineChart labels={res.rows.map((r) => r.label)} series={[{ key: "v", label: res.metricLabel, values: res.rows.map((r) => r.value), area: true }]} format={(n) => valueText(res.unit, n, true)} />
        ) : chart === "columns" ? (
          <ColumnChart data={res.rows.slice(0, 24).map((r) => ({ label: r.label, value: r.value }))} format={(n) => valueText(res.unit, n, true)} highlightLast={time} />
        ) : chart === "bars" ? (
          <BarList items={res.rows.slice(0, 15).map((r, i) => ({ label: r.label, value: r.value, href: r.href, highlight: !time && i === 0, note: res.unit === "pct" && r.count ? `${r.count} checks` : undefined }))} format={(n) => valueText(res.unit, n)} max={res.unit === "pct" ? 100 : undefined} />
        ) : (
          <p className="text-sm text-ink-muted">Table only: see below.</p>
        )}
        {!empty && chart !== "table" && res.rows.length > (chart === "bars" ? 15 : chart === "columns" ? 24 : 999) && <p className="mt-3 text-xs text-ink-muted">Chart shows the first {chart === "bars" ? 15 : 24}; the table has all {res.rows.length}.</p>}
      </Panel>
      <Panel
        className="min-w-0"
        title="Data"
        flush
        action={
          <CsvButton
            rows={res.rows}
            filename={`${res.config.metric}-by-${res.config.dimension}-${res.range.from}-${res.range.to}`}
            columns={[
              { header: res.dimensionLabel, value: (r) => r.label },
              { header: res.unit === "paise" ? `${res.metricLabel} (₹)` : res.metricLabel, value: (r) => (res.unit === "paise" ? r.value / 100 : r.value) },
              ...(res.unit === "pct" ? [{ header: "Checks", value: (r: OpsExploreResult["rows"][number]) => r.count }] : []),
            ]}
          />
        }
      >
        <DataTable
          rows={res.rows}
          rowKey={(r) => r.key}
          empty="No data in this period."
          columns={[
            { key: "label", header: res.dimensionLabel, cell: (r) => (r.href ? <Link href={r.href} className="font-medium hover:underline">{r.label}</Link> : <span className="font-medium">{r.label}</span>) },
            { key: "value", header: res.metricLabel, align: "right", cell: (r) => valueText(res.unit, r.value) },
            ...(res.unit === "pct" ? [{ key: "count", header: "Checks", align: "right" as const, cell: (r: OpsExploreResult["rows"][number]) => r.count ?? 0 }] : []),
          ]}
        />
      </Panel>
    </>
  );
}

function SaveForm({ cfg, period, onSaved }: { cfg: Config; period: Period; onSaved: () => void }) {
  const [name, setName] = useState("");
  const [shared, setShared] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ error?: string; ok?: string }>({});
  const save = async () => {
    setBusy(true);
    setNote({});
    const finalName = name.trim() || `${opsMetricInfo[cfg.metric].label} by ${opsDimensionLabels[cfg.dimension].toLowerCase()}`;
    try {
      await api.opsAnalytics.saveReport({ name: finalName, shared, pinned, config: { ...cfg, from: period.from, to: period.to, preset: period.preset } });
      setNote({ ok: `Saved “${finalName}”. It is in My reports at the top of the page.` });
      setName("");
      onSaved();
    } catch (e) {
      setNote({ error: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel title="Save this report" subtitle="Saved reports keep the metric, grouping, chart and period. Rolling periods (like 90 days) move with today.">
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label className="min-w-56 flex-1 text-sm">
          <span className="mb-1 block text-ink-muted">Name</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={`${opsMetricInfo[cfg.metric].label} by ${opsDimensionLabels[cfg.dimension].toLowerCase()}`} maxLength={80} />
        </label>
        <label className="flex items-center gap-2 py-2 text-sm">
          <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} /> Share with the team
        </label>
        <label className="flex items-center gap-2 py-2 text-sm">
          <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} /> Pin to top
        </label>
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save report"}
        </Button>
      </form>
      {note.error && <p className="mt-3 text-sm text-[#b4432c]">{note.error}</p>}
      {note.ok && <p className="mt-3 text-sm text-[#5f8a12]">{note.ok}</p>}
    </Panel>
  );
}

function Reports({ state, onOpen }: { state: PeriodState<OpsReportsList>; onOpen: (r: OpsSavedReport) => void }) {
  const [error, setError] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      state.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  if (!state.data) return state.error ? <p className="text-sm text-[#b4432c]">{state.error}</p> : null;
  const describe = (r: OpsSavedReport) => `${opsMetricInfo[r.config.metric].label} by ${opsDimensionLabels[r.config.dimension].toLowerCase()} · ${r.config.preset && r.config.preset !== "custom" ? (PERIOD_PRESETS.find((p) => p.value === r.config.preset)?.label ?? r.config.preset) : `${fmtDay(r.config.from)} – ${fmtDay(r.config.to)}`}`;
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Panel title="My reports" subtitle="Pinned ones stay at the top." flush>
        {error && <p className="border-b border-border px-5 py-3 text-sm text-[#b4432c]">{error}</p>}
        {state.data.mine.length ? (
          <ul className="divide-y divide-border">
            {state.data.mine.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                <button type="button" onClick={() => onOpen(r)} className="min-w-0 text-left">
                  <p className="flex items-center gap-2 font-medium hover:underline">
                    {r.name} {r.pinned && <Badge tone="green">Pinned</Badge>} {r.shared && <Badge>Shared</Badge>}
                  </p>
                  <p className="text-xs text-ink-muted">{describe(r)}</p>
                </button>
                <span className="flex gap-1">
                  <Button variant="ghost" className="px-2 py-1" onClick={() => act(() => api.opsAnalytics.updateReport(r.id, { pinned: !r.pinned }))}>
                    {r.pinned ? "Unpin" : "Pin"}
                  </Button>
                  <Button variant="ghost" className="px-2 py-1" onClick={() => act(() => api.opsAnalytics.updateReport(r.id, { shared: !r.shared }))}>
                    {r.shared ? "Stop sharing" : "Share"}
                  </Button>
                  <Button
                    variant="ghost"
                    className="px-2 py-1 text-[#b4432c]"
                    onClick={() => {
                      if (window.confirm(`Delete “${r.name}”?`)) void act(() => api.opsAnalytics.deleteReport(r.id));
                    }}
                  >
                    Delete
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-5 py-8 text-center text-sm text-ink-muted">No saved reports yet. Build one above and save it.</p>
        )}
      </Panel>
      <Panel title="Shared with the team" subtitle="Reports colleagues have shared. Open one to see it with today's data." flush>
        {state.data.shared.length ? (
          <ul className="divide-y divide-border">
            {state.data.shared.map((r) => (
              <li key={r.id} className="px-5 py-3">
                <button type="button" onClick={() => onOpen(r)} className="text-left">
                  <p className="font-medium hover:underline">{r.name}</p>
                  <p className="text-xs text-ink-muted">
                    {describe(r)} · by {r.owner}
                  </p>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-5 py-8 text-center text-sm text-ink-muted">Nothing shared yet.</p>
        )}
      </Panel>
    </div>
  );
}
