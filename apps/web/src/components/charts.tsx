"use client";
// Advanced chart kit (v9): line/area with forecast bands, funnel, heatmap, waterfall, cohort grid, donut,
// plus a period picker and CSV export. Same quiet palette as dash.tsx: charcoal for data, green for the one
// thing to notice, grey for comparison, amber/red only for problems. Pure SVG, no chart library.
import { useMemo, useState, type ReactNode } from "react";
import { Empty } from "@/components/dash";

export const chartColors = { dark: "#121F2F", green: "#8BB72C", grey: "#B9BDC4", muted: "#DCDDD8", amber: "#D9A400", red: "#C4553D", blue: "#4C6A92" } as const;
export type ChartColor = keyof typeof chartColors;

// ---------------------------------------------------------------------------
// Line / area chart

export type LineSeries = { key: string; label: string; values: (number | null)[]; color?: ChartColor; dashed?: boolean; area?: boolean };

/**
 * Multi-series line chart over shared x labels. Optional `band` (low/high per point) draws a shaded range,
 * e.g. a forecast's best and worst case. `target` draws a dotted horizontal line. Hover shows every value.
 */
export function LineChart({
  labels,
  series,
  band,
  target,
  format = (n) => String(Math.round(n)),
  height = 200,
  splitAt,
}: {
  labels: string[];
  series: LineSeries[];
  band?: { low: (number | null)[]; high: (number | null)[]; label?: string };
  target?: { value: number; label: string };
  format?: (n: number) => string;
  height?: number;
  /** Index from which the x axis is "future" (shaded background), e.g. forecast months. */
  splitAt?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 640;
  const H = height;
  const pad = { l: 8, r: 8, t: 12, b: 8 };
  const all = [...series.flatMap((s) => s.values), ...(band ? [...band.low, ...band.high] : []), target?.value ?? null].filter((v): v is number => v !== null && Number.isFinite(v));
  if (!labels.length || !all.length) return <Empty>No data yet.</Empty>;
  const max = Math.max(...all, 1) * 1.08;
  const min = Math.min(0, ...all);
  const x = (i: number) => pad.l + (labels.length === 1 ? (W - pad.l - pad.r) / 2 : (i / (labels.length - 1)) * (W - pad.l - pad.r));
  const y = (v: number) => pad.t + (1 - (v - min) / (max - min || 1)) * (H - pad.t - pad.b);
  const path = (vals: (number | null)[]) => {
    let d = "";
    let pen = false;
    vals.forEach((v, i) => {
      if (v === null || !Number.isFinite(v)) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const bandPath = band
    ? (() => {
        const idx = labels.map((_, i) => i).filter((i) => band.low[i] !== null && band.high[i] !== null);
        if (idx.length < 2) return "";
        const top = idx.map((i, k) => `${k ? "L" : "M"}${x(i).toFixed(1)},${y(band.high[i]!).toFixed(1)}`).join("");
        const bottom = [...idx].reverse().map((i) => `L${x(i).toFixed(1)},${y(band.low[i]!).toFixed(1)}`).join("");
        return `${top}${bottom}Z`;
      })()
    : "";
  const step = labels.length > 1 ? (W - pad.l - pad.r) / (labels.length - 1) : W;
  const tickEvery = Math.max(1, Math.ceil(labels.length / 8));
  return (
    <div>
      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height }} preserveAspectRatio="none" role="img" aria-label={series.map((s) => s.label).join(", ")} onMouseLeave={() => setHover(null)}>
          {[0.25, 0.5, 0.75].map((f) => (
            <line key={f} x1={pad.l} x2={W - pad.r} y1={pad.t + f * (H - pad.t - pad.b)} y2={pad.t + f * (H - pad.t - pad.b)} stroke="#ebeae6" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          ))}
          {splitAt !== undefined && splitAt < labels.length && <rect x={x(splitAt) - step / 2} y={0} width={W - x(splitAt) + step / 2} height={H} fill="#f6f5f1" />}
          {bandPath && <path d={bandPath} fill={chartColors.green} opacity={0.14} />}
          {target && <line x1={pad.l} x2={W - pad.r} y1={y(target.value)} y2={y(target.value)} stroke={chartColors.amber} strokeDasharray="4 4" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />}
          {series.map((s) =>
            s.area ? <path key={`${s.key}-a`} d={`${path(s.values)}L${x(lastIdx(s.values))},${y(min)}L${x(firstIdx(s.values))},${y(min)}Z`} fill={chartColors[s.color ?? "dark"]} opacity={0.08} /> : null,
          )}
          {series.map((s) => (
            <path key={s.key} d={path(s.values)} fill="none" stroke={chartColors[s.color ?? "dark"]} strokeWidth="2" strokeDasharray={s.dashed ? "5 4" : undefined} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
          ))}
          {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={H - pad.b} stroke={chartColors.grey} strokeWidth="1" vectorEffect="non-scaling-stroke" />}
          {labels.map((_, i) => (
            <rect key={i} x={x(i) - step / 2} y={0} width={step} height={H} fill="transparent" onMouseEnter={() => setHover(i)} />
          ))}
        </svg>
        {hover !== null && (
          <div className="pointer-events-none absolute top-0 z-10 min-w-36 border border-border bg-surface-raised px-3 py-2 text-xs shadow-sm" style={{ left: `min(calc(${(x(hover) / W) * 100}% + 8px), calc(100% - 10rem))` }}>
            <p className="mb-1 font-medium">{labels[hover]}</p>
            {series.map((s) =>
              s.values[hover] === null || s.values[hover] === undefined ? null : (
                <p key={s.key} className="flex justify-between gap-3 text-ink-muted">
                  <span>{s.label}</span>
                  <span className="tabular-nums text-ink">{format(s.values[hover]!)}</span>
                </p>
              ),
            )}
            {band && band.low[hover] !== null && band.high[hover] !== null && (
              <p className="flex justify-between gap-3 text-ink-muted">
                <span>{band.label ?? "Range"}</span>
                <span className="tabular-nums text-ink">
                  {format(band.low[hover]!)} – {format(band.high[hover]!)}
                </span>
              </p>
            )}
          </div>
        )}
      </div>
      <div className="mt-2 flex border-t border-border pt-2">
        {labels.map((l, i) => (
          <span key={i} className="flex-1 truncate text-center text-[11px] text-ink-muted">
            {i % tickEvery === 0 ? l : ""}
          </span>
        ))}
      </div>
      <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-ink-muted">
        {series.map((s) => (
          <li key={s.key} className="flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-4" style={{ background: chartColors[s.color ?? "dark"], borderTop: s.dashed ? "2px dashed" : undefined }} />
            {s.label}
          </li>
        ))}
        {band && (
          <li className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-4" style={{ background: chartColors.green, opacity: 0.25 }} />
            {band.label ?? "Range"}
          </li>
        )}
        {target && (
          <li className="flex items-center gap-1.5">
            <span className="inline-block w-4 border-t-2 border-dashed" style={{ borderColor: chartColors.amber }} />
            {target.label}
          </li>
        )}
      </ul>
    </div>
  );
}
const firstIdx = (v: (number | null)[]) => Math.max(0, v.findIndex((n) => n !== null));
const lastIdx = (v: (number | null)[]) => {
  for (let i = v.length - 1; i >= 0; i--) if (v[i] !== null) return i;
  return 0;
};

// ---------------------------------------------------------------------------
// Funnel

/** Stage-by-stage funnel with conversion from the previous step and from the top. */
export function FunnelChart({ steps, format = (n) => String(n) }: { steps: { label: string; value: number; note?: ReactNode; href?: string }[]; format?: (n: number) => string }) {
  if (!steps.length) return <Empty>No data yet.</Empty>;
  const top = Math.max(1, steps[0].value);
  return (
    <ol className="space-y-2">
      {steps.map((s, i) => {
        const prev = i ? steps[i - 1].value : s.value;
        const conv = prev ? (s.value / prev) * 100 : 0;
        const width = Math.max(2, (s.value / top) * 100);
        const row = (
          <div className="grid grid-cols-[minmax(7rem,10rem)_1fr_auto] items-center gap-3 text-sm">
            <span className="truncate">{s.label}</span>
            <div className="h-7 bg-canvas">
              <div className={`flex h-full items-center px-2 text-xs font-medium tabular-nums ${i === steps.length - 1 ? "bg-green text-charcoal" : "bg-charcoal text-ivory"}`} style={{ width: `${width}%` }}>
                {width > 12 ? format(s.value) : ""}
              </div>
            </div>
            <span className="w-28 text-right text-xs tabular-nums text-ink-muted">
              {width <= 12 && <span className="mr-1 text-ink">{format(s.value)}</span>}
              {i === 0 ? "start" : `${conv.toFixed(conv < 10 ? 1 : 0)}% of prev`}
              {s.note && <span className="block">{s.note}</span>}
            </span>
          </div>
        );
        return <li key={s.label}>{s.href ? <a href={s.href} className="block hover:opacity-85">{row}</a> : row}</li>;
      })}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// Heatmap

/** Grid of cells shaded by value (e.g. requests by weekday × hour). Null cells are blank. */
export function Heatmap({ rows, cols, values, format = (n) => String(n), tone = "dark", cellTitle }: { rows: string[]; cols: string[]; values: (number | null)[][]; format?: (n: number) => string; tone?: "dark" | "green" | "red"; cellTitle?: (r: number, c: number, v: number | null) => string }) {
  const flat = values.flat().filter((v): v is number => v !== null);
  if (!flat.length) return <Empty>No data yet.</Empty>;
  const max = Math.max(...flat, 1);
  const base = { dark: "18,31,47", green: "139,183,44", red: "196,85,61" }[tone];
  return (
    <div className="overflow-x-auto">
      <table className="border-separate border-spacing-0.5 text-[11px]">
        <thead>
          <tr>
            <th />
            {cols.map((c) => (
              <th key={c} className="px-0.5 pb-1 font-normal text-ink-muted">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={r}>
              <th className="pr-2 text-right font-normal whitespace-nowrap text-ink-muted">{r}</th>
              {cols.map((c, ci) => {
                const v = values[ri]?.[ci] ?? null;
                const a = v === null ? 0 : 0.08 + (v / max) * 0.92;
                return (
                  <td key={c} title={cellTitle ? cellTitle(ri, ci, v) : `${r} ${c}: ${v === null ? "—" : format(v)}`} className="h-7 min-w-7 text-center tabular-nums" style={{ background: v === null ? "#f6f5f1" : `rgba(${base},${a})`, color: a > 0.55 ? "#FBFAF5" : "#121F2F" }}>
                    {v ? format(v) : ""}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Waterfall

/** Start value, then positive/negative moves, ending in a total (e.g. MRR: start + new + expansion − churn = end). */
export function Waterfall({ start, steps, format = (n) => String(n), height = 180 }: { start: { label: string; value: number }; steps: { label: string; value: number }[]; format?: (n: number) => string; height?: number }) {
  const bars: { label: string; from: number; to: number; kind: "total" | "up" | "down" }[] = [];
  let run = start.value;
  bars.push({ label: start.label, from: 0, to: run, kind: "total" });
  for (const s of steps) {
    bars.push({ label: s.label, from: run, to: run + s.value, kind: s.value >= 0 ? "up" : "down" });
    run += s.value;
  }
  bars.push({ label: "End", from: 0, to: run, kind: "total" });
  const max = Math.max(1, ...bars.map((b) => Math.max(b.from, b.to)));
  const min = Math.min(0, ...bars.map((b) => Math.min(b.from, b.to)));
  const pct = (v: number) => ((v - min) / (max - min || 1)) * 100;
  return (
    <div>
      <div className="flex items-stretch gap-2" style={{ height }}>
        {bars.map((b, i) => {
          const lo = Math.min(b.from, b.to);
          const hi = Math.max(b.from, b.to);
          return (
            <div key={i} className="relative flex-1" title={`${b.label}: ${b.kind === "total" ? format(b.to) : `${b.to >= b.from ? "+" : "−"}${format(Math.abs(b.to - b.from))}`}`}>
              <div className={`absolute inset-x-0 ${b.kind === "total" ? "bg-charcoal" : b.kind === "up" ? "bg-green" : "bg-red"}`} style={{ bottom: `${pct(lo)}%`, height: `${Math.max(0.8, pct(hi) - pct(lo))}%` }} />
              <span className="absolute inset-x-0 text-center text-[11px] tabular-nums text-ink" style={{ bottom: `calc(${pct(hi)}% + 2px)` }}>
                {b.kind === "total" ? format(b.to) : `${b.to >= b.from ? "+" : "−"}${format(Math.abs(b.to - b.from))}`}
              </span>
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex gap-2 border-t border-border pt-2">
        {bars.map((b, i) => (
          <span key={i} className="flex-1 truncate text-center text-[11px] text-ink-muted">
            {b.label}
          </span>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cohort grid

/** Retention triangle: one row per cohort, one column per period since start, values in % (0–100). */
export function CohortGrid({ cohorts, periods, format = (n) => `${Math.round(n)}%` }: { cohorts: { label: string; size: number; values: (number | null)[] }[]; periods: string[]; format?: (n: number) => string }) {
  if (!cohorts.length) return <Empty>No cohorts yet.</Empty>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-separate border-spacing-0.5 text-xs">
        <thead>
          <tr className="text-ink-muted">
            <th className="pr-3 text-left font-normal">Cohort</th>
            <th className="pr-3 text-right font-normal">Size</th>
            {periods.map((p) => (
              <th key={p} className="px-1 font-normal">
                {p}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {cohorts.map((c) => (
            <tr key={c.label}>
              <td className="pr-3 whitespace-nowrap">{c.label}</td>
              <td className="pr-3 text-right tabular-nums text-ink-muted">{c.size}</td>
              {periods.map((p, i) => {
                const v = c.values[i] ?? null;
                return (
                  <td key={p} className="h-8 min-w-12 text-center tabular-nums" style={{ background: v === null ? "transparent" : `rgba(139,183,44,${0.1 + (v / 100) * 0.75})` }}>
                    {v === null ? "" : format(v)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Donut

export function Donut({ parts, format = (n) => String(n), center, size = 140 }: { parts: { label: string; value: number; color?: ChartColor }[]; format?: (n: number) => string; center?: ReactNode; size?: number }) {
  const total = parts.reduce((s, p) => s + p.value, 0);
  if (!total) return <Empty>No data yet.</Empty>;
  const r = 42;
  const c = 2 * Math.PI * r;
  const offsets = parts.map((_, i) => parts.slice(0, i).reduce((s, p) => s + (p.value / total) * c, 0));
  const palette: ChartColor[] = ["dark", "green", "grey", "blue", "amber", "muted", "red"];
  return (
    <div className="flex flex-wrap items-center gap-6">
      <div className="relative" style={{ width: size, height: size }}>
        <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90">
          <circle cx="50" cy="50" r={r} fill="none" stroke="#f1f0ec" strokeWidth="12" />
          {parts.map((p, i) => {
            const len = (p.value / total) * c;
            const el = <circle key={p.label} cx="50" cy="50" r={r} fill="none" stroke={chartColors[p.color ?? palette[i % palette.length]]} strokeWidth="12" strokeDasharray={`${len} ${c - len}`} strokeDashoffset={-offsets[i]} />;
            return el;
          })}
        </svg>
        {center && <div className="absolute inset-0 flex flex-col items-center justify-center text-center">{center}</div>}
      </div>
      <ul className="space-y-1.5 text-xs">
        {parts.map((p, i) => (
          <li key={p.label} className="flex items-center gap-2">
            <span className="inline-block h-2.5 w-2.5" style={{ background: chartColors[p.color ?? palette[i % palette.length]] }} />
            <span className="text-ink-muted">{p.label}</span>
            <span className="font-medium tabular-nums">{format(p.value)}</span>
            <span className="text-ink-muted tabular-nums">{Math.round((p.value / total) * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Period picker

export const PERIOD_PRESETS = [
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
  { value: "6m", label: "6 months" },
  { value: "12m", label: "12 months" },
  { value: "fy", label: "This FY" },
  { value: "custom", label: "Custom" },
] as const;
export type PeriodPreset = (typeof PERIOD_PRESETS)[number]["value"];
export type Period = { preset: PeriodPreset; from: string; to: string };

const iso = (d: Date) => d.toISOString().slice(0, 10);
/** Resolve a preset to ISO from/to dates (to = today in India, so work done after midnight IST still counts). Indian FY starts 1 April. */
export function resolvePeriod(preset: PeriodPreset, custom?: { from: string; to: string }, today = new Date()): Period {
  // Shift to IST and read the UTC fields, so the dates match the server's IST day whatever the browser's time zone.
  const ist = new Date(today.getTime() + 330 * 60_000);
  const to = iso(ist);
  const d = new Date(ist);
  if (preset === "custom" && custom) return { preset, ...custom };
  if (preset === "30d") d.setUTCDate(d.getUTCDate() - 29);
  else if (preset === "90d") d.setUTCDate(d.getUTCDate() - 89);
  else if (preset === "6m") d.setUTCMonth(d.getUTCMonth() - 6);
  else if (preset === "12m") d.setUTCMonth(d.getUTCMonth() - 12);
  else if (preset === "fy") {
    const y = ist.getUTCMonth() >= 3 ? ist.getUTCFullYear() : ist.getUTCFullYear() - 1;
    return { preset, from: `${y}-04-01`, to };
  }
  return { preset, from: iso(d), to };
}

/** State hook for a period picker. Pass `period.from` / `period.to` to API calls as query params. */
export function usePeriod(initial: PeriodPreset = "90d") {
  const [period, setPeriod] = useState<Period>(() => resolvePeriod(initial));
  return { period, setPeriod };
}

/** Segmented presets plus from/to inputs for Custom. Also shows "vs previous period" context. */
export function PeriodPicker({ value, onChange }: { value: Period; onChange: (p: Period) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="inline-flex flex-wrap border border-border text-sm">
        {PERIOD_PRESETS.map((p) => (
          <button key={p.value} type="button" onClick={() => onChange(resolvePeriod(p.value, { from: value.from, to: value.to }))} className={`px-2.5 py-1.5 ${value.preset === p.value ? "bg-charcoal text-ivory" : "text-ink-muted hover:text-ink"}`}>
            {p.label}
          </button>
        ))}
      </div>
      {value.preset === "custom" && (
        <span className="flex items-center gap-1 text-sm">
          <input type="date" aria-label="From" value={value.from} max={value.to} onChange={(e) => onChange({ ...value, from: e.target.value })} className="border border-border bg-surface px-2 py-1" />
          <span className="text-ink-muted">to</span>
          <input type="date" aria-label="To" value={value.to} min={value.from} onChange={(e) => onChange({ ...value, to: e.target.value })} className="border border-border bg-surface px-2 py-1" />
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CSV export

/** Download rows as a CSV file (opens in Excel / Google Sheets). Values are written as shown. */
export function CsvButton<T>({ rows, columns, filename, label = "Export CSV" }: { rows: T[]; columns: { header: string; value: (row: T) => string | number | null | undefined }[]; filename: string; label?: string }) {
  const csv = useMemo(() => {
    const esc = (v: unknown) => {
      const s = v === null || v === undefined ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return [columns.map((c) => esc(c.header)).join(","), ...rows.map((r) => columns.map((c) => esc(c.value(r))).join(","))].join("\n");
  }, [rows, columns]);
  return (
    <button
      type="button"
      disabled={!rows.length}
      onClick={() => {
        const url = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
        const a = document.createElement("a");
        a.href = url;
        a.download = filename.endsWith(".csv") ? filename : `${filename}.csv`;
        a.click();
        URL.revokeObjectURL(url);
      }}
      className="border border-border px-3 py-1.5 text-sm text-ink-muted hover:text-ink disabled:opacity-40"
    >
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Small helpers

/** "▲ 12% vs previous" style delta for StatTile, or undefined when there is no comparison. */
export function deltaVs(current: number, previous: number | null | undefined, opts: { lowerIsBetter?: boolean } = {}) {
  if (previous === null || previous === undefined || previous === 0) return undefined;
  const change = ((current - previous) / Math.abs(previous)) * 100;
  const up = change >= 0;
  return { value: `${Math.abs(Math.round(change))}% vs previous`, up, good: opts.lowerIsBetter ? !up : up };
}

/** A plain-English insight line ("What this means"), shown under charts. */
export function Insight({ children, tone = "default" }: { children: ReactNode; tone?: "default" | "good" | "warn" }) {
  const bar = { default: "border-charcoal", good: "border-green", warn: "border-amber" }[tone];
  return <p className={`mt-4 border-l-2 ${bar} bg-canvas/50 px-3 py-2 text-sm text-ink`}>{children}</p>;
}
