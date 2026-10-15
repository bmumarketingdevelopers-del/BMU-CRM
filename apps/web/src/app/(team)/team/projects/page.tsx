"use client";

import Link from "next/link";
import { useState } from "react";
import { GATES, type EngagementRow, type FlowGateStrip } from "@bmu/shared";
import { StatRow, StatTile, Tabs } from "@/components/dash";
import { EngagementsTable, engagementStatus } from "@/components/engagements-table";
import { Badge, LoadState, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { Panel } from "@/components/dash";
import { SlaList } from "@/components/deliver/sla-list";

const DONE = ["delivered", "closed", "offboarding"];

/** Projects board by phase (one column per milestone) plus the detailed list. Read-only: gates move by approvals. */
export default function ProjectsPage() {
  const rows = useLoad(() => api.engagements.list());
  const strip = useLoad(() => api.flows.gateStrip());
  const sla = useLoad(() => api.deliver.sla());
  const [view, setView] = useState<"board" | "list">("board");
  const data = rows.data ?? [];
  const live = data.filter((e) => !DONE.includes(e.status));
  const column = (gate: string) => live.filter((e) => e.currentGate === gate);

  return (
    <>
      <PageTitle
        title="Projects"
        subtitle="Every paid service by milestone, from onboarding to final delivery. Projects move between columns when the gate's approval is given."
        action={<Tabs value={view} onChange={setView} options={[{ value: "board", label: "Board" }, { value: "list", label: "List" }]} />}
      />
      {rows.data && (
        <div className="mb-8">
          <StatRow cols={5}>
            <StatTile label="Live projects" value={live.length} />
            <StatTile label="Waiting on client inputs" value={live.filter((e) => e.requirementsOutstanding > 0).length} tone={live.some((e) => e.requirementsOutstanding > 0) ? "warn" : "default"} />
            <StatTile label="Plans due" value={live.filter((e) => e.planningDue && e.planStatus !== "approved").length} />
            <StatTile
              label="Late or at risk"
              value={sla.data ? `${sla.data.overdue} / ${sla.data.atRisk}` : "…"}
              hint={sla.data ? `${sla.data.escalated} escalated` : undefined}
              tone={sla.data?.overdue ? "bad" : sla.data?.atRisk ? "warn" : "default"}
            />
            <StatTile label="Delivered" value={data.filter((e) => e.status === "delivered").length} tone="good" />
          </StatRow>
        </div>
      )}
      {sla.data && sla.data.items.length > 0 && (
        <Panel className="mb-8" title="Delivery SLA" subtitle="Late and at-risk steps and deliverables. Steps more than a working day late are escalated to the department head automatically.">
          <SlaList items={sla.data.items} limit={8} />
        </Panel>
      )}
      {!rows.data && <LoadState loading={rows.loading} error={rows.error} />}
      {rows.data && view === "list" && <EngagementsTable />}
      {rows.data && view === "board" && (
        <div className="grid gap-4 overflow-x-auto pb-2 md:grid-cols-5">
          {GATES.map((g) => (
            <section key={g.id} className="min-w-56">
              <header className="mb-3 flex items-baseline justify-between border-b border-ink pb-2">
                <h2 className="text-sm font-semibold">
                  <span className="mr-1.5 text-ink-muted">{g.id}</span>
                  {g.name}
                </h2>
                <span className="text-xs text-ink-muted">{column(g.id).length}</span>
              </header>
              <FlowStrip s={strip.data?.find((x) => x.gate === g.id)} max={Math.max(1, ...(strip.data ?? []).map((x) => x.avgDays ?? 0))} />
              <div className="grid gap-2">
                {column(g.id).map((e) => (
                  <ProjectCard key={e.id} e={e} />
                ))}
                {column(g.id).length === 0 && <p className="py-4 text-center text-xs text-ink-muted">None</p>}
              </div>
            </section>
          ))}
        </div>
      )}
    </>
  );
}

/** Small flow summary under each column: how long projects have been in this gate, and how many are stuck. */
function FlowStrip({ s, max }: { s?: FlowGateStrip[number]; max: number }) {
  if (!s) return <div className="mb-3 h-[22px]" />;
  const pct = s.avgDays === null ? 0 : Math.max(4, (s.avgDays / max) * 100);
  return (
    <div className="mb-3" title={`${s.count} in this gate · average ${s.avgDays ?? 0} days here · ${s.stuck} stuck`}>
      <p className="truncate text-[11px] text-ink-muted">
        {s.avgDays === null ? "No projects" : `Avg ${Math.round(s.avgDays)}d in gate`}
        {s.stuck > 0 && <span className="font-medium text-[#b4432c]"> · {s.stuck} stuck</span>}
      </p>
      <div className="mt-1 h-1 bg-canvas">
        <div className={`h-1 ${s.stuck ? "bg-amber" : "bg-charcoal"}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function ProjectCard({ e }: { e: EngagementRow }) {
  return (
    <Link href={`/team/projects/${e.id}`} className="block border border-border bg-surface-raised p-3 transition-colors hover:border-ink">
      <p className="text-sm font-medium">{e.client.name}</p>
      <p className="mt-0.5 text-xs text-ink-muted">
        {e.serviceName} · <span className="capitalize">{e.tier}</span>
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <Badge tone="dark">{engagementStatus(e.status)}</Badge>
        {e.requirementsOutstanding > 0 && <Badge tone="amber">{e.requirementsOutstanding} inputs</Badge>}
        {!!e.slaOverdue && <Badge tone="red">{e.slaOverdue} overdue</Badge>}
        {!!e.slaAtRisk && <Badge tone="amber">{e.slaAtRisk} due soon</Badge>}
        {e.billingType === "monthly" && e.period && e.period !== "project" && <Badge tone="neutral">{e.period}</Badge>}
      </div>
      {e.am && <p className="mt-2 text-[11px] text-ink-muted">CM: {e.am.name}</p>}
    </Link>
  );
}
