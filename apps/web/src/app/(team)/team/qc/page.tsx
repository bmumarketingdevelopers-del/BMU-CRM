"use client";

import Link from "next/link";
import { LoadState, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

const when = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });

export default function QcQueuePage() {
  const q = useLoad(() => api.qc.queue());
  return (
    <>
      <PageTitle title="QC queue" subtitle="Nothing reaches a client without passing QC. Oldest first. Results stay internal." />
      {!q.data ? (
        <LoadState loading={q.loading} error={q.error} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] bg-surface-raised text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[11px] uppercase tracking-[0.12em] text-ink-muted">
                <th className="px-3 py-2">Deliverable</th>
                <th className="px-3 py-2">Client</th>
                <th className="px-3 py-2">Version</th>
                <th className="px-3 py-2">Made by</th>
                <th className="px-3 py-2">Waiting since</th>
              </tr>
            </thead>
            <tbody>
              {q.data.map((r) => (
                <tr key={r.deliverableId} className="border-b border-border">
                  <td className="px-3 py-2">
                    <Link href={`/team/deliverables/${r.deliverableId}`} className="font-medium underline">
                      {r.title}
                    </Link>
                    <div className="text-xs capitalize text-ink-muted">{r.type}</div>
                  </td>
                  <td className="px-3 py-2">
                    {r.client}
                    <div className="text-xs text-ink-muted">{r.serviceName}</div>
                  </td>
                  <td className="px-3 py-2">v{r.versionNumber}</td>
                  <td className="px-3 py-2">{r.uploadedBy}</td>
                  <td className="px-3 py-2">{when.format(new Date(r.waitingSince))}</td>
                </tr>
              ))}
              {q.data.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-6 text-center text-ink-muted">
                    The queue is empty.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
