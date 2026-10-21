"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { dashboardDefaultLayout } from "@bmu/shared";
import { BarList, ColumnChart, Empty, Panel, StackBar, StatRow, StatTile } from "@/components/dash";
import { CustomiseLink } from "@/components/dashboards/customise-link";
import { DashGrid, type DashLayoutProps } from "@/components/dashboards/grid";
import { Badge, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { AiWeeklyDigest } from "@/components/ai/digest-panel";
import { ForecastRisks } from "@/components/intelligence/forecast-risks";
import { AttendanceTodayByDepartment } from "@/components/attendance/today-by-department";
import { NewClientsPanel } from "@/components/clients/new-clients-panel";
import { ContentWeekPanel } from "@/components/deliver/content-week-panel";
import { ClientFilesPanel } from "@/components/ops/client-files-panel";
import { Legend, WithData, fmtDateTime, inr, inrShort, pctText } from "./_insights/kit";

const stageTone = ["grey", "muted", "amber", "dark", "green", "red"] as const;

export default function WeeklyReview({ layout, canEdit, dashboardId }: DashLayoutProps & { canEdit?: boolean; dashboardId?: string }) {
  return (
    <>
      <PageTitle title="Weekly Review" subtitle="The week at a glance: money, pipeline, delivery and what needs you now." action={canEdit && dashboardId ? <CustomiseLink id={dashboardId} /> : undefined} />
      <WeeklyReviewBody layout={layout} />
    </>
  );
}

/** v12: the Weekly Review as sections, laid out by the Dashboard Studio (default: the original order). */
export function WeeklyReviewBody({ layout, wrap }: DashLayoutProps) {
  const state = useLoad(() => api.insights.weekly());
  return (
    <WithData state={state}>
      {(d) => {
        const m = d.money;
        const change = m && m.revenueLastMonthPaise ? ((m.revenueThisMonthPaise - m.revenueLastMonthPaise) / m.revenueLastMonthPaise) * 100 : null;
        const sections: Record<string, ReactNode> = {
          ai_digest: <AiWeeklyDigest />,
          // v20: revenue forecast, churn risk, likely wins, slipping work and capacity, with reasons.
          forecast_risks: (
            <div className="min-w-0">
              <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-muted">
                Forecast &amp; risks · <Link href="/admin/intelligence" className="normal-case tracking-normal underline">open</Link>
              </h2>
              <ForecastRisks compact />
            </div>
          ),
          money_tiles: m ? (
            <StatRow cols={4}>
              <StatTile
                label="Revenue this month"
                value={inr(m.revenueThisMonthPaise)}
                hint={<span>before GST · last month {inrShort(m.revenueLastMonthPaise)}</span>}
                delta={change === null ? undefined : { value: `${Math.abs(Math.round(change))}%`, up: change >= 0 }}
                href="/admin/revenue"
              />
              <StatTile label="Collected this month" value={inr(m.collectedThisMonthPaise)} hint="payments received" href="/admin/finance/payments" />
              <StatTile label="Outstanding" value={inr(m.outstandingPaise)} tone={d.attention.overdueInvoices?.length ? "warn" : "default"} hint={`${d.attention.overdueInvoices?.length ?? 0} overdue`} href="/admin/collections" />
              <StatTile label="Active clients" value={d.activeClients} hint="with live work" href="/admin/client-health" />
            </StatRow>
          ) : null,
          ops_tiles: (
            <StatRow cols={m ? 4 : 5}>
              {!m && <StatTile label="Active clients" value={d.activeClients} hint="with live work" href="/admin/client-health" />}
              <StatTile label="Open leads" value={d.openLeads} hint="not yet won or lost" href="/admin/pipeline" />
              <StatTile label="Overdue tasks" value={d.overdueTasks} tone={d.overdueTasks ? "warn" : "default"} hint="past their deadline" href="/admin/capacity" />
              <StatTile label="Reply times missed" value={d.slaBreachesThisWeek} tone={d.slaBreachesThisWeek ? "bad" : "default"} hint="client requests, this week" />
              <StatTile label="QC pass rate" value={pctText(d.qcPassRate)} hint={`${d.qcChecksThisWeek} checks this week`} tone={d.qcPassRate !== null && d.qcPassRate < 70 ? "warn" : "default"} href="/admin/quality" />
            </StatRow>
          ),
          // v30: who is in today, by department (hidden for people without attendance access).
          attendance_today: <AttendanceTodayByDepartment />,
          // v33: clients added in the last 30 days, and who added them (including Client Managers).
          new_clients: <NewClientsPanel />,
          // v34: social content at a glance.
          content_week: <ContentWeekPanel />,
          // v35: every file sent to and received from clients (Founder).
          client_files: <ClientFilesPanel />,
          money_chart: m ? (
            <Panel className="min-w-0 h-full" title="Invoiced and collected" subtitle="Last six months, including GST" action={<Legend items={[{ label: "Invoiced", className: "bg-grey/60" }, { label: "Collected", className: "bg-charcoal" }]} />}>
              <ColumnChart data={m.byMonth.map((p) => ({ label: p.label, value: p.collectedPaise, secondary: p.invoicedPaise }))} format={inrShort} highlightLast={false} />
            </Panel>
          ) : null,
          pipeline: (
            <Panel
              className="min-w-0 h-full"
              title="Pipeline"
              subtitle="Leads by stage"
              action={
                <Link href="/admin/pipeline" className="text-xs text-ink-muted hover:text-ink">
                  Open pipeline →
                </Link>
              }
            >
              {d.pipeline.some((p) => p.count) ? (
                <>
                  <StackBar parts={d.pipeline.map((p, i) => ({ label: p.label, value: p.count, tone: stageTone[i] ?? "dark" }))} />
                  <div className="mt-6 border-t border-border pt-5">
                    <BarList items={d.pipeline.filter((p) => p.stage !== "lost").map((p) => ({ label: p.label, value: p.count, highlight: p.stage === "won", href: "/admin/pipeline" }))} format={(n) => `${n} lead${n === 1 ? "" : "s"}`} />
                  </div>
                </>
              ) : (
                <Empty>No leads yet.</Empty>
              )}
            </Panel>
          ),
          overdue_invoices: d.attention.overdueInvoices ? (
            <Attention title="Overdue invoices" href="/admin/collections" empty="No overdue invoices.">
              {d.attention.overdueInvoices.map((i) => (
                <Row key={i.id} href={`/admin/finance/invoices/${i.id}`} title={i.client} meta={`${i.number} · ${i.daysOverdue} days late`} right={<span className="tabular-nums">{inr(i.balancePaise)}</span>} />
              ))}
            </Attention>
          ) : null,
          at_risk_clients: (
            <Attention title="Clients at risk" href="/admin/client-health" empty="Every client looks healthy.">
              {d.attention.atRiskClients.map((c) => (
                <Row key={c.id} href={`/team/clients/${c.id}`} title={c.name} meta={c.reasons.slice(0, 2).join(" · ")} right={<Badge tone={c.score < 50 ? "red" : "amber"}>{c.score}/100</Badge>} />
              ))}
            </Attention>
          ),
          blocked_tasks: (
            <Attention title="Blocked tasks" href="/team/tasks" empty="Nothing is blocked.">
              {d.attention.blockedTasks.map((t) => (
                <Row key={t.id} href={t.deliverableId ? `/team/deliverables/${t.deliverableId}` : "/team/tasks"} title={t.title} meta={[t.owner, t.reason].filter(Boolean).join(" · ") || "No reason given"} />
              ))}
            </Attention>
          ),
          late_requests: (
            <Attention title="Requests past reply time" href="/team/requests" empty="Every request was answered in time.">
              {d.attention.slaRequests.map((r) => (
                <Row key={r.id} href={`/team/requests/${r.id}`} title={r.description} meta={`${r.client} · reply was due ${fmtDateTime(r.slaDue)}`} right={<Badge tone="red">{r.type}</Badge>} />
              ))}
            </Attention>
          ),
        };
        return <DashGrid host="command_centre" items={layout ?? dashboardDefaultLayout("command_centre")} sections={sections} wrap={wrap} />;
      }}
    </WithData>
  );
}

function Attention({ title, href, empty, children }: { title: string; href: string; empty: string; children: ReactNode[] }) {
  return (
    <Panel
      className="min-w-0 h-full"
      title={title}
      flush
      action={
        <Link href={href} className="text-xs text-ink-muted hover:text-ink">
          See all →
        </Link>
      }
    >
      {children.length ? <ul className="divide-y divide-border">{children}</ul> : <Empty>{empty}</Empty>}
    </Panel>
  );
}

function Row({ href, title, meta, right }: { href: string; title: string; meta?: string; right?: ReactNode }) {
  return (
    <li>
      <Link href={href} className="flex items-center justify-between gap-4 px-5 py-3 hover:bg-canvas/40">
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium">{title}</span>
          {meta && <span className="block truncate text-xs text-ink-muted">{meta}</span>}
        </span>
        {right && <span className="shrink-0 text-sm">{right}</span>}
      </Link>
    </li>
  );
}
