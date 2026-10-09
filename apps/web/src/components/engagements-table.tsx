"use client";

import Link from "next/link";
import { planStatusLabels } from "@bmu/shared";
import { Badge, LoadState } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

export const day = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" });
export const engagementStatus = (s: string) => s.replace(/_/g, " ");

/** Every engagement the signed-in person may see, scoped by the API. */
export function EngagementsTable() {
  const rows = useLoad(() => api.engagements.list());
  if (!rows.data) return <LoadState loading={rows.loading} error={rows.error} />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[820px] bg-surface-raised text-sm">
        <thead>
          <tr className="border-b border-border text-left text-[11px] uppercase tracking-[0.12em] text-ink-muted">
            <th className="px-3 py-2">Client and service</th>
            <th className="px-3 py-2">Account Manager</th>
            <th className="px-3 py-2">Stage</th>
            <th className="px-3 py-2">Onboarding</th>
            <th className="px-3 py-2">Plan</th>
          </tr>
        </thead>
        <tbody>
          {rows.data.map((e) => (
            <tr key={e.id} className="border-b border-border align-top">
              <td className="px-3 py-2">
                <Link href={`/team/projects/${e.id}`} className="font-medium underline">
                  {e.client.name}
                </Link>
                <div className="text-xs text-ink-muted">
                  {e.serviceName} · <span className="capitalize">{e.tier}</span>
                </div>
              </td>
              <td className="px-3 py-2">{e.am?.name ?? "Unassigned"}</td>
              <td className="px-3 py-2">
                <Badge tone="dark">{e.currentGate}</Badge> <span className="capitalize">{engagementStatus(e.status)}</span>
              </td>
              <td className="px-3 py-2">
                {e.rcdAt ? (
                  <span>Started {day.format(new Date(e.rcdAt))}</span>
                ) : (
                  <Badge tone={e.requirementsOutstanding ? "amber" : "green"}>
                    {e.requirementsOutstanding ? `${e.requirementsOutstanding} item${e.requirementsOutstanding > 1 ? "s" : ""} outstanding` : "Ready for RCD"}
                  </Badge>
                )}
              </td>
              <td className="px-3 py-2">
                {e.planStatus ? planStatusLabels[e.planStatus] : e.planningDue ? `Due ${day.format(new Date(e.planningDue))}` : "Not started"}
              </td>
            </tr>
          ))}
          {rows.data.length === 0 && (
            <tr>
              <td colSpan={5} className="px-3 py-6 text-center text-ink-muted">
                No projects you can see yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
