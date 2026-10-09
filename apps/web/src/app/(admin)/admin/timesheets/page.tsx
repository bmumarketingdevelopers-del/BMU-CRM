"use client";

import { useState } from "react";
import type { TeamTimesheetRow } from "@bmu/shared";
import { DataTable, Panel, StatRow, StatTile, Tabs } from "@/components/dash";
import { hrs, sheetLabel, sheetTone } from "@/components/timesheet-week";
import { Badge, LoadState, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

type Filter = "submitted" | "approved" | "returned" | "all";
const day = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

/** Command Centre → Timesheets: every submitted week you can approve. Approved hours feed profitability. */
export default function AdminTimesheetsPage() {
  const [filter, setFilter] = useState<Filter>("submitted");
  const all = useLoad(() => api.teamFlows.timesheets.approvals("all"));
  const rows = (all.data ?? []).filter((r) => filter === "all" || r.status === filter);
  const count = (s: TeamTimesheetRow["status"]) => (all.data ?? []).filter((r) => r.status === s).length;
  const approvedMin = (all.data ?? []).filter((r) => r.status === "approved").reduce((s, r) => s + r.totalMinutes, 0);

  return (
    <>
      <PageTitle title="Timesheets" subtitle="Weekly hours from task logs and manual entries. Managers approve or return them; approved hours are used for client profitability." />
      <StatRow cols={4}>
        <StatTile label="Waiting for approval" value={count("submitted")} tone={count("submitted") ? "warn" : "good"} />
        <StatTile label="Returned for changes" value={count("returned")} />
        <StatTile label="Approved weeks" value={count("approved")} />
        <StatTile label="Approved hours" value={hrs(approvedMin)} hint="feeds Profitability" />
      </StatRow>
      <div className="mt-6">
        <Panel
          title="Weeks"
          action={<Tabs value={filter} onChange={setFilter} options={[{ value: "submitted", label: "Waiting" }, { value: "returned", label: "Returned" }, { value: "approved", label: "Approved" }, { value: "all", label: "All" }]} />}
          flush
        >
          <LoadState loading={all.loading && !all.data} error={all.error} />
          {all.data && (
            <DataTable
              rows={rows}
              rowKey={(r) => r.id}
              rowHref={(r) => `/team/timesheets/review/${r.id}`}
              empty="No timesheets here."
              columns={[
                { key: "who", header: "Person", cell: (r) => r.user.name },
                { key: "week", header: "Week of", cell: (r) => day(r.weekStart) },
                { key: "hrs", header: "Hours", cell: (r) => hrs(r.totalMinutes), align: "right" },
                { key: "st", header: "Status", cell: (r) => <Badge tone={sheetTone(r.status)}>{sheetLabel[r.status]}</Badge> },
                { key: "by", header: "Decided by", cell: (r) => r.decidedBy ?? "—" },
                { key: "c", header: "Comment", cell: (r) => <span className="text-ink-muted">{r.comment ?? ""}</span> },
              ]}
            />
          )}
        </Panel>
      </div>
    </>
  );
}
