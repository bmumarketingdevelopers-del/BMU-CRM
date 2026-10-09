import Link from "next/link";
import type { DeliverSlaItem } from "@bmu/shared";
import { Badge } from "@/components/ui";

const day = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });

/** Overdue and at-risk delivery items, newest problem first. */
export function SlaList({ items, limit = 20 }: { items: DeliverSlaItem[]; limit?: number }) {
  if (!items.length) return <p className="py-3 text-sm text-ink-muted">Nothing is late or at risk.</p>;
  return (
    <ul className="divide-y divide-border text-sm" data-testid="sla-list">
      {items.slice(0, limit).map((i) => (
        <li key={i.key} className="flex flex-wrap items-start justify-between gap-2 py-2.5">
          <div className="min-w-0">
            <Link href={i.deliverableId ? `/team/deliverables/${i.deliverableId}` : `/team/projects/${i.engagementId}`} className="font-medium hover:underline">
              {i.kind === "task" && i.step ? `${i.step}: ` : ""}
              {i.title}
            </Link>
            <p className="text-xs text-ink-muted">
              {i.client.name}
              {i.owner ? ` · ${i.owner}` : ""}
              {i.department ? ` · ${i.department}` : ""} · {i.kind === "deliverable" ? "deliverable due" : "step due"} {day.format(new Date(i.dueAt))}
            </p>
          </div>
          <div className="flex items-center gap-1.5">
            {i.escalated && <Badge tone="dark">Escalated</Badge>}
            {i.state === "overdue" ? (
              <Badge tone="red">{i.workingDaysLate > 0 ? `${i.workingDaysLate} working day${i.workingDaysLate === 1 ? "" : "s"} late` : "Late today"}</Badge>
            ) : (
              <Badge tone="amber">Due soon</Badge>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
