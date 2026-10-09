"use client";

/**
 * BulkBar + useSelection: multi-select on any list (spec bulk_actions).
 *
 *   const sel = useSelection(rows.map((r) => r.id));
 *   <input type="checkbox" checked={sel.has(r.id)} onChange={() => sel.toggle(r.id)} />
 *   <BulkBar count={sel.count} onClear={sel.clear} label="tasks">
 *     <BulkButton onClick={() => openReassign({ type: "task", ids: sel.ids })}>Reassign</BulkButton>
 *   </BulkBar>
 *
 * The bar sticks to the bottom of the screen while something is selected. Selection drops ids that leave the list.
 */
import { useCallback, useMemo, useState, type ReactNode } from "react";

export function useSelection(visibleIds: string[]) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const visible = useMemo(() => new Set(visibleIds), [visibleIds]);
  const ids = useMemo(() => [...picked].filter((id) => visible.has(id)), [picked, visible]);
  const has = useCallback((id: string) => picked.has(id) && visible.has(id), [picked, visible]);
  const toggle = useCallback(
    (id: string) =>
      setPicked((s) => {
        const n = new Set(s);
        if (n.has(id)) n.delete(id);
        else n.add(id);
        return n;
      }),
    [],
  );
  const allSelected = visibleIds.length > 0 && ids.length === visibleIds.length;
  const toggleAll = useCallback(() => setPicked(allSelected ? new Set() : new Set(visibleIds)), [allSelected, visibleIds]);
  const clear = useCallback(() => setPicked(new Set()), []);
  return { ids, count: ids.length, has, toggle, toggleAll, allSelected, clear };
}

export function BulkBar({ count, onClear, label = "items", children }: { count: number; onClear: () => void; label?: string; children: ReactNode }) {
  if (!count) return null;
  return (
    <div role="region" aria-label="Bulk actions" data-testid="bulk-bar" className="sticky bottom-3 z-40 mt-4 flex flex-wrap items-center gap-2 border border-charcoal bg-charcoal px-3 py-2 text-sm text-ivory shadow-lg">
      <span className="mr-2 font-semibold">
        {count} {count === 1 ? label.replace(/s$/, "") : label} selected
      </span>
      {children}
      <button type="button" onClick={onClear} className="ml-auto px-2 py-1 text-xs opacity-80 hover:opacity-100">
        Clear
      </button>
    </div>
  );
}

export function BulkButton({ children, onClick, disabled, title }: { children: ReactNode; onClick: () => void; disabled?: boolean; title?: string }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={title} className="border border-ivory/40 px-2.5 py-1 text-xs hover:bg-ivory hover:text-charcoal disabled:opacity-40">
      {children}
    </button>
  );
}
