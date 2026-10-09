"use client";

/**
 * SavedViewsMenu: save the current filters of a list under a name, share with the team, and switch between views.
 *
 *   <SavedViewsMenu entity="task" filters={filters} onApply={(f) => setFilters(f as Filters)} />
 *
 * `filters` is any plain object (strings/booleans); it is stored as-is in SavedView.filters.
 */
import { useEffect, useRef, useState } from "react";
import type { CoreSavedView } from "@bmu/shared";
import { api } from "@/lib/api";

export function SavedViewsMenu({ entity, filters, onApply }: { entity: string; filters: Record<string, unknown>; onApply: (filters: Record<string, unknown>, view: CoreSavedView | null) => void }) {
  const [views, setViews] = useState<CoreSavedView[]>();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [shared, setShared] = useState(false);
  const [current, setCurrent] = useState<string>();
  const [error, setError] = useState<string>();
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    api.actions.views
      .list(entity)
      .then((v) => live && setViews(v))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [entity]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  async function save() {
    setError(undefined);
    try {
      const v = await api.actions.views.create(entity, { name: name.trim(), filters, isShared: shared });
      setViews((all) => [...(all ?? []), v]);
      setCurrent(v.id);
      setName("");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function remove(v: CoreSavedView) {
    if (!window.confirm(`Delete the view "${v.name}"?`)) return;
    try {
      await api.actions.views.remove(v.id);
      setViews((all) => all?.filter((x) => x.id !== v.id));
      if (current === v.id) setCurrent(undefined);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const active = views?.find((v) => v.id === current);
  return (
    <div ref={box} className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} className="border border-border bg-surface-raised px-3 py-1.5 text-sm hover:border-ink" data-testid="saved-views">
        {active ? active.name : "Views"} ▾
      </button>
      {open && (
        <div className="absolute left-0 top-full z-40 mt-1 w-72 border border-border bg-surface p-2 text-sm shadow-lg">
          <button
            type="button"
            className="block w-full px-2 py-1.5 text-left hover:bg-canvas"
            onClick={() => {
              setCurrent(undefined);
              onApply({}, null);
              setOpen(false);
            }}
          >
            All (no filters)
          </button>
          {views === undefined && !error && <p className="px-2 py-1.5 text-ink-muted">Loading…</p>}
          {views?.map((v) => (
            <div key={v.id} className="flex items-center justify-between gap-2 hover:bg-canvas">
              <button
                type="button"
                className="min-w-0 flex-1 truncate px-2 py-1.5 text-left"
                onClick={() => {
                  setCurrent(v.id);
                  onApply(v.filters, v);
                  setOpen(false);
                }}
              >
                {v.name}
                {v.isShared && <span className="ml-2 text-xs text-ink-muted">{v.mine ? "Shared" : `by ${v.owner}`}</span>}
              </button>
              {v.mine && (
                <button type="button" className="px-2 text-xs text-ink-muted hover:text-red" onClick={() => remove(v)} aria-label={`Delete view ${v.name}`}>
                  ✕
                </button>
              )}
            </div>
          ))}
          <form
            className="mt-2 border-t border-border pt-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim()) save();
            }}
          >
            <label className="block text-xs text-ink-muted" htmlFor={`view-name-${entity}`}>
              Save current filters as
            </label>
            <div className="mt-1 flex gap-1">
              <input id={`view-name-${entity}`} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Overdue this week" maxLength={80} className="min-w-0 flex-1 border border-border bg-surface-raised px-2 py-1 text-sm" />
              <button type="submit" disabled={!name.trim()} className="bg-charcoal px-2 py-1 text-xs text-ivory disabled:opacity-40">
                Save
              </button>
            </div>
            <label className="mt-1 flex items-center gap-2 text-xs">
              <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} /> Share with the team
            </label>
          </form>
          {error && <p className="mt-1 px-2 text-xs text-red">{error}</p>}
        </div>
      )}
    </div>
  );
}
