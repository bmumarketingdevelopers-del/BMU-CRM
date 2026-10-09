"use client";

import Link from "next/link";
import { deliverableStatusLabels, type DeliverableStatus } from "@bmu/shared";
import { Badge, LoadState, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

const order: DeliverableStatus[] = ["qc_passed", "ready_for_client", "changes_requested", "in_qc", "qc_failed", "in_production", "planned", "approved", "scheduled", "published"];

/** Team side of the Review Studio: every deliverable from the tasks you can see, grouped by stage. */
export default function TeamReviewsPage() {
  const tasks = useLoad(() => api.tasks.list("team"));
  if (!tasks.data) return <LoadState loading={tasks.loading} error={tasks.error} />;
  const seen = new Map<string, NonNullable<(typeof tasks.data)[number]["deliverable"]> & { client: string }>();
  for (const t of tasks.data) if (t.deliverable && !seen.has(t.deliverable.id)) seen.set(t.deliverable.id, { ...t.deliverable, client: t.client?.name ?? "" });
  const rows = [...seen.values()].sort((a, b) => order.indexOf(a.status as DeliverableStatus) - order.indexOf(b.status as DeliverableStatus));
  return (
    <>
      <PageTitle title="Review Studio" subtitle="Versions, pinned and time-coded comments, QC and client approvals for each deliverable." />
      <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
        {rows.map((d) => (
          <Link key={d.id} href={`/team/deliverables/${d.id}`} className="border border-border bg-surface-raised p-4 hover:border-green">
            <div className="flex items-start justify-between gap-2">
              <span className="font-medium">{d.title}</span>
              <Badge tone={d.status === "approved" ? "green" : d.status === "qc_passed" ? "amber" : "neutral"}>{deliverableStatusLabels[d.status as DeliverableStatus]}</Badge>
            </div>
            <p className="mt-1 text-xs text-ink-muted">
              {d.client} · <span className="capitalize">{d.type}</span>
            </p>
          </Link>
        ))}
        {rows.length === 0 && <p className="text-sm text-ink-muted">No deliverables yet. They appear when a client approves a plan.</p>}
      </div>
    </>
  );
}
