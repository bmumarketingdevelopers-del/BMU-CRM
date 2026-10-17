"use client";

// v30: today's attendance by department, on the Founder's Weekly Review and HR's Attendance page.
// Department Heads see only their own department(s). Hidden for people without attendance access.
import Link from "next/link";
import type { AttendanceTodaySummary } from "@bmu/shared";
import { DataTable, Panel } from "@/components/dash";
import { LoadState } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

const day = (ymd: string) => new Intl.DateTimeFormat("en-IN", { weekday: "long", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${ymd}T00:00:00Z`));

export function AttendanceTodayByDepartment({ data, link = true }: { data?: AttendanceTodaySummary; link?: boolean }) {
  const loaded = useLoad(() => (data ? Promise.resolve(data) : api.adminOrg.attendanceToday()), { live: false });
  const d = data ?? loaded.data;
  // No access (403) or nothing to show: hide quietly on dashboards.
  if (!d) return loaded.error ? null : <LoadState loading={loaded.loading} />;
  if (!d.departments.length) return null;
  const off = d.todayKind.kind !== "working";
  const t = d.totals;
  return (
    <Panel
      className="min-w-0"
      title={`Attendance today by department${d.scope.all ? "" : ` · ${d.scope.departments.join(", ")}`}`}
      subtitle={
        off
          ? `${day(d.today)} is ${d.todayKind.kind === "holiday" ? `a holiday${d.todayKind.label ? ` (${d.todayKind.label})` : ""}` : "a weekly off"}. No check-in is needed.`
          : `${day(d.today)} · ${t.in} of ${t.total} in · ${t.late} late (after ${d.workingHours.start} + ${d.workingHours.graceMinutes} min) · ${t.onLeave} on leave · ${t.notIn} not checked in${d.missedCheckOutYesterday ? ` · ${d.missedCheckOutYesterday} missed check-out last working day` : ""}`
      }
      action={
        link ? (
          <Link href="/admin/attendance" className="text-xs text-ink-muted hover:text-ink">
            Open attendance →
          </Link>
        ) : undefined
      }
      flush
    >
      <div data-testid="attendance-by-department">
        <DataTable
          rows={d.departments}
          rowKey={(r) => r.id ?? "none"}
          columns={[
            { key: "dept", header: "Department", cell: (r) => <span className="font-medium">{r.name}</span> },
            { key: "people", header: "People", align: "right", cell: (r) => r.total },
            { key: "in", header: "In", align: "right", cell: (r) => r.in },
            { key: "late", header: "Late", align: "right", cell: (r) => (r.late ? <span className="text-[#9a6b00]">{r.late}</span> : "—") },
            { key: "leave", header: "On leave", align: "right", cell: (r) => r.onLeave || "—" },
            { key: "notin", header: "Not checked in", align: "right", cell: (r) => (r.notIn ? <span className="text-[#b4432c]">{r.notIn}</span> : r.notYet ? <span className="text-ink-muted">{r.notYet} not yet</span> : "—") },
            { key: "out", header: "Checked out", align: "right", cell: (r) => r.checkedOut || "—" },
          ]}
        />
      </div>
    </Panel>
  );
}
