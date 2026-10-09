"use client";

import { use, useState } from "react";
import Link from "next/link";
import type { TeamTimesheet } from "@bmu/shared";
import { TimesheetWeek } from "@/components/timesheet-week";
import { LoadState, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

/** A manager reviewing someone's submitted week. */
export default function ReviewTimesheetPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const loaded = useLoad(() => api.teamFlows.timesheets.get(id));
  const [fresh, setFresh] = useState<TeamTimesheet>();
  const sheet = fresh ?? loaded.data;
  return (
    <>
      <Link href="/team/approvals" className="text-sm text-ink-muted hover:text-ink">
        ← Approvals
      </Link>
      <PageTitle title={sheet ? `Timesheet: ${sheet.user.name}` : "Timesheet"} subtitle={sheet ? `Week starting ${new Date(`${sheet.weekStart}T12:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}` : undefined} />
      {sheet ? <TimesheetWeek sheet={sheet} onChange={setFresh} /> : <LoadState loading={loaded.loading} error={loaded.error} />}
    </>
  );
}
