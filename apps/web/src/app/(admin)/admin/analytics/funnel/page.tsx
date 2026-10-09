"use client";

import { useState } from "react";
import { leadStageLabels, type LeadStage, type SalesFunnelBreakdown, type SalesFunnelView } from "@bmu/shared";
import { CsvButton, Donut, FunnelChart, LineChart, type Period } from "@/components/charts";
import { BarList, DataTable, Grid, KeyValues, Panel, StatRow, StatTile, Tabs, type Column } from "@/components/dash";
import { Badge } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { Insights, PeriodLine, PeriodPage, WithData, change, fmtDate, inr, rupees, useHash } from "../_sales/kit";

export default function FunnelPage() {
  return (
    <PeriodPage title="Sales Funnel" subtitle="How new enquiries move from first contact to a paid client, and where we lose them.">
      {(p) => <FunnelBody period={p} />}
    </PeriodPage>
  );
}

function FunnelBody({ period }: { period: Period }) {
  const state = useLoad(() => api.analytics.funnel({ from: period.from, to: period.to }));
  return <WithData state={state}>{(d) => <Funnel d={d} />}</WithData>;
}

const hoursText = (h: number | null) => (h === null ? "—" : h < 1 ? `${Math.round(h * 60)} min` : h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} days`);

function Funnel({ d }: { d: SalesFunnelView }) {
  const [by, setBy] = useState<"source" | "service">("source");
  const hash = useHash("leads");
  const stageFilter = hash.startsWith("stage-") ? hash.slice(6) : "lead";
  const stageIdx = Math.max(0, d.stages.findIndex((s) => s.key === stageFilter));
  const filtered = d.leads.filter((l) => d.stages.findIndex((s) => s.key === l.reached) >= stageIdx);
  const proposals = d.stages.find((s) => s.key === "proposal_sent")!;
  const rows = by === "source" ? d.bySource : d.byService;

  const breakdownCols: Column<SalesFunnelBreakdown>[] = [
    { key: "label", header: by === "source" ? "Source" : "Service", cell: (r) => <span className="font-medium">{r.label}</span> },
    { key: "leads", header: "Leads", align: "right", cell: (r) => r.leads },
    { key: "prop", header: "Proposals", align: "right", cell: (r) => r.proposals },
    { key: "won", header: "Won", align: "right", cell: (r) => r.won },
    { key: "conv", header: "Conversion", align: "right", cell: (r) => (r.conversionPct === null ? "—" : `${Math.round(r.conversionPct)}%`) },
    ...(d.canSeeMoney ? [{ key: "rev", header: "Value won", align: "right" as const, cell: (r: SalesFunnelBreakdown) => inr(r.revenuePaise ?? 0) }] : []),
  ];

  return (
    <div className="space-y-8">
      <PeriodLine period={d.period} />
      <StatRow cols={4}>
        <StatTile label="New leads" value={d.leadsCount} delta={change(d.leadsCount, d.prevLeadsCount)} hint="enquiries in this period" href="#stage-lead" />
        <StatTile label="Proposals sent" value={proposals.count} delta={change(proposals.count, proposals.prevCount)} hint="from these leads" href="#stage-proposal_sent" />
        <StatTile label="Win rate" value={d.winRatePct === null ? "—" : `${Math.round(d.winRatePct)}%`} delta={change(d.winRatePct, d.prevWinRatePct, { unit: "pct" })} hint="of deals won or lost" tone={d.winRatePct !== null && d.winRatePct >= 30 ? "good" : "default"} />
        <StatTile label="First reply (median)" value={hoursText(d.speed.medianHours)} delta={change(d.speed.medianHours, d.speed.prevMedianHours, { lowerIsBetter: true })} hint={d.speed.within24hPct === null ? "no replies yet" : `${Math.round(d.speed.within24hPct)}% within a day`} />
      </StatRow>

      <Panel className="min-w-0" title="Funnel" subtitle="Leads that came in during this period and the furthest stage each reached. Click a stage to list its leads.">
        <FunnelChart
          steps={d.stages.map((s) => ({
            label: s.label,
            value: s.count,
            href: `#stage-${s.key}`,
            note: s.medianDaysFromPrev === null ? (s.prevCount ? `before: ${s.prevCount}` : undefined) : `${s.medianDaysFromPrev} days · before: ${s.prevCount}`,
          }))}
        />
        <p className="mt-3 text-xs text-ink-muted">Days = median time from the previous stage. &ldquo;Before&rdquo; = the same stage for leads from the previous period.</p>
        <Insights items={d.insights} />
      </Panel>

      <Panel
        className="min-w-0"
        title="Where good leads come from"
        subtitle={d.canSeeMoney ? "Conversion = leads that accepted a proposal. Value won = accepted proposals, before GST." : "Conversion = leads that accepted a proposal."}
        action={
          <div className="flex flex-wrap gap-2">
            <Tabs value={by} onChange={setBy} options={[{ value: "source", label: "By source" }, { value: "service", label: "By service" }]} />
            <CsvButton
              rows={rows}
              filename={`funnel-by-${by}`}
              columns={[
                { header: by === "source" ? "Source" : "Service", value: (r) => r.label },
                { header: "Leads", value: (r) => r.leads },
                { header: "Proposals", value: (r) => r.proposals },
                { header: "Won", value: (r) => r.won },
                { header: "Conversion %", value: (r) => r.conversionPct },
                ...(d.canSeeMoney ? [{ header: "Value won (₹)", value: (r: SalesFunnelBreakdown) => rupees(r.revenuePaise ?? 0) }] : []),
              ]}
            />
          </div>
        }
      >
        <div className="grid min-w-0 gap-8 lg:grid-cols-[1fr_1.4fr]">
          <div className="min-w-0">
          <BarList items={rows.filter((r) => r.leads).map((r) => ({ label: r.label, value: r.conversionPct ?? 0, note: `${r.won}/${r.leads}`, highlight: r === [...rows].sort((a, b) => (b.conversionPct ?? 0) - (a.conversionPct ?? 0))[0] }))} format={(n) => `${Math.round(n)}%`} max={100} />
          </div>
          <div className="-mx-5 -mb-5 min-w-0 border-t border-border lg:mx-0 lg:mb-0 lg:border-0">
            <DataTable rows={rows} rowKey={(r) => r.key} columns={breakdownCols} empty="No leads in this period." />
          </div>
        </div>
      </Panel>

      <Grid>
        <Panel className="min-w-0" title="Why we lose deals" subtitle="Reasons given for leads from this period that were lost">
          <Donut parts={d.lostReasons.map((r) => ({ label: r.label, value: r.count }))} center={<span className="text-lg font-semibold">{d.lostReasons.reduce((s, r) => s + r.count, 0)}</span>} />
        </Panel>
        <Panel className="min-w-0" title="Win rate by month" subtitle="Deals won ÷ deals decided that month, last 12 months">
          <LineChart labels={d.winRateTrend.map((m) => m.label)} series={[{ key: "wr", label: "Win rate", values: d.winRateTrend.map((m) => m.winRatePct), color: "green" }]} format={(n) => `${Math.round(n)}%`} height={170} />
        </Panel>
      </Grid>

      <Panel className="min-w-0" title="Speed to first contact" subtitle="From enquiry to the first stage change by the sales team">
        <KeyValues
          items={[
            { k: "Median time to first reply", v: hoursText(d.speed.medianHours) },
            { k: "Previous period", v: hoursText(d.speed.prevMedianHours) },
            { k: "Replied within 24 hours", v: d.speed.within24hPct === null ? "—" : `${Math.round(d.speed.within24hPct)}%` },
            { k: "Leads measured", v: d.speed.measured },
          ]}
        />
      </Panel>

      <div id="leads" />
      <Panel
        className="min-w-0"
        title={stageIdx === 0 ? "Leads in this period" : `Leads that reached “${d.stages[stageIdx].label}”`}
        subtitle={`${filtered.length} lead${filtered.length === 1 ? "" : "s"}. Open a lead in the pipeline, or a won client in Client 360.`}
        flush
        action={
          <div className="flex flex-wrap items-center gap-2">
            {stageIdx > 0 && (
              <a href="#stage-lead" className="text-sm text-ink-muted hover:text-ink">
                Show all
              </a>
            )}
            <CsvButton
              rows={filtered}
              filename="funnel-leads"
              columns={[
                { header: "Lead", value: (l) => l.name },
                { header: "Company", value: (l) => l.company },
                { header: "Source", value: (l) => l.source },
                { header: "Stage now", value: (l) => leadStageLabels[l.stage as LeadStage] ?? l.stage },
                { header: "Furthest stage", value: (l) => d.stages.find((s) => s.key === l.reached)?.label },
                { header: "Lost reason", value: (l) => l.lostReason },
                { header: "Owner", value: (l) => l.owner },
                { header: "Came in", value: (l) => l.createdAt.slice(0, 10) },
                ...(d.canSeeMoney ? [{ header: "Value (₹, before GST)", value: (l: SalesFunnelView["leads"][number]) => (l.valuePaise === null ? "" : rupees(l.valuePaise)) }] : []),
              ]}
            />
          </div>
        }
      >
        <DataTable
          rows={filtered}
          rowKey={(l) => l.id}
          rowHref={(l) => (l.clientId ? `/team/clients/${l.clientId}` : "/admin/pipeline")}
          empty="No leads at this stage."
          columns={[
            { key: "name", header: "Lead", cell: (l) => <span>{l.company ?? l.name}</span> },
            { key: "src", header: "Source", cell: (l) => <span className="text-ink-muted">{l.source}</span> },
            {
              key: "stage",
              header: "Stage now",
              cell: (l) => (
                <span title={l.lostReason ?? undefined}>
                  <Badge tone={l.stage === "won" ? "green" : l.lost ? "red" : "neutral"}>{leadStageLabels[l.stage as LeadStage] ?? l.stage}</Badge>
                </span>
              ),
            },
            { key: "reached", header: "Got to", cell: (l) => <span className="text-ink-muted">{d.stages.find((s) => s.key === l.reached)?.label}</span> },
            { key: "owner", header: "Owner", cell: (l) => <span className="text-ink-muted">{l.owner ?? "—"}</span> },
            { key: "in", header: "Came in", cell: (l) => <span className="whitespace-nowrap text-ink-muted">{fmtDate(l.createdAt)}</span> },
            ...(d.canSeeMoney ? [{ key: "val", header: "Value", align: "right" as const, cell: (l: SalesFunnelView["leads"][number]) => (l.valuePaise === null ? "—" : inr(l.valuePaise)) }] : []),
          ]}
        />
      </Panel>
    </div>
  );
}
