"use client";

import Link from "next/link";
import { TEAM_PROCESS_GROUPS, TEAM_PROCESS_GROUP_LABELS, type TeamPeopleProcess, type TeamProcessItem } from "@bmu/shared";
import { Meter, Panel } from "@/components/dash";
import { Badge } from "@/components/ui";

const fmt = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });

export const processStatusTone = (s: TeamPeopleProcess["status"]) => (s === "done" ? "green" : s === "cancelled" ? "neutral" : "amber");

/** Grouped onboarding/offboarding checklist. HR ticks items; SOP items are ticked by the new hire reading them. */
export function PeopleChecklist({
  process,
  onTick,
  busy,
  viewerIsUser = false,
}: {
  process: TeamPeopleProcess;
  onTick?: (item: TeamProcessItem, done: boolean) => void;
  busy?: boolean;
  viewerIsUser?: boolean;
}) {
  const groups = TEAM_PROCESS_GROUPS.map((g) => ({ g, items: process.items.filter((i) => i.group === g) })).filter((x) => x.items.length);
  return (
    <div className="grid gap-4">
      <Panel>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-[200px] flex-1">
            <p className="mb-1 text-sm">
              {process.doneCount} of {process.items.length} done
            </p>
            <Meter value={process.progressPct} tone={process.progressPct === 100 ? "good" : "default"} label={`${process.doneCount} of ${process.items.length} done`} />
          </div>
          <div className="flex flex-wrap gap-2 text-xs text-ink-muted">
            {process.startDate && <span>Start date {fmt(process.startDate)}</span>}
            {process.lastDay && <span>Last day {fmt(process.lastDay)}</span>}
            {process.buddy && <span>Buddy: {process.buddy.name}</span>}
            <Badge tone={processStatusTone(process.status)}>{process.status === "open" ? "In progress" : process.status === "done" ? "Complete" : "Cancelled"}</Badge>
          </div>
        </div>
      </Panel>
      {groups.map(({ g, items }) => (
        <Panel key={g} title={TEAM_PROCESS_GROUP_LABELS[g]} subtitle={g === "induction" ? (viewerIsUser ? "Open each SOP, read it and press “I have read this”." : "Ticked when the new hire acknowledges each SOP.") : undefined} flush>
          <ul className="divide-y divide-border">
            {items.map((i) => {
              const systemOnly = !!i.sopId || (i.auto && ["reassign_tasks", "reassign_clients", "reassign_leads", "access_suspended", "hub_login"].includes(i.key));
              const canTick = !!onTick && !systemOnly && process.status === "open";
              return (
                <li key={i.key} className="flex items-start gap-3 px-5 py-3 text-sm">
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 accent-[var(--color-charcoal)]"
                    checked={i.done}
                    disabled={!canTick || busy}
                    onChange={(e) => onTick?.(i, e.target.checked)}
                    aria-label={i.label}
                    title={systemOnly ? "BMU Hub ticks this automatically" : undefined}
                  />
                  <div className="min-w-0 flex-1">
                    <p className={i.done ? "text-ink-muted line-through decoration-ink-muted/40" : ""}>{i.label}</p>
                    <p className="text-xs text-ink-muted">
                      {i.done ? `${i.doneBy ?? ""}${i.doneAt ? ` · ${fmt(i.doneAt)}` : ""}` : systemOnly ? "Ticked automatically" : "Not done yet"}
                    </p>
                  </div>
                  {i.sopId && (
                    <Link href={`/team/sops/${i.sopId}`} className="shrink-0 text-xs underline">
                      {viewerIsUser && !i.done ? "Read now" : "Open SOP"}
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        </Panel>
      ))}
    </div>
  );
}
