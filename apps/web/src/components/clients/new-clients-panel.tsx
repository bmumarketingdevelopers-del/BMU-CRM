"use client";

// v33: clients added in the last 30 days and who added them, on the Founder's Weekly Review.
// Hidden for people who can't see it (the API answers 403).
import Link from "next/link";
import { DataTable, Panel } from "@/components/dash";
import { Badge, LoadState } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

const day = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });
const HOW = { new: "New", migrated: "Migrated", from_lead: "From a lead" } as const;

export function NewClientsPanel() {
  const s = useLoad(() => api.insights.newClients(), { live: ["ClientOrg"] });
  if (!s.data) return s.error ? null : <LoadState loading={s.loading} />;
  const d = s.data;
  return (
    <Panel
      className="min-w-0"
      title="New clients"
      subtitle={`${d.total} added in the last ${d.days} days${d.byCm ? `, ${d.byCm} by Client Managers` : ""}.`}
      action={
        <Link href="/admin/clients" className="text-xs text-ink-muted hover:text-ink">
          All clients →
        </Link>
      }
      flush
    >
      <div data-testid="new-clients">
        <DataTable
          rows={d.rows}
          rowKey={(r) => r.id}
          rowHref={(r) => `/team/clients/${r.id}`}
          empty={`No clients added in the last ${d.days} days.`}
          columns={[
            { key: "name", header: "Client", cell: (r) => <span className="font-medium">{r.name}</span> },
            {
              key: "by",
              header: "Added by",
              cell: (r) =>
                r.addedBy ? (
                  <div>
                    {r.addedBy.name}
                    <div className="text-xs text-ink-muted">{r.addedBy.role}</div>
                  </div>
                ) : (
                  "—"
                ),
            },
            { key: "how", header: "How", cell: (r) => <Badge tone={r.how === "new" ? "green" : "neutral"}>{HOW[r.how]}</Badge> },
            { key: "cm", header: "Client Manager", cell: (r) => r.cm?.name ?? <span className="text-ink-muted">Not assigned</span> },
            { key: "svc", header: "Services", align: "right", cell: (r) => r.services },
            { key: "when", header: "Added", align: "right", cell: (r) => day.format(new Date(r.addedAt)) },
          ]}
        />
      </div>
    </Panel>
  );
}
