"use client";

import { useState } from "react";
import type { CapacityPerson } from "@bmu/shared";
import { DataTable, Meter, Panel, StatRow, StatTile, Tabs, type Column } from "@/components/dash";
import { Badge, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { WithData } from "../_insights/kit";

type View = "all" | "overloaded" | "idle";

const tone = (u: number) => (u > 100 ? "bad" : u >= 85 ? "warn" : u > 0 ? "default" : "default");

export default function CapacityPage() {
  const state = useLoad(() => api.insights.capacity());
  const [view, setView] = useState<View>("all");
  return (
    <>
      <PageTitle title="Capacity" subtitle="Who has how much work this week, and who is free to take more." />
      <WithData state={state}>
        {(c) => {
          const overloaded = c.people.filter((p) => p.flag === "overloaded");
          const idle = c.people.filter((p) => p.flag === "idle");
          const shown = view === "overloaded" ? overloaded : view === "idle" ? idle : c.people;
          const open = c.people.reduce((s, p) => s + p.openTasks, 0);
          const hours = c.people.reduce((s, p) => s + p.hoursThisWeek, 0);
          const people: Column<CapacityPerson>[] = [
            {
              key: "name",
              header: "Person",
              cell: (p) => (
                <div className="flex items-center gap-2">
                  <span className={`inline-block h-1.5 w-1.5 shrink-0 ${p.checkedIn ? "bg-green" : "bg-grey"}`} title={p.checkedIn ? "Checked in today" : "Not checked in today"} />
                  <span className="font-medium">{p.name}</span>
                  {p.flag === "overloaded" && <Badge tone="red">Overloaded</Badge>}
                  {p.flag === "idle" && <Badge>Free</Badge>}
                </div>
              ),
            },
            { key: "dept", header: "Department", cell: (p) => <span className="text-ink-muted">{p.department ?? "—"}</span> },
            { key: "open", header: "Open tasks", align: "right", cell: (p) => p.openTasks },
            { key: "week", header: "Due this week", align: "right", cell: (p) => p.dueThisWeek },
            { key: "late", header: "Overdue", align: "right", cell: (p) => (p.overdue ? <span className="text-[#b4432c]">{p.overdue}</span> : 0) },
            { key: "hours", header: "Hours", align: "right", cell: (p) => p.hoursThisWeek },
            { key: "util", header: `Use of ${c.weekHours}h week`, className: "min-w-40", cell: (p) => <Meter value={p.utilisation} tone={tone(p.utilisation)} /> },
          ];
          return (
            <div className="space-y-8">
              <StatRow cols={4}>
                <StatTile label="Open tasks" value={open} hint={`${c.people.length} people`} />
                <StatTile label="Hours logged this week" value={Math.round(hours)} hint={`of ${c.people.length * c.weekHours}h available`} />
                <StatTile label="Overloaded" value={overloaded.length} tone={overloaded.length ? "bad" : "default"} hint={`more than ${c.overloadAt} open tasks`} />
                <StatTile label="Free to take work" value={idle.length} tone={idle.length ? "good" : "default"} hint="no open tasks" />
              </StatRow>

              <Panel className="min-w-0" title="By department" flush>
                <DataTable
                  rows={c.departments}
                  rowKey={(d) => d.id ?? "none"}
                  empty="No team members yet."
                  columns={[
                    { key: "name", header: "Department", cell: (d) => <span className="font-medium">{d.name}</span> },
                    { key: "people", header: "People", align: "right", cell: (d) => d.people },
                    { key: "in", header: "In today", align: "right", cell: (d) => `${d.checkedIn}/${d.people}` },
                    { key: "open", header: "Open tasks", align: "right", cell: (d) => d.openTasks },
                    { key: "week", header: "Due this week", align: "right", cell: (d) => d.dueThisWeek },
                    { key: "late", header: "Overdue", align: "right", cell: (d) => (d.overdue ? <span className="text-[#b4432c]">{d.overdue}</span> : 0) },
                    { key: "util", header: "Use of time", className: "min-w-40", cell: (d) => <Meter value={d.utilisation} tone={tone(d.utilisation)} /> },
                  ]}
                />
              </Panel>

              <Panel className="min-w-0"
                title="By person"
                subtitle="Green dot: checked in today. Hours come from time logged on tasks worked this week."
                flush
                action={
                  <Tabs
                    value={view}
                    onChange={setView}
                    options={[
                      { value: "all", label: "Everyone" },
                      { value: "overloaded", label: `Overloaded (${overloaded.length})` },
                      { value: "idle", label: `Free (${idle.length})` },
                    ]}
                  />
                }
              >
                <DataTable rows={shown} rowKey={(p) => p.id} columns={people} empty="Nobody in this group." />
              </Panel>
            </div>
          );
        }}
      </WithData>
    </>
  );
}
