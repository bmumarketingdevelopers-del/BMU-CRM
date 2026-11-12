import type { ReactNode } from "react";

/** Funnel icon used on every filter box. */
export function FilterIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={`shrink-0 ${className}`} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden>
      <path d="M3 5h18l-7 8.5V19l-4 2v-7.5L3 5z" />
    </svg>
  );
}

/**
 * The filter box used across the CRM: always open (no click needed to see the options), headed by a funnel icon,
 * "Filters" and how many are on. Put the filter fields inside as children; `grid` sets their layout.
 */
export function FilterPanel({
  active = 0,
  children,
  grid = "grid gap-2 sm:grid-cols-2 lg:grid-cols-4",
  className = "",
  testId,
}: {
  active?: number;
  children: ReactNode;
  grid?: string;
  className?: string;
  testId?: string;
}) {
  return (
    <section className={`border border-border bg-surface-raised ${className}`} aria-label="Filters" data-testid={testId}>
      <p className="flex items-center gap-2 px-3 pt-2.5 pb-2 text-sm font-medium">
        <FilterIcon className="h-4 w-4 text-ink-muted" />
        Filters
        {active > 0 && <span className="bg-green/15 px-1.5 text-xs font-normal">{active} on</span>}
      </p>
      <div className={`px-3 pb-3 ${grid}`}>{children}</div>
    </section>
  );
}
