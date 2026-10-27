"use client";
// v10 craft: leads' view of every specialist, grouped by job, with a link to each read-only dashboard.
import { useState } from "react";
import { CRAFT_SPECIALTY_OPTIONS, type CraftSpecialistRow } from "@bmu/shared";
import { CsvButton } from "@/components/charts";
import { DataTable, Panel, StatRow, StatTile } from "@/components/dash";
import { Badge, LoadState, PageTitle, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

export default function SpecialistsPage() {
  const loaded = useLoad(() => api.craft.specialists());
  const [spec, setSpec] = useState("");
  const rows = (loaded.data ?? []).filter((r) => !spec || r.specialty === spec);
  const all = loaded.data ?? [];
  const busiest = [...all].sort((a, b) => b.open - a.open)[0];
  return (
    <div className="[&_.grid>*]:min-w-0">
      <PageTitle title="Specialists" subtitle="Everyone with a specialty: open work, what is late and output over the last 30 days. Open a row to see their dashboard (read-only)." />
      {!loaded.data ? (
        <LoadState loading={loaded.loading} error={loaded.error} />
      ) : (
        <div className="grid gap-6">
          <StatRow cols={4}>
            <StatTile label="Specialists" value={all.length} />
            <StatTile label="Open tasks" value={all.reduce((s, r) => s + r.open, 0)} />
            <StatTile label="Overdue" value={all.reduce((s, r) => s + r.overdue, 0)} tone={all.some((r) => r.overdue) ? "bad" : "default"} />
            <StatTile label="Busiest" value={busiest ? busiest.name.split(" ")[0] : "—"} hint={busiest ? `${busiest.open} open tasks` : undefined} />
          </StatRow>
          <Panel
            title="By job role"
            flush
            action={
              <div className="flex items-center gap-2">
                <Select aria-label="Filter by job role" value={spec} onChange={(e) => setSpec(e.target.value)}>
                  <option value="">All job roles</option>
                  {CRAFT_SPECIALTY_OPTIONS.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </Select>
                <CsvButton
                  rows={rows}
                  filename="specialists"
                  columns={[
                    { header: "Name", value: (r: CraftSpecialistRow) => r.name },
                    { header: "Job role", value: (r: CraftSpecialistRow) => r.specialtyLabel },
                    { header: "Department", value: (r: CraftSpecialistRow) => r.department ?? "" },
                    { header: "Open", value: (r: CraftSpecialistRow) => r.open },
                    { header: "Overdue", value: (r: CraftSpecialistRow) => r.overdue },
                    { header: "Due this week", value: (r: CraftSpecialistRow) => r.dueThisWeek },
                    { header: "Done (30d)", value: (r: CraftSpecialistRow) => r.doneLast30 },
                    { header: "Hours (30d)", value: (r: CraftSpecialistRow) => r.hoursLast30 },
                  ]}
                />
              </div>
            }
          >
            <DataTable
              rows={rows}
              rowKey={(r) => r.id}
              rowHref={(r) => r.href}
              empty="No one has a job role yet. Set it on the Users page."
              columns={[
                { key: "n", header: "Name", cell: (r) => <span className="font-medium">{r.name}</span> },
                { key: "s", header: "Job role", cell: (r) => <Badge tone="dark">{r.specialtyLabel}</Badge> },
                { key: "d", header: "Department", cell: (r) => <span className="text-ink-muted">{r.department ?? "—"}</span> },
                { key: "o", header: "Open", align: "right", cell: (r) => r.open },
                { key: "l", header: "Overdue", align: "right", cell: (r) => (r.overdue ? <span className="font-medium text-red">{r.overdue}</span> : 0) },
                { key: "w", header: "Due this week", align: "right", cell: (r) => r.dueThisWeek },
                { key: "x", header: "Done (30d)", align: "right", cell: (r) => r.doneLast30 },
                { key: "h", header: "Hours (30d)", align: "right", cell: (r) => `${r.hoursLast30}h` },
              ]}
            />
          </Panel>
        </div>
      )}
    </div>
  );
}
