"use client";

import { use, useState } from "react";
import Link from "next/link";
import type { TeamTimesheet } from "@bmu/shared";
import { TimesheetWeek } from "@/components/timesheet-week";
import { TimerWidget } from "@/components/money/timer";
import { LoadState, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

const shift = (day: string, days: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const range = (s: TeamTimesheet) =>
  `${new Date(`${s.weekStart}T12:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short" })} – ${new Date(`${s.weekEnd}T12:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}`;

/** My weekly timesheet: task logs plus manual time, then submit for approval. */
export default function MyTimesheetPage({ searchParams }: { searchParams: Promise<{ week?: string }> }) {
  const { week } = use(searchParams);
  return <Week key={week ?? "this"} week={week} />;
}

function Week({ week }: { week?: string }) {
  const loaded = useLoad(() => api.teamFlows.timesheets.week(week));
  const [fresh, setFresh] = useState<TeamTimesheet>();
  const sheet = fresh ?? loaded.data;
  const thisWeek = !week;
  return (
    <>
      <PageTitle
        title="My timesheet"
        subtitle={sheet ? `Week of ${range(sheet)}` : "Your hours this week"}
        action={
          sheet ? (
            <div className="flex gap-2 text-sm">
              <Link className="border border-border px-3 py-1.5 hover:border-ink" href={`/team/timesheet?week=${shift(sheet.weekStart, -7)}`}>
                ← Previous week
              </Link>
              {!thisWeek && (
                <Link className="border border-border px-3 py-1.5 hover:border-ink" href={`/team/timesheet?week=${shift(sheet.weekStart, 7)}`}>
                  Next week →
                </Link>
              )}
              {!thisWeek && (
                <Link className="border border-border px-3 py-1.5 hover:border-ink" href="/team/timesheet">
                  This week
                </Link>
              )}
            </div>
          ) : undefined
        }
      />
      {thisWeek && (
        <div className="mb-6">
          <TimerWidget onLogged={() => { setFresh(undefined); loaded.reload(); }} />
        </div>
      )}
      {sheet ? <TimesheetWeek sheet={sheet} onChange={setFresh} /> : <LoadState loading={loaded.loading} error={loaded.error} />}
    </>
  );
}
