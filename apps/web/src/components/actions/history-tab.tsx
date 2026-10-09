"use client";

/**
 * HistoryTab: "View history" for any record, from the audit log (who did what, when, before → after), plus the
 * record's reassignment trail when you pass `assignments`.
 *
 *   <HistoryTab entity="Task" id={task.id} assignments={task.assignments} />
 *
 * `entity` is a TeamActivityEntity (ClientOrg, Lead, Engagement, Invoice, Task, ...). Wraps <ActivityFeed>.
 */
import type { TeamActivityEntity } from "@bmu/shared";
import { ActivityFeed } from "@/components/activity-feed";

const when = (iso: string) => new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });

export type HistoryAssignment = { id: string; at: string; from: string | null; to: string | null; by: string; reason: string; note: string | null; handoverNote: string | null };

export function HistoryTab({ entity, id, assignments }: { entity: TeamActivityEntity; id: string; assignments?: HistoryAssignment[] }) {
  return (
    <div className="space-y-6" data-testid="history-tab">
      {assignments && assignments.length > 0 && (
        <section>
          <h3 className="mb-2 text-sm font-semibold">Who has had it</h3>
          <ol className="space-y-2 border-l border-border pl-4 text-sm">
            {assignments.map((a) => (
              <li key={a.id}>
                <p>
                  {a.from ?? "Nobody"} → <span className="font-medium">{a.to ?? "Nobody"}</span> <span className="text-ink-muted">by {a.by}</span>
                </p>
                <p className="text-xs text-ink-muted">
                  {when(a.at)} · {a.reason}
                  {a.note ? ` · ${a.note}` : ""}
                </p>
                {a.handoverNote && <p className="mt-0.5 text-xs">Handover: {a.handoverNote}</p>}
              </li>
            ))}
          </ol>
        </section>
      )}
      <ActivityFeed entity={entity} id={id} title="History" />
    </div>
  );
}
