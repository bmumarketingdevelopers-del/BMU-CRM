"use client";

import { useState } from "react";
import type { ClientHealthRow, HealthRisk } from "@bmu/shared";
import { DataTable, Panel, StackBar, StatRow, StatTile, Tabs } from "@/components/dash";
import { Badge, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { WithData, fmtDate } from "../_insights/kit";

const riskLabel: Record<HealthRisk, string> = { healthy: "Healthy", watch: "Watch", at_risk: "At risk" };
const riskTone: Record<HealthRisk, "green" | "amber" | "red"> = { healthy: "green", watch: "amber", at_risk: "red" };
type Filter = "all" | HealthRisk;

export default function ClientHealthPage() {
  const state = useLoad(() => api.insights.clientHealth());
  const [filter, setFilter] = useState<Filter>("all");
  return (
    <>
      <PageTitle title="Client Health" subtitle="A 0–100 score per client from late payments, missed reply times, extra revisions, silence and blockers." />
      <WithData state={state}>
        {(rows) => {
          const count = (r: HealthRisk) => rows.filter((x) => x.risk === r).length;
          const shown = filter === "all" ? rows : rows.filter((r) => r.risk === filter);
          const avg = rows.length ? Math.round(rows.reduce((s, r) => s + r.score, 0) / rows.length) : null;
          return (
            <div className="space-y-8">
              <StatRow cols={4}>
                <StatTile label="Average score" value={avg ?? "—"} hint={`${rows.length} clients`} />
                <StatTile label="Healthy" value={count("healthy")} tone="good" hint="75 and above" />
                <StatTile label="Watch" value={count("watch")} tone={count("watch") ? "warn" : "default"} hint="50 to 74" />
                <StatTile label="At risk" value={count("at_risk")} tone={count("at_risk") ? "bad" : "default"} hint="below 50" />
              </StatRow>
              {rows.length > 0 && (
                <Panel className="min-w-0">
                  <StackBar
                    parts={[
                      { label: "Healthy", value: count("healthy"), tone: "green" },
                      { label: "Watch", value: count("watch"), tone: "amber" },
                      { label: "At risk", value: count("at_risk"), tone: "red" },
                    ]}
                  />
                </Panel>
              )}
              <Panel className="min-w-0"
                title="Clients"
                subtitle="Lowest score first. Open a client for the full picture."
                flush
                action={
                  <Tabs
                    value={filter}
                    onChange={setFilter}
                    options={[
                      { value: "all", label: "All" },
                      { value: "at_risk", label: "At risk" },
                      { value: "watch", label: "Watch" },
                      { value: "healthy", label: "Healthy" },
                    ]}
                  />
                }
              >
                <DataTable<ClientHealthRow>
                  rows={shown}
                  rowKey={(r) => r.id}
                  rowHref={(r) => `/team/clients/${r.id}`}
                  empty="No clients in this group."
                  columns={[
                    { key: "name", header: "Client", cell: (r) => r.name },
                    { key: "score", header: "Score", className: "min-w-36", cell: (r) => <Score value={r.score} risk={r.risk} /> },
                    { key: "risk", header: "Risk", cell: (r) => <Badge tone={riskTone[r.risk]}>{riskLabel[r.risk]}</Badge> },
                    {
                      key: "why",
                      header: "Why",
                      className: "min-w-64",
                      cell: (r) => (r.reasons.length ? <ul className="space-y-0.5 text-xs text-ink-muted">{r.reasons.map((x) => <li key={x}>{x}</li>)}</ul> : <span className="text-xs text-ink-muted">Nothing to flag</span>),
                    },
                    { key: "last", header: "Last heard from", cell: (r) => <span className="whitespace-nowrap text-ink-muted">{r.lastClientActivityAt ? fmtDate(r.lastClientActivityAt) : "Never"}</span> },
                    { key: "am", header: "Account manager", cell: (r) => r.am ?? <span className="text-ink-muted">None</span> },
                  ]}
                />
              </Panel>
            </div>
          );
        }}
      </WithData>
    </>
  );
}

/** Score out of 100 as a thin bar (the kit's Meter prints a percent sign). */
function Score({ value, risk }: { value: number; risk: HealthRisk }) {
  const bg = { healthy: "bg-green", watch: "bg-amber", at_risk: "bg-red" }[risk];
  return (
    <div className="flex items-center gap-2" title={`${value} out of 100`}>
      <div className="h-1.5 flex-1 bg-canvas">
        <div className={`h-full ${bg}`} style={{ width: `${value}%` }} />
      </div>
      <span className="w-8 text-right text-sm font-medium tabular-nums">{value}</span>
    </div>
  );
}
