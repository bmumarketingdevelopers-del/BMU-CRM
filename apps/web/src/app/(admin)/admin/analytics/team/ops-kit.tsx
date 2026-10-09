"use client";
// Helpers shared by the v9 operations analytics pages (team, delivery, SLA, report builder, my performance,
// client insights): period-aware loading, insight lines, sortable table headers and number formats.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { formatINR, type OpsCompare, type OpsInsight, type OpsRange } from "@bmu/shared";
import { Insight, PeriodPicker, deltaVs, type Period } from "@/components/charts";
import { PageTitle } from "@/components/ui";

// ---------------------------------------------------------------------------
// Loading that follows the period picker

export type PeriodState<T> = { data?: T; error?: string; loading: boolean; reload: () => void };

/** Loads data for the current period (and any extra keys); keeps the last data on screen while it refreshes. */
export function usePeriodData<T>(load: () => Promise<T>, keys: unknown[]): PeriodState<T> {
  const loader = useRef(load);
  useEffect(() => {
    loader.current = load;
  });
  const [nonce, setNonce] = useState(0);
  const want = `${JSON.stringify(keys)}#${nonce}`;
  const [state, setState] = useState<{ key?: string; data?: T; error?: string }>({});
  useEffect(() => {
    let live = true;
    loader.current().then(
      (data) => live && setState({ key: want, data }),
      (e: Error) => live && setState((s) => ({ ...s, key: want, error: e.message })),
    );
    return () => {
      live = false;
    };
  }, [want]);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const current = state.key === want;
  return { data: state.data, error: current ? state.error : undefined, loading: !current, reload };
}

/** Page frame: title, plain subtitle, period picker (plus filters), then loading / error / body. */
export function OpsPage<T>({
  title,
  subtitle,
  period,
  onPeriod,
  filters,
  state,
  children,
}: {
  title: string;
  subtitle: string;
  period: Period;
  onPeriod: (p: Period) => void;
  filters?: ReactNode;
  state: PeriodState<T>;
  children: (data: T) => ReactNode;
}) {
  return (
    <>
      <PageTitle title={title} subtitle={subtitle} />
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <PeriodPicker value={period} onChange={onPeriod} />
        {filters}
        {state.loading && state.data !== undefined && <span className="text-xs text-ink-muted">Updating…</span>}
      </div>
      {state.error && (
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 border border-red bg-red/10 px-4 py-3 text-sm">
          <span>{state.error}</span>
          <button type="button" onClick={state.reload} className="underline">
            Try again
          </button>
        </div>
      )}
      {state.data === undefined ? state.loading ? <OpsSkeleton /> : null : children(state.data)}
    </>
  );
}

export function OpsSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading">
      <div className="grid gap-px border border-border bg-border sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-28 animate-pulse bg-surface-raised" />
        ))}
      </div>
      <div className="h-64 animate-pulse border border-border bg-surface-raised" />
    </div>
  );
}

export function InsightList({ items }: { items: OpsInsight[] }) {
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

/** "Compared with 1 Apr – 30 Jun" line under the stat row. */
export function RangeNote({ range }: { range: OpsRange }) {
  return (
    <p className="mt-2 text-xs text-ink-muted">
      {fmtDay(range.from)} – {fmtDay(range.to)}, compared with {fmtDay(range.prevFrom)} – {fmtDay(range.prevTo)}.
    </p>
  );
}

// ---------------------------------------------------------------------------
// Sorting

export type SortDir = "asc" | "desc";

/** Sort state for a table; returns sorted rows and a header renderer that toggles the sort. */
export function useSort<T>(rows: T[], initial: { key: string; dir: SortDir }, getters: Record<string, (r: T) => number | string | null>) {
  const [sort, setSort] = useState(initial);
  const sorted = useMemo(() => {
    const get = getters[sort.key];
    if (!get) return rows;
    return [...rows].sort((a, b) => {
      const x = get(a);
      const y = get(b);
      if (x === y) return 0;
      if (x === null) return 1;
      if (y === null) return -1;
      const c = typeof x === "string" && typeof y === "string" ? x.localeCompare(y) : (x as number) - (y as number);
      return sort.dir === "asc" ? c : -c;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, sort]);
  const header = (key: string, label: ReactNode) => (
    <button
      type="button"
      onClick={() => setSort((s) => ({ key, dir: s.key === key && s.dir === "desc" ? "asc" : "desc" }))}
      className={`inline-flex items-center gap-1 uppercase tracking-[0.1em] hover:text-ink ${sort.key === key ? "text-ink" : ""}`}
      aria-label={`Sort by ${typeof label === "string" ? label : key}`}
    >
      {label}
      <span aria-hidden className="text-[9px]">
        {sort.key === key ? (sort.dir === "desc" ? "▼" : "▲") : "↕"}
      </span>
    </button>
  );
  return { sorted, header };
}

// ---------------------------------------------------------------------------
// Formats

const dayFmt = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
const dtFmt = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });
const shortFmt = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });
export const fmtDay = (iso: string | null | undefined) => (iso ? dayFmt.format(new Date(iso.length === 10 ? `${iso}T00:00:00+05:30` : iso)) : "—");
export const fmtDateTime = (iso: string | null | undefined) => (iso ? dtFmt.format(new Date(iso)) : "—");
export const fmtShort = (iso: string | null | undefined) => (iso ? shortFmt.format(new Date(iso)) : "—");
export const pctText = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${Math.round(n)}%`);
export const daysText = (n: number | null | undefined, unit = "days") => (n === null || n === undefined ? "—" : `${n} ${unit}`);
export const num = (n: number | null | undefined) => (n === null || n === undefined ? "—" : new Intl.NumberFormat("en-IN", { maximumFractionDigits: 1 }).format(n));
export function minutesText(min: number | null | undefined) {
  if (min === null || min === undefined) return "—";
  const m = Math.round(min);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}
export const inr = formatINR;
/** Short rupee labels for charts: ₹4.5L, ₹85k. */
export function inrShort(paise: number) {
  const r = paise / 100;
  const a = Math.abs(r);
  const sign = r < 0 ? "-" : "";
  if (a >= 1e7) return `${sign}₹${(a / 1e7).toFixed(1)}Cr`;
  if (a >= 1e5) return `${sign}₹${(a / 1e5).toFixed(1)}L`;
  if (a >= 1e3) return `${sign}₹${Math.round(a / 1e3)}k`;
  return `${sign}₹${Math.round(a)}`;
}

/** StatTile delta from a value/previous pair. */
export const deltaOf = (c: OpsCompare, opts: { lowerIsBetter?: boolean } = {}) => (c.value === null ? undefined : deltaVs(c.value, c.prev, opts));
/** "was 72%" hint for a stat tile. */
export const wasText = (prev: number | null, fmt: (n: number) => string) => (prev === null ? "no data before" : `was ${fmt(prev)}`);

/** Tone for a load or utilisation percentage. */
export const loadTone = (pct: number) => (pct > 100 ? "bad" : pct >= 85 ? "warn" : "default");
