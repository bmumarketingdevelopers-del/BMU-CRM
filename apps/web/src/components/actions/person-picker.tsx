"use client";

/**
 * PersonPicker: choose an owner from the reassignment engine's candidates, showing load %, leave, active tasks and
 * skills. Used by ReassignDialog and by create drawers ("Assignee picker shows load % and leave").
 *
 *   <PersonPicker candidates={c.candidates} value={toUserId} onChange={setToUserId} />
 */
import { useState } from "react";
import type { CoreCandidate } from "@bmu/shared";

const barTone = (pct: number) => (pct > 120 ? "bg-red" : pct > 100 ? "bg-amber" : pct >= 80 ? "bg-charcoal/70" : "bg-green");

export function LoadBar({ pct }: { pct: number }) {
  const shown = pct >= 999 ? "On leave all week" : `${pct}%`;
  return (
    <span className="flex items-center gap-1.5" title={`Load this week: ${shown}`}>
      <span className="relative h-1.5 w-16 overflow-hidden bg-canvas" aria-hidden>
        <span className={`absolute inset-y-0 left-0 ${barTone(pct)}`} style={{ width: `${Math.min(100, pct)}%` }} />
      </span>
      <span className={`text-[11px] tabular-nums ${pct > 100 ? "font-semibold text-red" : "text-ink-muted"}`}>{shown}</span>
    </span>
  );
}

export function PersonPicker({
  candidates,
  value,
  onChange,
  showAfter = true,
  emptyText = "Nobody can take this work.",
  max = 60,
}: {
  candidates: CoreCandidate[];
  value: string | null | undefined;
  onChange: (id: string) => void;
  showAfter?: boolean;
  emptyText?: string;
  max?: number;
}) {
  const [q, setQ] = useState("");
  const term = q.trim().toLowerCase();
  const rows = candidates.filter((c) => !term || c.name.toLowerCase().includes(term) || (c.department ?? "").toLowerCase().includes(term) || c.skills.some((s) => s.toLowerCase().includes(term))).slice(0, max);
  return (
    <div className="border border-border">
      {candidates.length > 6 && (
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people, departments or skills" aria-label="Search people" className="w-full border-b border-border bg-surface-raised px-3 py-2 text-sm outline-none" />
      )}
      <ul role="listbox" aria-label="People" className="max-h-64 overflow-y-auto">
        {rows.length === 0 && <li className="px-3 py-4 text-center text-xs text-ink-muted">{candidates.length ? "Nobody matches." : emptyText}</li>}
        {rows.map((c) => {
          const disabled = !!c.blockedReason || c.current;
          const selected = value === c.id;
          return (
            <li key={c.id} role="option" aria-selected={selected} aria-disabled={disabled}>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onChange(c.id)}
                data-person={c.name}
                className={`grid w-full grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 border-b border-border px-3 py-2 text-left text-sm last:border-b-0 ${selected ? "bg-canvas outline-1 -outline-offset-1 outline-charcoal" : "hover:bg-canvas/50"} ${disabled ? "cursor-not-allowed opacity-50" : ""}`}
              >
                <span className="min-w-0 truncate font-medium">
                  {c.name}
                  {c.suggested && <span className="ml-1.5 bg-green/15 px-1.5 py-0.5 text-[10px] font-normal">Best fit</span>}
                  {c.current && <span className="ml-1.5 text-[11px] font-normal text-ink-muted">(current owner)</span>}
                </span>
                <LoadBar pct={showAfter ? c.loadAfterPct : c.loadPct} />
                <span className="col-span-2 flex flex-wrap gap-x-2 text-[11px] text-ink-muted">
                  {c.role && <span>{c.role.replace(/_/g, " ")}</span>}
                  {c.skills.length > 0 && <span>{c.skills.join(" · ")}</span>}
                  <span>{c.openTasks} open</span>
                  {c.onLeave ? <span className="font-semibold text-red">{c.leaveNote ?? "On leave on the deadline"}</span> : c.onLeaveToday ? <span className="text-amber">On leave today</span> : null}
                  {c.blockedReason && <span className="text-red">{c.blockedReason}</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
