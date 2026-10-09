"use client";

import { useEffect, useState } from "react";
import { formatINR, requestStatusLabels, requestTypeLabels, type ClientReport, type RequestStatus, type RequestType } from "@bmu/shared";
import { BarList, DataTable, Empty, Grid, Meter, Panel, StatRow, StatTile } from "@/components/dash";
import { GateTrack } from "@/components/gate-track";
import { fmtDate, fmtDay, istMonth, monthLabel, shiftMonth } from "@/components/workspace/format";
import { Badge, Button, LoadState, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";

const hoursLabel = (h: number | null) => (h === null ? "—" : h < 24 ? `${Math.round(h)} h` : `${Math.round((h / 24) * 10) / 10} days`);
// Hide the app sidebar and page chrome when printing the report.
const printCss = "@media print { aside, nav { display: none !important; } main { padding: 0 !important; background: white !important; } @page { margin: 16mm; } }";

export default function ReportsPage() {
  const [month, setMonth] = useState(istMonth());
  const [r, setR] = useState<ClientReport>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let live = true;
    api.clientWorkspace
      .report(month)
      .then((d) => {
        if (live) {
          setR(d);
          setError(undefined);
        }
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [month]);
  const ready = r?.period === month;

  return (
    <div className="[&_.grid>*]:min-w-0">
      <style>{printCss}</style>
      <PageTitle
        title="Monthly report"
        subtitle={`What we delivered together${r ? ` for ${r.client.name}` : ""}, month by month.`}
        action={
          <div className="flex items-center gap-2 print:hidden">
            <Button variant="secondary" className="px-3" onClick={() => setMonth(shiftMonth(month, -1))} aria-label="Previous month">
              ←
            </Button>
            <input type="month" value={month} max={istMonth()} onChange={(e) => e.target.value && setMonth(e.target.value)} className="border border-border bg-surface-raised px-2 py-1.5 text-sm" aria-label="Report month" />
            <Button variant="secondary" className="px-3" onClick={() => setMonth(shiftMonth(month, 1))} disabled={month >= istMonth()} aria-label="Next month">
              →
            </Button>
            <Button onClick={() => window.print()}>Print</Button>
          </div>
        }
      />
      {error && <LoadState loading={false} error={error} />}
      {!ready ? (
        !error && <LoadState loading />
      ) : (
        <div className="grid gap-6">
          <p className="hidden text-sm print:block">
            {r.client.name} · {r.periodLabel} · prepared by BMU Marketing
          </p>
          <h2 className="text-lg font-semibold tracking-tight">{monthLabel(month)}</h2>
          <StatRow cols={5}>
            <StatTile label="Deliverables approved" value={r.stats.deliverablesApproved} tone={r.stats.deliverablesApproved ? "good" : "default"} />
            <StatTile label="Drafts reviewed" value={r.stats.draftsReviewed} hint="Approvals and change requests" />
            <StatTile label="Average time to approve" value={hoursLabel(r.stats.avgApprovalHours)} hint="From draft shared to approval" />
            <StatTile label="Requests resolved" value={r.stats.requestsResolved} />
            <StatTile label="First replies on time" value={r.stats.onTimeFirstReplyPct === null ? "—" : `${r.stats.onTimeFirstReplyPct}%`} tone={r.stats.onTimeFirstReplyPct !== null && r.stats.onTimeFirstReplyPct < 80 ? "warn" : "default"} hint="Within the promised working hours" />
          </StatRow>

          <Panel title="Approved work" subtitle={`${r.approved.length} item${r.approved.length === 1 ? "" : "s"} signed off this month`} flush>
            <DataTable
              rows={r.approved}
              rowKey={(a) => a.id}
              empty="Nothing was approved this month."
              columns={[
                { key: "t", header: "Deliverable", cell: (a) => <span className="font-medium">{a.title}</span> },
                { key: "s", header: "Service", cell: (a) => a.serviceName },
                { key: "v", header: "Version", align: "right", cell: (a) => (a.version ? `v${a.version}` : "—") },
                { key: "d", header: "Approved", align: "right", cell: (a) => fmtDate.format(new Date(a.approvedAt)) },
              ]}
            />
          </Panel>

          <Grid>
            <Panel title="Requests" subtitle={`${r.requests.opened} raised · ${r.requests.resolved} resolved`}>
              {r.requests.byType.length ? (
                <BarList items={r.requests.byType.map((t) => ({ label: requestTypeLabels[t.type as RequestType]?.client ?? t.type, value: t.count }))} />
              ) : (
                <Empty>No requests raised this month.</Empty>
              )}
              {r.requests.items.length > 0 && (
                <ul className="mt-5 divide-y divide-border border-t border-border text-sm">
                  {r.requests.items.map((q) => (
                    <li key={q.id} className="flex items-center justify-between gap-3 py-2.5">
                      <span className="min-w-0 truncate">{q.description}</span>
                      <span className="flex shrink-0 items-center gap-2 text-xs text-ink-muted">
                        {fmtDay.format(new Date(q.createdAt))}
                        <Badge tone={q.status === "done" ? "green" : q.status === "declined" ? "red" : "neutral"}>{requestStatusLabels[q.status as RequestStatus]?.client ?? q.status}</Badge>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
            {r.spend ? (
              <Panel title="Spend this month" subtitle="Including GST">
                <div className="grid grid-cols-2 gap-px border border-border bg-border">
                  <StatTile label="Invoiced" value={formatINR(r.spend.invoicedPaise)} />
                  <StatTile label="Paid" value={formatINR(r.spend.paidPaise)} tone={r.spend.paidPaise ? "good" : "default"} />
                </div>
                {r.spend.invoices.length > 0 ? (
                  <ul className="mt-4 divide-y divide-border text-sm">
                    {r.spend.invoices.map((i) => (
                      <li key={i.id} className="flex justify-between gap-3 py-2.5">
                        <span>
                          {i.number} <span className="text-xs text-ink-muted">· {fmtDay.format(new Date(i.createdAt))}</span>
                        </span>
                        <span className="tabular-nums">{formatINR(i.totalPaise)}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <Empty>No invoices this month.</Empty>
                )}
              </Panel>
            ) : (
              <Panel title="Spend this month">
                <Empty>Billing is visible to the account owner and finance users.</Empty>
              </Panel>
            )}
          </Grid>

          <Panel title="Services and milestones" subtitle="Where each service stands today" flush>
            {r.services.length ? (
              <ul className="divide-y divide-border">
                {r.services.map((s) => (
                  <li key={s.id} className="grid gap-4 px-5 py-4 md:grid-cols-[1fr_2fr_0.8fr] md:items-center">
                    <div>
                      <p className="font-medium">{s.serviceName}</p>
                      <p className="text-xs text-ink-muted capitalize">{s.tier}</p>
                    </div>
                    <GateTrack track={s.track} clientView />
                    <div>
                      <p className="mb-1 text-xs text-ink-muted">
                        {s.approved} of {s.total} approved
                      </p>
                      <Meter value={s.total ? (s.approved / s.total) * 100 : 0} tone={s.total && s.approved === s.total ? "good" : "default"} />
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>Your services show here once your agreement is active.</Empty>
            )}
          </Panel>
        </div>
      )}
    </div>
  );
}
