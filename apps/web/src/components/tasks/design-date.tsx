"use client";

/**
 * v54 redesign: a date field whose calendar is a frosted-glass card (the browser's own date picker can't be styled).
 * Look only: same value ("YYYY-MM-DD", or "" for none) and same change as the <input type="date"> it replaces, so
 * the flow is unchanged. Clear empties it, like deleting the date in the old field.
 * Keys: arrows move a day/week, PageUp/PageDown a month, Home/End the week's start/end, Enter picks, Escape closes.
 * With rangeStart/rangeEnd it shades the days between them (Due from … to).
 *
 *   <DesignDate value={filters.from} onChange={(v) => set({ from: v })} aria-label="Due from" className={designField} />
 */
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { designFont } from "./task-design";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const SHORT_MONTHS = MONTHS.map((m) => m.slice(0, 3));
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

const pad = (n: number) => String(n).padStart(2, "0");
const toIso = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`;
/** "2026-11-27" → { y: 2026, m: 10, d: 27 } (month from 0), read as a calendar day with no time zone shift. */
function parse(iso: string | undefined): { y: number; m: number; d: number } | null {
  const hit = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? "");
  return hit ? { y: Number(hit[1]), m: Number(hit[2]) - 1, d: Number(hit[3]) } : null;
}
const daysIn = (y: number, m: number) => new Date(y, m + 1, 0).getDate();
/** Monday = 0 … Sunday = 6. */
const weekday = (y: number, m: number, d: number) => (new Date(y, m, d).getDay() + 6) % 7;
function todayParts() {
  const t = new Date();
  return { y: t.getFullYear(), m: t.getMonth(), d: t.getDate() };
}
/** Moves a day by n days (crosses months and years). */
function shift(p: { y: number; m: number; d: number }, n: number) {
  const t = new Date(p.y, p.m, p.d + n);
  return { y: t.getFullYear(), m: t.getMonth(), d: t.getDate() };
}
function shiftMonth(p: { y: number; m: number; d: number }, n: number) {
  const first = new Date(p.y, p.m + n, 1);
  const y = first.getFullYear();
  const m = first.getMonth();
  return { y, m, d: Math.min(p.d, daysIn(y, m)) };
}

type Place = { left: number; width: number; top: number; maxHeight: number };

export function DesignDate({
  value,
  onChange,
  className = "",
  title,
  rangeStart,
  rangeEnd,
  placeholder = "Select date",
  "aria-label": ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  className?: string;
  title?: string;
  rangeStart?: string;
  rangeEnd?: string;
  placeholder?: string;
  "aria-label": string;
}) {
  const picked = parse(value);
  const today = todayParts();
  const [open, setOpen] = useState(false);
  const [focus, setFocus] = useState(picked ?? today);
  const [place, setPlace] = useState<Place>();
  const field = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const id = useId();

  const show = () => {
    setFocus(picked ?? todayParts());
    setOpen(true);
  };
  const close = (backToField = true) => {
    setOpen(false);
    setPlace(undefined);
    if (backToField) field.current?.focus();
  };
  const pick = (iso: string) => {
    close();
    if (iso !== value) onChange(iso);
  };

  // Hari's rule: the calendar opens to the LEFT of the field, centred on it, so the field (and its icon) stays in view;
  // kept fully on screen. Where there is no room on the left (a phone), it opens under the field if it fits, else
  // above, else slid just enough to stay on screen. Uses the calendar's real height; very short screens scroll inside.
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const r = field.current?.getBoundingClientRect();
      if (!r) return;
      const gap = 12;
      const width = Math.min(320, window.innerWidth - gap * 2);
      const maxHeight = window.innerHeight - gap * 2;
      const h = Math.min(card.current?.scrollHeight ?? 400, maxHeight);
      const fitTop = (t: number) => Math.max(gap, Math.min(t, window.innerHeight - gap - h));
      if (r.left - 10 - width >= gap) {
        setPlace({ left: r.left - 10 - width, width, top: fitTop(r.top + r.height / 2 - h / 2), maxHeight });
        return;
      }
      const left = Math.max(gap, Math.min(r.left, window.innerWidth - width - gap));
      let top: number;
      if (r.bottom + 6 + h <= window.innerHeight - gap) top = r.bottom + 6;
      else if (r.top - 6 - h >= gap) top = r.top - 6 - h;
      else if (r.height + 6 + h <= window.innerHeight - gap * 2) {
        // Fits neither way (a phone, field mid-screen): scroll the field to the top; the scroll re-places it below.
        window.scrollBy({ top: r.top - gap });
        top = gap + r.height + 6;
      } else top = Math.max(gap, window.innerHeight - gap - h);
      setPlace({ left, width, top, maxHeight });
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open]);

  // A click anywhere else closes it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!field.current?.contains(t) && !card.current?.contains(t)) {
        setOpen(false);
        setPlace(undefined);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // The highlighted day takes the keyboard focus (after opening and after every arrow key).
  useEffect(() => {
    if (open && place) card.current?.querySelector<HTMLButtonElement>(`[data-day="${toIso(focus.y, focus.m, focus.d)}"]`)?.focus();
  }, [open, place, focus]);

  const onGridKey = (e: React.KeyboardEvent) => {
    const moves: Record<string, () => { y: number; m: number; d: number }> = {
      ArrowLeft: () => shift(focus, -1),
      ArrowRight: () => shift(focus, 1),
      ArrowUp: () => shift(focus, -7),
      ArrowDown: () => shift(focus, 7),
      PageUp: () => shiftMonth(focus, -1),
      PageDown: () => shiftMonth(focus, 1),
      Home: () => shift(focus, -weekday(focus.y, focus.m, focus.d)),
      End: () => shift(focus, 6 - weekday(focus.y, focus.m, focus.d)),
    };
    const move = moves[e.key];
    if (move) {
      e.preventDefault();
      setFocus(move());
    }
  };
  const onCardKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      // Close only the calendar, not the dialog it sits in.
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

  const range = rangeStart && rangeEnd && rangeStart < rangeEnd ? [rangeStart, rangeEnd] : null;
  const lead = weekday(focus.y, focus.m, 1);
  const count = daysIn(focus.y, focus.m);
  const cells: (number | null)[] = [...Array<null>(lead).fill(null), ...Array.from({ length: count }, (_, i) => i + 1)];
  const todayIso = toIso(today.y, today.m, today.d);
  const label = picked ? `${pad(picked.d)} ${SHORT_MONTHS[picked.m]} ${picked.y}` : "";

  return (
    <>
      <button
        ref={field}
        type="button"
        aria-label={label ? `${ariaLabel}: ${label}` : ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={title}
        onClick={() => (open ? close(false) : show())}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            show();
          }
        }}
        className={`design-date-button flex items-center justify-between gap-2 text-left ${className}`}
        data-value={value}
      >
        <span className={`min-w-0 truncate ${label ? "" : "text-ink-muted"}`}>{label || placeholder}</span>
        <svg aria-hidden viewBox="0 0 20 20" className="h-4 w-4 shrink-0 text-ink-muted" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="4.5" width="14" height="12.5" rx="3" />
          <path d="M3 8.5h14M7 2.75v3.5M13 2.75v3.5" />
        </svg>
      </button>
      {open &&
        createPortal(
          <div
            ref={card}
            role="dialog"
            aria-label={`${ariaLabel}: choose a date`}
            onKeyDown={onCardKey}
            className={`design-date-calendar design-glass-menu fixed z-[90] overflow-y-auto p-4! text-sm text-ink ${designFont}`}
            // First drawn hidden so its height can be measured, then placed.
            style={place ? { left: place.left, width: place.width, top: place.top, maxHeight: place.maxHeight, borderRadius: 24 } : { left: 0, top: 0, width: 320, visibility: "hidden", borderRadius: 24 }}
          >
            <div className="design-date-header mb-3 flex items-center justify-between gap-2">
              <p className="text-lg font-semibold tracking-tight" id={`${id}-month`} aria-live="polite">
                {MONTHS[focus.m]} {focus.y}
              </p>
              <div className="flex gap-1.5">
                <button type="button" aria-label="Previous month" onClick={() => setFocus(shiftMonth(focus, -1))} className="design-date-nav flex h-8 w-8 items-center justify-center rounded-full bg-ui-accent-soft hover:bg-ui-accent hover:text-ui-accent-ink">
                  <svg aria-hidden viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M10 4L6 8l4 4" />
                  </svg>
                </button>
                <button type="button" aria-label="Next month" onClick={() => setFocus(shiftMonth(focus, 1))} className="design-date-nav flex h-8 w-8 items-center justify-center rounded-full bg-ui-accent-soft hover:bg-ui-accent hover:text-ui-accent-ink">
                  <svg aria-hidden viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M6 4l4 4-4 4" />
                  </svg>
                </button>
              </div>
            </div>
            <div role="grid" aria-labelledby={`${id}-month`} onKeyDown={onGridKey} className="design-date-grid grid grid-cols-7 gap-y-1 text-center">
              {WEEKDAYS.map((w) => (
                <span key={w} role="columnheader" className="pb-1 text-xs font-medium text-ink-muted">
                  {w}
                </span>
              ))}
              {cells.map((d, i) => {
                if (d == null) return <span key={`blank-${i}`} aria-hidden />;
                const iso = toIso(focus.y, focus.m, d);
                const col = i % 7;
                const isPicked = iso === value;
                const inRange = range ? iso >= range[0] && iso <= range[1] : false;
                const bandStart = inRange && (iso === range![0] || col === 0 || d === 1);
                const bandEnd = inRange && (iso === range![1] || col === 6 || d === count);
                return (
                  <span key={iso} role="gridcell" className={`design-date-cell flex justify-center py-0.5 ${inRange ? "bg-[var(--ui-status-todo)]" : ""} ${bandStart ? "rounded-l-full" : ""} ${bandEnd ? "rounded-r-full" : ""}`}>
                    <button
                      type="button"
                      data-day={iso}
                      tabIndex={d === focus.d ? 0 : -1}
                      aria-pressed={isPicked}
                      aria-label={`${WEEKDAY_NAMES[col]} ${d} ${MONTHS[focus.m]} ${focus.y}`}
                      onClick={() => pick(iso)}
                      className={`design-date-day flex h-9 w-9 items-center justify-center rounded-full tabular-nums transition-colors ${
                        isPicked ? "bg-ui-accent font-semibold text-ui-accent-ink shadow-[0_6px_16px_-6px_rgba(140,198,63,0.7)]" : iso === todayIso ? "font-semibold ring-1 ring-ui-accent hover:bg-ui-accent-soft" : "hover:bg-ui-accent-soft"
                      }`}
                    >
                      {d}
                    </button>
                  </span>
                );
              })}
            </div>
            <div className="design-date-footer mt-3 flex items-center justify-between border-t border-[var(--ui-glass-edge)] pt-3 text-sm">
              <button type="button" onClick={() => pick("")} className="rounded-full px-3 py-1 text-ink-muted hover:bg-ui-accent-soft hover:text-ink">
                Clear
              </button>
              <button type="button" onClick={() => pick(todayIso)} className="rounded-full px-3 py-1 font-medium hover:bg-ui-accent-soft">
                Today
              </button>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
