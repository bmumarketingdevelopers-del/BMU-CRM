"use client";

import Link from "next/link";
import { useState } from "react";
import { formatINR, type FlowItem, type FlowStageKey } from "@bmu/shared";
import { CsvButton, deltaVs, Insight, PeriodPicker, usePeriod, type Period } from "@/components/charts";
import { DataTable, Panel, StatRow, StatTile } from "@/components/dash";
import { Badge, LoadState, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { FlowDiagram, FlowDrawer } from "./flow-map";

const fmtDays = (n: number | null) => (n === null ? "—" : `${Math.round(n)} days`);

export function FlowMapPage() {
  const { period, setPeriod } = usePeriod("90d");
  return (
    <>
      <PageTitle
        title="Business flow map"
        subtitle="The whole agency on one line: where every lead, proposal and project is right now, how fast it moves, and what is stuck."
        action={<PeriodPicker value={period} onChange={setPeriod} />}
      />
      <FlowBody key={`${period.from}-${period.to}`} period={period} />
    </>
  );
}

function FlowBody({ period }: { period: Period }) {
  const state = useLoad(() => api.flows.map(period.from, period.to));
  const [open, setOpen] = useState<FlowStageKey | null>(null);
  const map = state.data;
  if (!map) return <LoadState loading={state.loading} error={state.error} />;
  const node = open ? map.nodes.find((n) => n.key === open) : undefined;
  const { health } = map;
  const stuck = map.nodes.flatMap((n) => n.items.filter((i) => i.severity !== "ok").map((i) => ({ ...i, stage: n })));
  const empty = map.nodes.every((n) => n.count === 0);

  return (
    <div className="grid gap-6">
      <Panel
        title="Flow right now"
        subtitle="Boxes show live items, value and average days in the stage. Arrows show the share that moved on in this period (with the count underneath). Tap a box to see its items."
      >
        {empty ? <p className="py-8 text-center text-sm text-ink-muted">Nothing in the flow yet. New enquiries from the website appear here.</p> : <FlowDiagram map={map} selected={open} onSelect={(k) => setOpen(k as FlowStageKey)} />}
        <div className="mt-5 flex flex-wrap gap-x-5 gap-y-1 border-t border-border pt-3 text-xs text-ink-muted">
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 bg-amber" /> Some items stuck (over 2× the usual time)
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 bg-red" /> Past a plan deadline or badly stuck
          </span>
          <span>▲▼ conversion vs the previous period</span>
        </div>
      </Panel>

      <StatRow>
        <StatTile label="Items in flow" value={health.inFlow} hint="Leads to offboarding, excluding steady retainers" />
        <StatTile label="Stuck items" value={health.stuck} tone={health.stuck ? "warn" : "good"} hint={health.stuck ? "Open a red or amber box" : "Everything is moving"} />
        <StatTile label="Lead → advance paid" value={fmtDays(health.avgLeadToPaidDays)} delta={health.avgLeadToPaidDays !== null ? deltaVs(health.avgLeadToPaidDays, health.prev.avgLeadToPaidDays, { lowerIsBetter: true }) : undefined} hint="Average, deals paid in period" />
        <StatTile label="Advance paid → final delivery" value={fmtDays(health.avgPaidToG5Days)} delta={health.avgPaidToG5Days !== null ? deltaVs(health.avgPaidToG5Days, health.prev.avgPaidToG5Days, { lowerIsBetter: true }) : undefined} hint="Average, projects delivered in period" />
      </StatRow>

      {map.insights.length > 0 && (
        <div>
          {map.insights.map((i, k) => (
            <Insight key={k} tone={i.tone}>
              {i.text}
            </Insight>
          ))}
        </div>
      )}

      <Panel
        title="Stuck right now"
        subtitle="Every flagged item across the flow, worst first"
        flush
        action={
          <CsvButton
            rows={stuck}
            filename="stuck-items"
            columns={[
              { header: "Stage", value: (i) => `${i.stage.tag} ${i.stage.label}` },
              { header: "Item", value: (i: FlowItem) => i.title },
              { header: "Detail", value: (i) => i.subtitle },
              { header: "Days", value: (i) => Math.round(i.days) },
              { header: "Why", value: (i) => i.reason ?? "" },
              { header: "Owner", value: (i) => i.owner ?? "" },
            ]}
          />
        }
      >
        <DataTable
          rows={[...stuck].sort((a, b) => (a.severity === b.severity ? b.days - a.days : a.severity === "red" ? -1 : 1))}
          rowKey={(i) => `${i.stage.key}-${i.id}`}
          rowHref={(i) => i.href}
          empty="Nothing is stuck. Every item is moving within its usual time."
          columns={[
            { key: "s", header: "Stage", cell: (i) => <span className="whitespace-nowrap text-xs text-ink-muted">{i.stage.tag !== "Sell" && i.stage.tag !== "Active" && i.stage.tag !== "Exit" ? `${i.stage.tag} · ` : ""}{i.stage.label}</span> },
            { key: "i", header: "Item", cell: (i) => <span>{i.title}<span className="block text-xs font-normal text-ink-muted">{i.subtitle}</span></span> },
            { key: "r", header: "Why", cell: (i) => <Badge tone={i.severity === "red" ? "red" : "amber"}>{i.reason}</Badge> },
            { key: "v", header: "Value", align: "right", cell: (i) => (i.valuePaise ? formatINR(i.valuePaise) : "—") },
          ]}
        />
      </Panel>

      <p className="text-xs text-ink-muted">
        Period {map.from} to {map.to}. Projects move between gates through approvals; see <Link href="/team/projects" className="underline hover:text-ink">Projects</Link> for the board.
      </p>
      {node && <FlowDrawer node={node} onClose={() => setOpen(null)} />}
    </div>
  );
}

