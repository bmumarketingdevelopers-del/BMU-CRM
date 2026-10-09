"use client";

import { useState } from "react";
import type { TeamActivityEntity, TeamActivityFeed } from "@bmu/shared";
import { Empty, Panel } from "@/components/dash";
import { Button, LoadState, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

const ENTITY_LABEL: Record<string, string> = {
  ClientOrg: "Client",
  Lead: "Lead",
  Proposal: "Proposal",
  Engagement: "Engagement",
  Invoice: "Invoice",
  Payment: "Payment",
  Request: "Request",
  Deliverable: "Deliverable",
  Version: "Version",
  Plan: "Plan",
  RequirementItem: "Requirement",
  User: "Person",
  Task: "Task",
};

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });

/**
 * Activity tab for any record: who did what, when, read from the audit log (the record and the records under it).
 * Use on client, lead, engagement and invoice pages: <ActivityFeed entity="ClientOrg" id={client.id} />
 */
export function ActivityFeed({ entity, id, title = "Activity", subtitle }: { entity: TeamActivityEntity; id: string; title?: string; subtitle?: string }) {
  const [actor, setActor] = useState("");
  const [take, setTake] = useState(50);
  const [open, setOpen] = useState<string>();
  const feed = useLoad<TeamActivityFeed>(() => api.teamFlows.activity(entity, id, { take: 200 }));
  const all = feed.data?.items ?? [];
  const items = all.filter((i) => !actor || (actor === "system" ? i.actor === null : i.actor === actor));
  const actors = [...new Set(all.map((i) => i.actor ?? "system"))];

  return (
    <Panel
      title={title}
      subtitle={subtitle ?? (feed.data ? `${feed.data.total} change${feed.data.total === 1 ? "" : "s"} recorded in the audit log` : undefined)}
      action={
        actors.length > 1 ? (
          <Select value={actor} onChange={(e) => setActor(e.target.value)} aria-label="Filter by person">
            <option value="">Everyone</option>
            {actors.map((a) => (
              <option key={a} value={a}>
                {a === "system" ? "BMU Hub (automatic)" : a}
              </option>
            ))}
          </Select>
        ) : undefined
      }
    >
      <LoadState loading={feed.loading && !feed.data} error={feed.error} />
      {feed.data && items.length === 0 && <Empty>No activity recorded yet.</Empty>}
      {items.length > 0 && (
        <ol className="relative space-y-0 border-l border-border pl-4" data-testid="activity-feed">
          {items.slice(0, take).map((i) => (
            <li key={i.id} className="relative py-2">
              <span className="absolute top-3.5 -left-[21px] h-2 w-2 bg-charcoal" aria-hidden />
              <button type="button" className="w-full text-left" onClick={() => setOpen(open === i.id ? undefined : i.id)} disabled={!i.changes.length}>
                <p className="text-sm">
                  {i.summary}
                  {i.entity !== entity && <span className="ml-2 text-xs text-ink-muted">({ENTITY_LABEL[i.entity] ?? i.entity})</span>}
                </p>
                <p className="text-xs text-ink-muted">
                  {when(i.at)}
                  {i.changes.length > 0 && <span className="ml-2 underline">{open === i.id ? "Hide details" : "Details"}</span>}
                </p>
              </button>
              {open === i.id && (
                <table className="mt-2 w-full text-xs">
                  <thead>
                    <tr className="text-left text-ink-muted">
                      <th className="py-1 pr-2 font-normal">Field</th>
                      <th className="py-1 pr-2 font-normal">Before</th>
                      <th className="py-1 font-normal">After</th>
                    </tr>
                  </thead>
                  <tbody>
                    {i.changes.map((c) => (
                      <tr key={c.field} className="border-t border-border align-top">
                        <td className="py-1 pr-2 font-medium">{c.field}</td>
                        <td className="py-1 pr-2 break-all text-ink-muted">{c.before ?? "—"}</td>
                        <td className="py-1 break-all">{c.after ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </li>
          ))}
        </ol>
      )}
      {items.length > take && (
        <Button variant="ghost" className="mt-2 px-0" onClick={() => setTake((t) => t + 50)}>
          Show older activity
        </Button>
      )}
    </Panel>
  );
}
