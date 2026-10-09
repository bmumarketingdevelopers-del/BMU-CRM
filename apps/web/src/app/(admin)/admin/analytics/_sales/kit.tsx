"use client";
// Shared pieces for the sales & money analytics pages (Scorecard, Funnel, Forecast, Retention, Profitability).
import { useEffect, useState, type ReactNode } from "react";
import type { SalesInsight, SalesKpiUnit, SalesPeriod } from "@bmu/shared";
import { Insight, PeriodPicker, usePeriod, type Period } from "@/components/charts";
import { PageTitle } from "@/components/ui";
import { fmtDate, inr, inrShort } from "../../_insights/kit";

export { Field, FormNote, WithData, fmtDate, inr, inrShort } from "../../_insights/kit";

/** Page frame with title, plain subtitle and the period picker; the body re-mounts when the period changes. */
export function PeriodPage({ title, subtitle, children, extra }: { title: string; subtitle: string; children: (p: Period) => ReactNode; extra?: ReactNode }) {
  const { period, setPeriod } = usePeriod("90d");
  return (
    <>
      <PageTitle
        title={title}
        subtitle={subtitle}
        action={
          extra ? (
            <div className="flex flex-wrap items-center gap-4">
              {extra}
              <PeriodPicker value={period} onChange={setPeriod} />
            </div>
          ) : (
            <PeriodPicker value={period} onChange={setPeriod} />
          )
        }
      />
      <div key={`${period.from}_${period.to}`}>{children(period)}</div>
    </>
  );
}

/** "1 Jul – 28 Sep 2026, compared with 2 Apr – 30 Jun 2026". */
export function PeriodLine({ period }: { period: SalesPeriod }) {
  return (
    <p className="-mt-4 text-sm text-ink-muted">
      {fmtDate(period.from)} – {fmtDate(period.to)} <span className="text-ink-muted/80">· compared with {fmtDate(period.prevFrom)} – {fmtDate(period.prevTo)}</span>
    </p>
  );
}

/** Computed insight sentences from the server. */
export function Insights({ items }: { items: SalesInsight[] }) {
  if (!items.length) return null;
  return (
    <div className="space-y-2 [&>p]:mt-0">
      {items.map((i, k) => (
        <Insight key={k} tone={i.tone}>
          {i.text}
        </Insight>
      ))}
    </div>
  );
}

export function fmtValue(unit: SalesKpiUnit, v: number | null | undefined, short = false) {
  if (v === null || v === undefined) return "—";
  if (unit === "paise") return short ? inrShort(v) : inr(v);
  if (unit === "pct") return `${Math.round(v)}%`;
  if (unit === "days") return `${Math.round(v)} day${Math.round(v) === 1 ? "" : "s"}`;
  if (unit === "ratio") return `${v.toFixed(1)}×`;
  return String(Math.round(v));
}

/** Change for a StatTile. Percentages compare in points; money and counts in % of the previous value. */
export function change(current: number | null | undefined, previous: number | null | undefined, opts: { unit?: SalesKpiUnit; lowerIsBetter?: boolean } = {}) {
  if (current === null || current === undefined || previous === null || previous === undefined) return undefined;
  if (opts.unit === "pct") {
    const d = Math.round(current - previous);
    if (d === 0) return { value: "same as before", up: true, good: true };
    return { value: `${Math.abs(d)} pts vs previous`, up: d > 0, good: opts.lowerIsBetter ? d < 0 : d > 0 };
  }
  if (previous === 0) return undefined;
  const pctChange = ((current - previous) / Math.abs(previous)) * 100;
  if (Math.round(pctChange) === 0) return { value: "same as before", up: true, good: true };
  const up = pctChange > 0;
  return { value: `${Math.abs(Math.round(pctChange))}% vs previous`, up, good: opts.lowerIsBetter ? !up : up };
}

export const hours = (h: number | null | undefined) => (h === null || h === undefined ? "—" : `${h.toLocaleString("en-IN", { maximumFractionDigits: 1 })} h`);
export const rupees = (paise: number) => Math.round(paise / 100);

/** Watches location.hash (e.g. "#stage-won") so chart links can filter a table on the same page. */
export function useHash(scrollTo?: string) {
  const [hash, setHash] = useState("");
  useEffect(() => {
    const read = () => setHash(window.location.hash.replace(/^#/, ""));
    const changed = () => {
      read();
      if (scrollTo) document.getElementById(scrollTo)?.scrollIntoView({ behavior: "smooth", block: "start" });
    };
    read();
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, [scrollTo]);
  return hash;
}

/** Click-to-sort header for DataTable columns. */
export function SortHeader<K extends string>({ label, k, sort, onSort }: { label: string; k: K; sort: { key: K; dir: 1 | -1 }; onSort: (s: { key: K; dir: 1 | -1 }) => void }) {
  const active = sort.key === k;
  return (
    <button type="button" className={`uppercase tracking-[0.1em] ${active ? "text-ink" : ""}`} onClick={() => onSort({ key: k, dir: active ? (sort.dir === 1 ? -1 : 1) : -1 })}>
      {label}
      {active ? (sort.dir === -1 ? " ↓" : " ↑") : ""}
    </button>
  );
}
