"use client";

import Link from "next/link";
import { useState } from "react";
import { deliverableStatusLabels, deliverPeriodLabel, formatINR, planStatusLabels, type DeliverCyclesView, type DeliverableStatus, type PlanStatus } from "@bmu/shared";
import { Badge, Button } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

const day = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });

/** Monthly retainer months: quota vs planned vs approved, carried-over items, the month's invoice and "Start next month". */
export function CyclesPanel({ engagementId, onStarted }: { engagementId: string; onStarted?: () => void }) {
  const loaded = useLoad(() => api.deliver.cycles(engagementId));
  const [fresh, setFresh] = useState<DeliverCyclesView>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const v = fresh ?? loaded.data;
  if (!v) return loaded.error ? <p className="text-sm text-red">{loaded.error}</p> : null;
  if (!v.isRetainer) return null;

  async function start() {
    setBusy(true);
    setError(undefined);
    try {
      setFresh(await api.deliver.startNextCycle(engagementId));
      onStarted?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-6 border border-border bg-surface-raised" data-testid="cycles-panel">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <h2 className="text-[15px] font-semibold tracking-tight">Monthly retainer</h2>
          <p className="mt-0.5 text-xs text-ink-muted">
            Each month starts on its own on the 1st with deliverables from the package quota, a plan to approve and the month&apos;s invoice. Unused quota rolls over to the next month.
          </p>
        </div>
        {v.nextPeriod && (
          <div className="text-right">
            <Button disabled={busy || !v.can.startNext} onClick={start}>
              {busy ? "Starting…" : `Start ${deliverPeriodLabel(v.nextPeriod)}`}
            </Button>
            {!v.can.startNext && v.startNextBlocked && <p className="mt-1 max-w-64 text-xs text-ink-muted">{v.startNextBlocked}</p>}
          </div>
        )}
      </header>
      {error && <p className="mx-5 mt-4 border border-red bg-red/10 px-3 py-2 text-sm">{error}</p>}
      <div className="divide-y divide-border">
        {v.cycles.map((c, i) => (
          <div key={c.id} className="px-5 py-4 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-medium">
                {c.label}
                {i === 0 && <span className="ml-2 text-xs font-normal text-ink-muted">current</span>}
              </p>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                {c.startedBy && <span className="text-ink-muted">Started {c.startedBy === "auto" ? "automatically" : "by the AM"} {day.format(new Date(c.startedAt))}</span>}
                {c.planStatus && <Badge tone={c.planStatus === "approved" ? "green" : "neutral"}>Plan: {planStatusLabels[c.planStatus as PlanStatus] ?? c.planStatus}</Badge>}
                {c.invoice && (
                  <Badge tone={c.invoice.status === "paid" ? "green" : "dark"}>
                    {c.invoice.number} · {formatINR(c.invoice.totalPaise)} · {c.invoice.status === "paid" ? "paid" : "unpaid"}
                  </Badge>
                )}
              </div>
            </div>
            {c.heldForPayment && <p className="mt-2 border border-amber bg-amber/15 px-3 py-1.5 text-xs">{c.heldForPayment}</p>}
            {c.quota.length > 0 && (
              <table className="mt-3 w-full text-xs">
                <thead className="text-left text-ink-muted">
                  <tr>
                    <th className="py-1 font-normal">Quota</th>
                    <th className="py-1 text-right font-normal">Included</th>
                    <th className="py-1 text-right font-normal">Planned</th>
                    <th className="py-1 text-right font-normal">Approved</th>
                  </tr>
                </thead>
                <tbody>
                  {c.quota.map((q) => (
                    <tr key={q.type} className="border-t border-border">
                      <td className="py-1">{q.label}</td>
                      <td className="py-1 text-right tabular-nums">{q.count}</td>
                      <td className={`py-1 text-right tabular-nums ${q.planned < q.count ? "text-[#9a6b00]" : ""}`}>{q.planned}</td>
                      <td className="py-1 text-right tabular-nums">{q.approved}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-muted">
              {c.carriedOver.length > 0 && <span>Carried over from {deliverPeriodLabel(c.carriedOver[0].fromPeriod)}: {c.carriedOver.map((x) => `${x.count} ${x.type}`).join(", ")}</span>}
              {c.unused.length > 0 && <span className="text-[#9a6b00]">Unused this month (rolls over): {c.unused.map((x) => `${x.count} ${x.type}`).join(", ")}</span>}
              <span>
                {c.deliverables.approved} of {c.deliverables.total} deliverables approved
              </span>
            </div>
            {i > 0 && c.openDeliverables.length > 0 && (
              <ul className="mt-2 space-y-1 text-xs">
                {c.openDeliverables.slice(0, 6).map((d) => (
                  <li key={d.id}>
                    <Link href={`/team/deliverables/${d.id}`} className="underline">
                      {d.title}
                    </Link>{" "}
                    <span className="text-ink-muted">· {deliverableStatusLabels[d.status as DeliverableStatus] ?? d.status}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
