"use client";

// v54 redesign (Tasks first, then the rest of the team app). The page colour fills the whole work area (globals.css:
// main:has([data-design-page])), outer layers are frosted glass, inner cards are solid, pills glow like the website's
// buttons in the dark theme. Colours come only from the --ui-* names in globals.css, so every piece follows light and
// dark. Look only: no data or behaviour lives here.
import { outfit } from "@/lib/design-font";
import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from "react";

/** The redesign's font (picked by Hari): Outfit (lib/design-font.ts), only in the redesign preview. */
/** The redesign font for pieces that open outside the page (dropdown lists). */
export const designFont = outfit.className;

/** Marks a redesigned page: its colour then fills the whole work area, edge to edge (no card inside a card). */
export function DesignPage({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    // Any piece below that asks for the app font (font-sans / font-display) gets Outfit too.
    <div className={`design-page ${outfit.variable} ${outfit.className}`} style={{ "--font-albert-sans": "var(--font-outfit)" } as CSSProperties} data-design-page data-testid={testId}>
      {children}
    </div>
  );
}

/** Frosted glass: the outer layers (board columns, filters, tables, pill tracks). */
export const designGlass = "design-glass-panel rounded-3xl";

/** Solid card: the inner layers that sit on the glass (task cards). */
export const designCard = "design-solid-card rounded-3xl border border-ui-card-border [background:var(--ui-card-fill)] shadow-[var(--ui-card-shadow)]";

/** Rounded input / select / date field. */
export const designField =
  "design-field h-10 w-full rounded-full border border-[var(--ui-glass-border)] bg-[var(--ui-field)] px-4 text-sm text-ink outline-none backdrop-blur-md transition-colors placeholder:text-ink-muted focus:border-ui-accent";

/** Soft glass pill button (Views, Export, From template…). */
export const softPill =
  "design-soft-pill inline-flex h-10 items-center gap-1.5 rounded-full border border-[var(--ui-glass-border)] bg-[var(--ui-glass)] px-4 text-sm font-medium text-ui-pill-ink shadow-[var(--ui-glass-shadow)] backdrop-blur-xl transition-colors hover:bg-ui-accent-soft disabled:opacity-40";

/** The look of the main action and of an active pill: ink in light; the website's dark pill with a green glow in dark. */
const primaryLook = "border border-[var(--ui-primary-border)] [background:var(--ui-primary-fill)] text-ui-pill-active-ink shadow-[var(--ui-primary-shadow)]";

/** The main action ("+ Add task"). */
export function PrimaryPill({ children, className = "", ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" {...rest} className={`design-primary-pill inline-flex h-10 items-center gap-2 rounded-full px-5 text-sm font-semibold transition-opacity hover:opacity-90 disabled:opacity-40 ${primaryLook} ${className}`}>
      {children}
    </button>
  );
}

/** A row of pill buttons in one glass track; the active ones are filled (Mine / Everything I can see / Completed). */
export function PillGroup({ children, label }: { children: ReactNode; label: string }) {
  return (
    // One line always; on a narrow phone the track scrolls sideways inside itself instead of wrapping.
    <div
      className="design-pill-group inline-flex max-w-full shrink-0 flex-nowrap items-center gap-1 overflow-x-auto rounded-full border border-[var(--ui-glass-border)] bg-[var(--ui-glass)] p-1 shadow-[var(--ui-glass-shadow)] backdrop-blur-xl [scrollbar-width:none]"
      role="group"
      aria-label={label}
    >
      {children}
    </div>
  );
}

export function PillToggle({ active, children, className = "", ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { active: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      {...rest}
      className={`design-pill-toggle h-8 rounded-full px-4 text-sm font-medium whitespace-nowrap transition-colors ${active ? primaryLook : "border border-transparent text-ui-pill-ink hover:bg-ui-accent-soft"} ${className}`}
    >
      {children}
    </button>
  );
}

/** A big number with its label (To do 12 · Overdue 1…), with an optional small badge. */
export function StatTile({ value, label, badge, tone = "default", testId }: { value: number | string; label: string; badge?: string; tone?: "default" | "warn" | "accent"; testId?: string }) {
  return (
    <div className="design-stat-tile min-w-0" data-testid={testId}>
      <div className="flex items-start gap-2">
        <span className={`text-4xl leading-none font-semibold tracking-tight tabular-nums sm:text-5xl ${tone === "warn" ? "text-ui-danger" : "design-heading-fill"}`}>{value}</span>
        {badge && <span className={`mt-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${tone === "accent" ? "bg-ui-accent text-ui-accent-ink" : "bg-ui-accent-soft text-ink"}`}>{badge}</span>}
      </div>
      <p className="mt-1.5 text-sm text-ink-muted">{label}</p>
    </div>
  );
}

const statusBg: Record<string, string> = {
  todo: "bg-ui-status-todo",
  in_progress: "bg-ui-status-progress",
  in_qc: "bg-ui-status-progress",
  waiting: "bg-ui-status-waiting",
  blocked: "bg-ui-status-blocked",
  done: "bg-ui-status-done",
  cancelled: "bg-ui-status-todo",
};

/** The task's status as a rounded pill, tinted by status. */
export function StatusPill({ status, label }: { status: string; label: string }) {
  return <span className={`design-status-pill inline-flex shrink-0 items-center rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap text-ink ${statusBg[status] ?? "bg-ui-status-todo"}`}>{label}</span>;
}

/** A person's initials in a soft circle (no photos needed). */
export function InitialsAvatar({ name, size = "sm" }: { name: string | null | undefined; size?: "sm" | "md" }) {
  const initials = (name ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
  return (
    <span className={`design-initials-avatar inline-flex shrink-0 items-center justify-center rounded-full bg-ui-accent-soft font-semibold text-ink ${size === "md" ? "h-9 w-9 text-sm" : "h-7 w-7 text-[11px]"}`} aria-hidden>
      {initials || "–"}
    </span>
  );
}
