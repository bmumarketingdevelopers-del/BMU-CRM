"use client";

/** Global "+ New" button in the top bar. Lists the registered entries the person may use (see new-registry.tsx). */
import { useEffect, useMemo, useRef, useState } from "react";
import { useActions } from "./actions-provider";
import { newEntriesFor } from "./new-registry";

export function NewButton() {
  const { me, surface, openNew } = useActions();
  const entries = useMemo(() => newEntriesFor(me, surface), [me, surface]);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", key);
    setTimeout(() => box.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus(), 0);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  if (!entries.length) return null;
  return (
    <div ref={box} className="relative">
      <button type="button" data-new-button aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="bg-charcoal px-3 py-1.5 text-sm font-medium text-ivory hover:opacity-90" title="New (N)">
        + New
      </button>
      {open && (
        <div role="menu" aria-label="Create new" className="absolute right-0 top-full z-50 mt-1 w-64 border border-border bg-surface py-1 shadow-lg">
          {entries.map((e) => (
            <button
              key={e.id}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                openNew(e.id);
              }}
              onKeyDown={(ev) => {
                if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
                  ev.preventDefault();
                  const els = [...(box.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
                  const at = els.indexOf(ev.currentTarget);
                  els[(at + (ev.key === "ArrowDown" ? 1 : -1) + els.length) % els.length]?.focus();
                }
              }}
              className="flex w-full items-baseline justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-canvas focus:bg-canvas focus:outline-none"
            >
              <span className="font-medium">{e.label}</span>
              {e.hint && <span className="truncate text-xs text-ink-muted">{e.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
