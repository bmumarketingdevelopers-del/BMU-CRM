"use client";

/**
 * v54 redesign: a dropdown whose open list is a frosted-glass card (a native <select> list can't be styled).
 * Look only: it takes the same <option> children, value and change as the <select> it replaces, so the flow is
 * unchanged. Works like a native one: click, arrow keys, Home/End, Enter/Space to pick, Escape to close, type a
 * letter to jump. The list opens in a layer above everything (also above pop-up dialogs) and flips up when there is
 * no room below.
 *
 *   <DesignSelect value={status} onChange={setStatus} aria-label="Status" className={designField}>
 *     <option value="">Any status</option>
 *   </DesignSelect>
 */
import { Children, isValidElement, useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { designFont } from "./task-design";

type Choice = { value: string; label: ReactNode; text: string; disabled?: boolean };

function textOf(n: ReactNode): string {
  if (n == null || typeof n === "boolean") return "";
  if (typeof n === "string" || typeof n === "number") return String(n);
  if (Array.isArray(n)) return n.map(textOf).join("");
  if (isValidElement(n)) return textOf((n.props as { children?: ReactNode }).children);
  return "";
}

/** Reads the <option> children (arrays and `cond && <option>` are fine). */
function readChoices(children: ReactNode): Choice[] {
  const out: Choice[] = [];
  for (const c of Children.toArray(children)) {
    if (!isValidElement(c) || c.type !== "option") continue;
    const p = (c as ReactElement<{ value?: string | number; children?: ReactNode; disabled?: boolean }>).props;
    const label = p.children;
    out.push({ value: String(p.value ?? textOf(label)), label, text: textOf(label).trim(), disabled: p.disabled });
  }
  return out;
}

type Place = { left: number; width: number; top?: number; bottom?: number; maxHeight: number };

export function DesignSelect({
  value,
  onChange,
  children,
  className = "",
  disabled,
  "aria-label": ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  "aria-label": string;
}) {
  const choices = readChoices(children);
  const selected = Math.max(0, choices.findIndex((c) => c.value === value));
  const current = choices[selected];
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(selected);
  const [place, setPlace] = useState<Place>();
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const id = useId();
  const optionId = (i: number) => `${id}-option-${i}`;

  // Where the list goes: under the field, or above it when there is no room below.
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const r = button.current?.getBoundingClientRect();
      if (!r) return;
      const below = window.innerHeight - r.bottom - 12;
      const above = r.top - 12;
      const up = below < 220 && above > below;
      setPlace({ left: r.left, width: r.width, top: up ? undefined : r.bottom + 6, bottom: up ? window.innerHeight - r.top + 6 : undefined, maxHeight: Math.max(120, Math.min(300, up ? above : below)) });
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open]);

  // A click anywhere else closes it, like a native dropdown.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!button.current?.contains(t) && !list.current?.contains(t)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Keep the highlighted choice in view while moving with the keys.
  useEffect(() => {
    if (open) document.getElementById(optionId(active))?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, active]);

  const show = (at = selected) => {
    setActive(at);
    setOpen(true);
  };
  const pick = (i: number) => {
    const c = choices[i];
    if (!c || c.disabled) return;
    setOpen(false);
    button.current?.focus();
    if (c.value !== value) onChange(c.value);
  };
  const step = (from: number, dir: 1 | -1) => {
    for (let i = from + dir; i >= 0 && i < choices.length; i += dir) if (!choices[i]!.disabled) return i;
    return from;
  };
  const firstEnabled = () => step(-1, 1);
  const lastEnabled = () => step(choices.length, -1);

  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    const k = e.key;
    if (!open) {
      if (k === "ArrowDown" || k === "ArrowUp" || k === "Enter" || k === " ") {
        e.preventDefault();
        show();
      } else if (k.length === 1 && /\S/.test(k)) {
        const i = choices.findIndex((c, n) => n > selected && !c.disabled && c.text.toLowerCase().startsWith(k.toLowerCase()));
        const j = i >= 0 ? i : choices.findIndex((c) => !c.disabled && c.text.toLowerCase().startsWith(k.toLowerCase()));
        if (j >= 0) show(j);
      }
      return;
    }
    if (k === "Escape") {
      // Close only the list, not the dialog it sits in.
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    } else if (k === "ArrowDown") {
      e.preventDefault();
      setActive((a) => step(a, 1));
    } else if (k === "ArrowUp") {
      e.preventDefault();
      setActive((a) => step(a, -1));
    } else if (k === "Home") {
      e.preventDefault();
      setActive(firstEnabled());
    } else if (k === "End") {
      e.preventDefault();
      setActive(lastEnabled());
    } else if (k === "Enter" || k === " ") {
      e.preventDefault();
      pick(active);
    } else if (k === "Tab") {
      setOpen(false);
    } else if (k.length === 1 && /\S/.test(k)) {
      const i = choices.findIndex((c, n) => n > active && !c.disabled && c.text.toLowerCase().startsWith(k.toLowerCase()));
      const j = i >= 0 ? i : choices.findIndex((c) => !c.disabled && c.text.toLowerCase().startsWith(k.toLowerCase()));
      if (j >= 0) setActive(j);
    }
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        role="combobox"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${id}-list` : undefined}
        aria-activedescendant={open ? optionId(active) : undefined}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onKeyDown}
        className={`design-select-button flex items-center justify-between gap-2 text-left ${className}`}
      >
        <span className="min-w-0 truncate">{current?.label}</span>
        <svg aria-hidden viewBox="0 0 16 16" className={`h-4 w-4 shrink-0 text-ink-muted transition-transform ${open ? "rotate-180" : ""}`} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 6l4 4 4-4" />
        </svg>
      </button>
      {open &&
        place &&
        createPortal(
          <ul
            ref={list}
            id={`${id}-list`}
            role="listbox"
            aria-label={ariaLabel}
            className={`design-select-list design-glass-menu fixed z-[90] overflow-y-auto p-1.5 text-sm text-ink ${designFont}`}
            style={{ left: place.left, width: Math.max(place.width, 180), top: place.top, bottom: place.bottom, maxHeight: place.maxHeight }}
          >
            {choices.map((c, i) => (
              <li
                key={`${c.value}-${i}`}
                id={optionId(i)}
                role="option"
                aria-selected={i === selected}
                aria-disabled={c.disabled || undefined}
                onMouseEnter={() => !c.disabled && setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(i)}
                className={`design-select-option flex items-center justify-between gap-3 rounded-xl px-3 py-2 ${c.disabled ? "cursor-not-allowed opacity-40" : "cursor-pointer"} ${i === active ? "bg-ui-accent-soft" : ""} ${i === selected ? "font-semibold" : ""}`}
              >
                <span className="min-w-0 truncate">{c.label}</span>
                {i === selected && (
                  <svg aria-hidden viewBox="0 0 16 16" className="h-4 w-4 shrink-0 text-ui-accent" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3.5 8.5l3 3 6-7" />
                  </svg>
                )}
              </li>
            ))}
          </ul>,
          document.body,
        )}
    </>
  );
}
