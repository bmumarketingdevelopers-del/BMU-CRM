"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { ServiceSatisfaction } from "@bmu/shared";
import { Insight } from "@/components/charts";
import { BarList, Panel } from "@/components/dash";
import { LoadState } from "@/components/ui";
import { api } from "@/lib/api";

const day = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" });

/** Thumbs up / down from clients on finished requests, for the chosen period. */
export function SatisfactionPanel({ from, to }: { from: string; to: string }) {
  const [s, setS] = useState<ServiceSatisfaction>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let alive = true;
    api.service.satisfaction(from, to).then(
      (v) => alive && setS(v),
      (e: Error) => alive && setError(e.message),
    );
    return () => {
      alive = false;
    };
  }, [from, to]);
  return (
    <Panel className="min-w-0" title="Client satisfaction" subtitle="Thumbs up or down from clients when a request is done. Thumbs down also lowers Client Health.">
      {!s ? (
        <LoadState loading={!error} error={error} />
      ) : s.rated === 0 ? (
        <p className="py-6 text-center text-sm text-ink-muted">No ratings in this period yet. Clients are asked when a request is marked done.</p>
      ) : (
        <div className="grid gap-4" data-testid="satisfaction-panel">
          <div className="flex flex-wrap gap-6 text-sm">
            <p>
              <span className="text-2xl font-semibold tabular-nums">{s.happyPct}%</span> happy
            </p>
            <p className="text-ink-muted">
              👍 {s.up} · 👎 {s.down} · {s.rated} of {s.done} done requests rated · {s.reopened} reopened
            </p>
          </div>
          <Insight>
            {s.happyPct !== null && s.happyPct >= 85
              ? `Clients were happy with ${s.happyPct}% of rated requests.`
              : `${s.down} request${s.down === 1 ? "" : "s"} got a thumbs down; ${s.byClient[0]?.down ? `${s.byClient[0].client} had the most.` : ""}`}
            {s.reopened ? ` ${s.reopened} request${s.reopened === 1 ? " was" : "s were"} reopened within 7 days.` : ""}
          </Insight>
          <BarList items={s.byClient.slice(0, 6).map((c) => ({ label: c.client, value: c.down, note: `👍 ${c.up} · 👎 ${c.down}`, href: `/team/clients/${c.clientId}`, highlight: c.down > 0 }))} format={(n) => `${n} down`} />
          <ul className="divide-y divide-border text-sm">
            {s.recent.slice(0, 5).map((r) => (
              <li key={r.requestId} className="py-2">
                <Link href={`/team/requests/${r.requestId}`} className="hover:underline">
                  {r.value === "up" ? "👍" : "👎"} {r.client}
                </Link>
                <span className="text-xs text-ink-muted"> · {day.format(new Date(r.at))}</span>
                {r.comment && <p className="text-xs text-ink-muted">“{r.comment}”</p>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  );
}
