"use client";

import Link from "next/link";
import { Fragment, type ReactNode } from "react";
import { dashboardDefaultLayout, type DashboardWidget } from "@bmu/shared";
import { ColumnChart, Empty, Panel, StatRow, StatTile } from "@/components/dash";
import { CustomiseLink } from "@/components/dashboards/customise-link";
import { DashGrid, type DashLayoutProps } from "@/components/dashboards/grid";
import { Badge, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { AiWeeklyDigest } from "@/components/ai/digest-panel";
import { ContentWeekPanel } from "@/components/deliver/content-week-panel";
import { ClientFilesPanel } from "@/components/ops/client-files-panel";
import { Legend, WithData, fmtDateTime, inr, inrShort, pctText } from "./_insights/kit";

// Sections that open a Command Centre page: shown as cards, gathered into one row of cards where the first one sits.
const CARD_SECTIONS = ["forecast_risks", "pipeline", "overdue_invoices", "at_risk_clients", "attendance_today", "new_clients"];
// The weekly summary lists at most 6 overdue invoices and at-risk clients.
const LIST_CAP = 6;
const capped = (n: number) => (n >= LIST_CAP ? `${LIST_CAP}+` : n);

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
        const overdue = d.attention.overdueInvoices;
        const atRisk = d.attention.atRiskClients;
        const sections: Record<string, ReactNode> = {
          ai_digest: <AiWeeklyDigest />,
          // v20: revenue forecast, churn risk, likely wins, slipping work and capacity, with reasons (on its own page).
          forecast_risks: <PlaceCard href="/admin/intelligence" title="Forecast & risks" hint="Revenue forecast, churn risk, likely wins, slipping work and capacity, each with its reasons." />,
          pipeline: (
            <PlaceCard
              href="/admin/pipeline"
              title="Pipeline"
              value={d.openLeads}
              unit={d.openLeads === 1 ? "open lead" : "open leads"}
              hint={
                d.pipeline
                  .filter((p) => p.count)
                  .map((p) => `${p.count} ${p.label.toLowerCase()}`)
                  .join(" · ") || "No leads yet."
              }
            />
          ),
          overdue_invoices: overdue ? (
            <PlaceCard
              href="/admin/collections"
              title="Overdue invoices"
              value={capped(overdue.length)}
              tone={overdue.length ? "warn" : "default"}
              hint={overdue.length ? `Oldest is ${overdue[0].daysOverdue} days late.` : "No overdue invoices."}
            />
          ) : null,
          at_risk_clients: (
            <PlaceCard
              href="/admin/client-health"
              title="Clients at risk"
              value={capped(atRisk.length)}
              tone={atRisk.some((c) => c.score < 50) ? "bad" : atRisk.length ? "warn" : "default"}
              hint={atRisk.length ? atRisk.slice(0, 3).map((c) => c.name).join(", ") : "Every client looks healthy."}
            />
          ),
          // v30: who is in today (hidden for people without attendance access).
          attendance_today: <AttendanceCard />,
          // v33: clients added in the last 30 days (hidden for people who can't see them).
          new_clients: <NewClientsCard />,
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
          // v34: social content at a glance.
          content_week: <ContentWeekPanel />,
          // v35: every file sent to and received from clients (Founder).
          client_files: <ClientFilesPanel />,
          money_chart: m ? (
            <Panel className="min-w-0 h-full" title="Invoiced and collected" subtitle="Last six months, including GST" action={<Legend items={[{ label: "Invoiced", className: "bg-grey/60" }, { label: "Collected", className: "bg-charcoal" }]} />}>
              <ColumnChart data={m.byMonth.map((p) => ({ label: p.label, value: p.collectedPaise, secondary: p.invoicedPaise }))} format={inrShort} highlightLast={false} />
            </Panel>
          ) : null,
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
        const items = layout ?? dashboardDefaultLayout("command_centre");
        // The Studio editor (wrap) keeps each card on its own so it can be moved or hidden.
        if (wrap) return <DashGrid host="command_centre" items={items} sections={sections} wrap={wrap} />;
        const cards = items.filter(isCard);
        sections.cards = cards.length ? (
          <div className="min-w-0">
            <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-muted">Open a section</h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {cards.map((w) => (
                <Fragment key={w.id}>{sections[w.section]}</Fragment>
              ))}
            </div>
          </div>
        ) : null;
        const at = items.findIndex(isCard);
        const grouped = at < 0 ? items : [...items.slice(0, at), { id: "command_centre.cards", type: "section" as const, size: "full" as const, dashboard: "command_centre" as const, section: "cards" }, ...items.slice(at).filter((w) => !isCard(w))];
        return <DashGrid host="command_centre" items={grouped} sections={sections} />;
      }}
    </WithData>
  );
}

const isCard = (w: DashboardWidget): w is Extract<DashboardWidget, { type: "section" }> => w.type === "section" && w.dashboard === "command_centre" && CARD_SECTIONS.includes(w.section);

/** A card that opens a Command Centre page: a title, an optional headline number and one line of context. */
function PlaceCard({ href, title, value, unit, hint, tone = "default" }: { href: string; title: string; value?: ReactNode; unit?: string; hint: ReactNode; tone?: "default" | "warn" | "bad" }) {
  const toneCls = { default: "", warn: "text-[#9a6b00]", bad: "text-[#b4432c]" }[tone];
  return (
    <Link href={href} className="group flex h-full min-w-0 flex-col border border-border bg-surface-raised p-5 transition-colors hover:bg-canvas/50">
      <span className="flex items-center justify-between gap-3">
        <span className="text-[15px] font-semibold tracking-tight">{title}</span>
        <span aria-hidden className="text-ink-muted transition-colors group-hover:text-ink">
          →
        </span>
      </span>
      {value !== undefined && (
        <span className={`mt-3 text-[28px] leading-none font-semibold tracking-tight tabular-nums ${toneCls}`}>
          {value}
          {unit && <span className="ml-2 text-sm font-normal tracking-normal text-ink-muted">{unit}</span>}
        </span>
      )}
      <span className="mt-2 text-xs text-ink-muted">{hint}</span>
    </Link>
  );
}

/** Today's attendance in one line; hidden for people without attendance access (403) or with no departments. */
function AttendanceCard() {
  const s = useLoad(() => api.adminOrg.attendanceToday(), { live: false });
  const d = s.data;
  if (!d || !d.departments.length) return null;
  const t = d.totals;
  const off = d.todayKind.kind !== "working";
  return (
    <PlaceCard
      href="/admin/attendance"
      title={`Attendance today${d.scope.all ? "" : ` · ${d.scope.departments.join(", ")}`}`}
      value={off ? undefined : `${t.in}/${t.total}`}
      unit={off ? undefined : "in"}
      tone={!off && t.notIn ? "warn" : "default"}
      hint={off ? (d.todayKind.kind === "holiday" ? `Holiday${d.todayKind.label ? `: ${d.todayKind.label}` : ""}. No check-in needed.` : "Weekly off. No check-in needed.") : `${t.late} late · ${t.onLeave} on leave · ${t.notIn} not checked in`}
    />
  );
}

/** Clients added in the last 30 days; hidden for people who can't see them (403). */
function NewClientsCard() {
  const s = useLoad(() => api.insights.newClients(), { live: ["ClientOrg"] });
  const d = s.data;
  if (!d) return null;
  return <PlaceCard href="/admin/clients" title="New clients" value={d.total} unit={`in ${d.days} days`} hint={d.byCm ? `${d.byCm} added by Client Managers.` : d.total ? "Open to see who added them." : "No clients added lately."} />;
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
