"use client";

/**
 * RowMenu: the "⋯" menu on every row, card and detail page (spec row_actions).
 * Pass the standard items (Edit, Assign/Reassign, Change deadline, Move, Duplicate, Archive, View history) or any
 * others. Items the user can't do at all: `hidden: true` (they are not shown). Items blocked by a rule or gate:
 * `disabledReason: "…"` (shown greyed out with the reason).
 *
 *   <RowMenu label={`Actions for ${task.title}`} items={[
 *     { key: "edit", label: "Edit", onSelect: edit, shortcut: "E" },
 *     { key: "reassign", label: "Reassign", onSelect: reassign, hidden: !can.reassign, shortcut: "R" },
 *     { key: "archive", label: "Archive", onSelect: archive, disabledReason: blockedWhy, danger: true },
 *   ]} />
 */
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";

export type RowMenuItem = {
  key: string;
  label: string;
  onSelect?: () => void;
  href?: string;
  hidden?: boolean;
  disabledReason?: string | null;
  danger?: boolean;
  shortcut?: string;
};

export function RowMenu({ items, label = "More actions", align = "right", className = "" }: { items: RowMenuItem[]; label?: string; align?: "left" | "right"; className?: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const id = useId();
  const shown = items.filter((i) => !i.hidden);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const els = [...(box.current?.querySelectorAll<HTMLElement>("[role=menuitem]:not([aria-disabled=true])") ?? [])];
        const at = els.indexOf(document.activeElement as HTMLElement);
        els[(at + (e.key === "ArrowDown" ? 1 : -1) + els.length) % els.length]?.focus();
      }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", key);
    setTimeout(() => box.current?.querySelector<HTMLElement>("[role=menuitem]:not([aria-disabled=true])")?.focus(), 0);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  if (!shown.length) return null;
  return (
    <div ref={box} className={`relative inline-block ${className}`}>
      <button
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          setOpen((v) => !v);
        }}
        className="px-2 py-0.5 text-base leading-none text-ink-muted hover:text-ink"
      >
        ⋯
      </button>
      {open && (
        <div id={id} role="menu" className={`absolute top-full z-50 mt-1 w-60 border border-border bg-surface py-1 text-sm shadow-lg ${align === "right" ? "right-0" : "left-0"}`}>
          {shown.map((i) => {
            const cls = `flex w-full items-start justify-between gap-2 px-3 py-1.5 text-left ${i.disabledReason ? "cursor-not-allowed text-ink-muted/60" : i.danger ? "text-red hover:bg-canvas" : "hover:bg-canvas"}`;
            const body = (
              <>
                <span className="min-w-0">
                  <span className="block">{i.label}</span>
                  {i.disabledReason && <span className="block text-[11px] leading-snug text-ink-muted">{i.disabledReason}</span>}
                </span>
                {i.shortcut && <kbd className="font-sans text-[10px] text-ink-muted">{i.shortcut}</kbd>}
              </>
            );
            if (i.href && !i.disabledReason)
              return (
                <Link key={i.key} role="menuitem" href={i.href} className={cls} onClick={() => setOpen(false)}>
                  {body}
                </Link>
              );
            return (
              <button
                key={i.key}
                type="button"
                role="menuitem"
                aria-disabled={!!i.disabledReason}
                title={i.disabledReason ?? undefined}
                className={cls}
                onClick={(e) => {
                  e.stopPropagation();
                  if (i.disabledReason) return;
                  setOpen(false);
                  i.onSelect?.();
                }}
              >
                {body}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
