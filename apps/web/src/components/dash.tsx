// Dashboard kit: quiet, minimal building blocks shared by every dashboard.
// Charcoal for data, green for the one thing to notice, amber/red only for problems.
import Link from "next/link";
import type { ReactNode } from "react";

type Tone = "default" | "good" | "warn" | "bad";
const toneText: Record<Tone, string> = { default: "text-ink", good: "text-[#5f8a12]", warn: "text-[#9a6b00]", bad: "text-[#b4432c]" };

/** Big number with a label, optional change and hint. Links when given an href. */
export function StatTile({ label, value, hint, delta, tone = "default", href }: { label: string; value: ReactNode; hint?: ReactNode; delta?: { value: string; up: boolean; good?: boolean }; tone?: Tone; href?: string }) {
  const body = (
    <>
      <p className="text-[13px] text-ink-muted">{label}</p>
      <p className={`mt-2 text-[28px] leading-none font-semibold tracking-tight tabular-nums ${toneText[tone]}`}>{value}</p>
      <div className="mt-2 flex min-h-4 items-center gap-2 text-xs text-ink-muted">
        {delta && <span className={(delta.good ?? delta.up) ? toneText.good : toneText.bad}>{delta.up ? "▲" : "▼"} {delta.value}</span>}
        {hint}
      </div>
    </>
  );
  const cls = "block bg-surface-raised p-5 transition-colors";
  return href ? (
    <Link href={href} className={`${cls} hover:bg-canvas/50`}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

/** A row of stat tiles separated by hairlines. */
export function StatRow({ children, cols = 4 }: { children: ReactNode; cols?: 2 | 3 | 4 | 5 }) {
  const c = { 2: "sm:grid-cols-2", 3: "sm:grid-cols-3", 4: "sm:grid-cols-2 lg:grid-cols-4", 5: "sm:grid-cols-3 lg:grid-cols-5" }[cols];
  return <div className={`grid gap-px border border-border bg-border ${c}`}>{children}</div>;
}

/** Titled block with an optional action on the right. */
export function Panel({ title, subtitle, action, children, className = "", flush = false }: { title?: string; subtitle?: string; action?: ReactNode; children: ReactNode; className?: string; flush?: boolean }) {
  return (
    <section className={`border border-border bg-surface-raised ${className}`}>
      {(title || action) && (
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div>
            {title && <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs text-ink-muted">{subtitle}</p>}
          </div>
          {action}
        </header>
      )}
      <div className={flush ? "" : "p-5"}>{children}</div>
    </section>
  );
}

/** Horizontal bars for comparing a few categories. Values are plain numbers; format controls the label. */
export function BarList({ items, format = (n) => String(n), max }: { items: { label: ReactNode; value: number; href?: string; highlight?: boolean; note?: ReactNode }[]; format?: (n: number) => string; max?: number }) {
  const top = max ?? Math.max(1, ...items.map((i) => i.value));
  if (!items.length) return <Empty>No data yet.</Empty>;
  return (
    <ul className="space-y-3">
      {items.map((i, k) => {
        const row = (
          <>
            <div className="mb-1 flex items-baseline justify-between gap-3 text-sm">
              <span className="truncate">{i.label}</span>
              <span className="shrink-0 tabular-nums text-ink-muted">
                {i.note && <span className="mr-2">{i.note}</span>}
                {format(i.value)}
              </span>
            </div>
            <div className="h-1.5 bg-canvas">
              <div className={`h-full ${i.highlight ? "bg-green" : "bg-charcoal"}`} style={{ width: `${Math.max(1.5, (i.value / top) * 100)}%` }} />
            </div>
          </>
        );
        return <li key={k}>{i.href ? <Link href={i.href} className="block hover:opacity-80">{row}</Link> : row}</li>;
      })}
    </ul>
  );
}

/** Vertical columns over time (e.g. revenue by month). The last column is highlighted. */
export function ColumnChart({ data, format = (n) => String(n), height = 160, highlightLast = true }: { data: { label: string; value: number; secondary?: number }[]; format?: (n: number) => string; height?: number; highlightLast?: boolean }) {
  if (!data.length) return <Empty>No data yet.</Empty>;
  const top = Math.max(1, ...data.map((d) => Math.max(d.value, d.secondary ?? 0)));
  return (
    <div>
      <div className="flex items-end gap-2" style={{ height }} role="img" aria-label={data.map((d) => `${d.label}: ${format(d.value)}`).join(", ")}>
        {data.map((d, i) => (
          <div key={d.label} className="group relative flex h-full flex-1 items-end justify-center gap-0.5">
            {d.secondary !== undefined && <div className="w-full max-w-5 bg-grey/60" style={{ height: `${(d.secondary / top) * 100}%` }} />}
            <div className={`w-full max-w-7 ${highlightLast && i === data.length - 1 ? "bg-green" : "bg-charcoal"}`} style={{ height: `${Math.max(d.value ? 2 : 0, (d.value / top) * 100)}%` }} />
            <span className="pointer-events-none absolute -top-6 hidden whitespace-nowrap bg-charcoal px-1.5 py-0.5 text-[11px] text-ivory group-hover:block">{format(d.value)}</span>
          </div>
        ))}
      </div>
      <div className="mt-2 flex gap-2 border-t border-border pt-2">
        {data.map((d) => (
          <span key={d.label} className="flex-1 truncate text-center text-[11px] text-ink-muted">
            {d.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Tiny inline trend line. */
export function Sparkline({ values, width = 96, height = 28 }: { values: number[]; width?: number; height?: number }) {
  if (values.length < 2) return null;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * width},${height - ((v - min) / (max - min || 1)) * (height - 2) - 1}`).join(" ");
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden>
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

/** Thin progress meter, 0–100. */
export function Meter({ value, tone = "default", label, suffix = "%" }: { value: number; tone?: Tone; label?: string; suffix?: string }) {
  const bg = { default: "bg-charcoal", good: "bg-green", warn: "bg-amber", bad: "bg-red" }[tone];
  return (
    <div className="flex items-center gap-2" title={label}>
      <div className="h-1.5 flex-1 bg-canvas">
        <div className={`h-full ${bg}`} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
      </div>
      <span className="w-10 text-right text-xs tabular-nums text-ink-muted">{Math.round(value)}{suffix}</span>
    </div>
  );
}

/** Stacked share bar with a legend (e.g. pipeline by stage, aging buckets). */
export function StackBar({ parts, format = (n) => String(n) }: { parts: { label: string; value: number; tone?: "dark" | "green" | "grey" | "amber" | "red" | "muted" }[]; format?: (n: number) => string }) {
  const total = parts.reduce((s, p) => s + p.value, 0);
  const bg = { dark: "bg-charcoal", green: "bg-green", grey: "bg-grey", amber: "bg-amber", red: "bg-red", muted: "bg-muted" };
  return (
    <div>
      <div className="flex h-2.5 w-full overflow-hidden bg-canvas">
        {total > 0 && parts.map((p) => (p.value ? <div key={p.label} className={bg[p.tone ?? "dark"]} style={{ flex: p.value }} title={`${p.label}: ${format(p.value)}`} /> : null))}
      </div>
      <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-xs text-ink-muted">
        {parts.map((p) => (
          <li key={p.label} className="flex items-center gap-1.5">
            <span className={`inline-block h-2 w-2 ${bg[p.tone ?? "dark"]}`} />
            {p.label} <span className="font-medium text-ink tabular-nums">{format(p.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export type Column<T> = { key: string; header: ReactNode; cell: (row: T) => ReactNode; align?: "left" | "right"; className?: string };

/** Minimal table: uppercase hairline header, roomy rows, optional row link. */
export function DataTable<T>({ rows, columns, rowKey, rowHref, empty = "Nothing here yet." }: { rows: T[]; columns: Column<T>[]; rowKey: (row: T) => string; rowHref?: (row: T) => string | undefined; empty?: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-[11px] uppercase tracking-[0.1em] text-ink-muted">
            {columns.map((c) => (
              <th key={c.key} className={`px-4 py-2.5 font-medium whitespace-nowrap ${c.align === "right" ? "text-right" : "text-left"}`}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const href = rowHref?.(r);
            return (
              <tr key={rowKey(r)} className="border-b border-border last:border-0 hover:bg-canvas/40">
                {columns.map((c, i) => (
                  <td key={c.key} className={`px-4 py-3 align-middle ${c.align === "right" ? "text-right tabular-nums" : ""} ${c.className ?? ""}`}>
                    {href && i === 0 ? (
                      <Link href={href} className="font-medium hover:underline">
                        {c.cell(r)}
                      </Link>
                    ) : (
                      c.cell(r)
                    )}
                  </td>
                ))}
              </tr>
            );
          })}
          {rows.length === 0 && (
            <tr>
              <td colSpan={columns.length} className="px-4 py-10 text-center text-ink-muted">
                {empty}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-sm text-ink-muted">{children}</p>;
}

/** Segmented tabs (client-side state is handled by the caller). */
export function Tabs<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex border border-border text-sm">
      {options.map((o) => (
        <button key={o.value} onClick={() => onChange(o.value)} className={`px-3 py-1.5 ${o.value === value ? "bg-charcoal text-ivory" : "text-ink-muted hover:text-ink"}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Two-column grid for dashboard panels. */
export function Grid({ children, cols = 2 }: { children: ReactNode; cols?: 2 | 3 }) {
  return <div className={`grid gap-6 ${cols === 3 ? "lg:grid-cols-3" : "lg:grid-cols-2"}`}>{children}</div>;
}

/** Key/value list used in detail panels and settings summaries. */
export function KeyValues({ items }: { items: { k: ReactNode; v: ReactNode }[] }) {
  return (
    <dl className="divide-y divide-border text-sm">
      {items.map((i, n) => (
        <div key={n} className="flex items-baseline justify-between gap-4 py-2.5">
          <dt className="text-ink-muted">{i.k}</dt>
          <dd className="text-right font-medium">{i.v}</dd>
        </div>
      ))}
    </dl>
  );
}
