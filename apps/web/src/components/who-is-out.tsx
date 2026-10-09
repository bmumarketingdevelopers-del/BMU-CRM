"use client";

import type { TeamWhoIsOut } from "@bmu/shared";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

const label = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });

/** "Who's out" strip: approved leave across the team for the next two weeks. */
export function WhoIsOut() {
  const out = useLoad<TeamWhoIsOut>(() => api.teamFlows.leave.whoIsOut());
  if (!out.data) return null;
  return (
    <section className="mb-4 border border-border bg-surface-raised px-4 py-3" aria-label="Who is out" data-testid="who-is-out">
      <p className="mb-2 text-[11px] uppercase tracking-[0.12em] text-ink-muted">Who&apos;s out · next 2 weeks</p>
      {out.data.length === 0 ? (
        <p className="text-sm text-ink-muted">Everyone is in. No approved leave in the next two weeks.</p>
      ) : (
        <ul className="flex gap-3 overflow-x-auto pb-1 text-sm">
          {out.data.map((d) => (
            <li key={d.date} className="min-w-[140px] shrink-0 border-l-2 border-grey pl-2">
              <p className="text-xs font-medium">{label(d.date)}</p>
              {d.people.map((p) => (
                <p key={p.id} className="truncate text-xs text-ink-muted" title={`${p.type} leave until ${label(p.to)}`}>
                  {p.name} · {p.type}
                </p>
              ))}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
