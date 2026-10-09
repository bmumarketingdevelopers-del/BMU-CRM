"use client";
// v18 project page: the invoice plan (Finance, leadership, the AM) and who is booked on the project.
import Link from "next/link";
import { Panel } from "@/components/dash";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { day } from "./kit";
import { ProjectSchedules } from "./schedules";

export function ProjectMoney({ clientId, engagementId }: { clientId: string; engagementId: string }) {
  const me = useLoad(() => api.auth.me(), { live: false });
  const bookings = useLoad(() => api.capacity.projectBookings(engagementId), { live: ["ResourceBooking"] });
  const canWrite = !!me.data?.roles.some((r) => ["founder", "admin", "finance"].includes(r));
  const seesPlan = !!me.data?.roles.some((r) => ["founder", "admin", "finance", "am_lead", "account_manager"].includes(r));
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {seesPlan && <ProjectSchedules clientId={clientId} engagementId={engagementId} canWrite={canWrite} />}
      <Panel title="Who is booked" subtitle="Hours reserved on this project per week." action={<Link href="/team/workload" className="text-sm underline">Workload</Link>}>
        {!bookings.data?.length ? (
          <p className="text-sm text-ink-muted">Nobody booked yet.</p>
        ) : (
          <ul className="divide-y divide-border text-sm" data-testid="project-bookings">
            {bookings.data.map((b) => (
              <li key={b.id} className="flex justify-between gap-2 py-2">
                <span>{b.person ?? `Wanted: ${(b.specialty ?? "someone").replaceAll("_", " ")}`}</span>
                <span className="text-ink-muted">week of {day(b.weekStart)} · {b.hours}h</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
