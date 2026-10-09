"use client";

import { BarList, ColumnChart, DataTable, Empty, Grid, Meter, Panel, StatRow, StatTile } from "@/components/dash";
import { PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { WithData, pctText } from "../_insights/kit";

const flowNames: Record<string, string> = { design: "Design", video: "Video", writing: "Writing", web: "Website", general: "General" };
const rateTone = (n: number) => (n >= 80 ? "good" : n >= 60 ? "warn" : "bad");

export default function QualityPage() {
  const state = useLoad(() => api.insights.quality());
  return (
    <>
      <PageTitle title="Quality" subtitle="How often work passes internal QC, and how much changing it needs. Last 12 weeks." />
      <WithData state={state}>
        {(q) => (
          <div className="space-y-8">
            <StatRow cols={5}>
              <StatTile label="QC pass rate" value={pctText(q.passRate)} hint={`${q.checks} checks`} tone={q.passRate === null ? "default" : rateTone(q.passRate)} />
              <StatTile label="Right first time" value={pctText(q.firstTimeRight)} hint="first draft passed QC" />
              <StatTile label="Revision rounds" value={q.avgRevisionRounds ?? "—"} hint="average per deliverable" />
              <StatTile label="Client change requests" value={q.clientChangeRequests} hint="revision requests raised" />
              <StatTile label="Most common miss" value={<span className="block text-base leading-snug">{q.topFailures[0]?.label ?? "—"}</span>} hint={q.topFailures[0] ? `${q.topFailures[0].count} times` : undefined} />
            </StatRow>

            <Panel className="min-w-0" title="Pass rate by week" subtitle="Bars show the share of checks that passed; hover for the number">
              {q.checks ? (
                <ColumnChart data={q.trend.map((t) => ({ label: t.label, value: t.passRate ?? 0 }))} format={(n) => `${Math.round(n)}%`} height={160} />
              ) : (
                <Empty>No QC checks in the last 12 weeks.</Empty>
              )}
            </Panel>

            <Grid>
              <Panel className="min-w-0" title="By department" flush>
                <DataTable
                  rows={q.byDepartment}
                  rowKey={(r) => r.label}
                  empty="No QC checks yet."
                  columns={[
                    { key: "label", header: "Department", cell: (r) => <span className="font-medium">{r.label}</span> },
                    { key: "checks", header: "Checks", align: "right", cell: (r) => r.checks },
                    { key: "rate", header: "Pass rate", className: "min-w-40", cell: (r) => <Meter value={r.passRate} tone={rateTone(r.passRate)} /> },
                  ]}
                />
              </Panel>
              <Panel className="min-w-0" title="By kind of work" flush>
                <DataTable
                  rows={q.byFlow}
                  rowKey={(r) => r.label}
                  empty="No QC checks yet."
                  columns={[
                    { key: "label", header: "Flow", cell: (r) => <span className="font-medium">{flowNames[r.label] ?? r.label}</span> },
                    { key: "checks", header: "Checks", align: "right", cell: (r) => r.checks },
                    { key: "rate", header: "Pass rate", className: "min-w-40", cell: (r) => <Meter value={r.passRate} tone={rateTone(r.passRate)} /> },
                  ]}
                />
              </Panel>
            </Grid>

            <Panel className="min-w-0" title="What QC catches most" subtitle="Checklist items marked as not OK">
              <BarList items={q.topFailures.map((f, i) => ({ label: f.label, value: f.count, highlight: i === 0 }))} format={(n) => `${n}×`} />
            </Panel>
          </div>
        )}
      </WithData>
    </>
  );
}
