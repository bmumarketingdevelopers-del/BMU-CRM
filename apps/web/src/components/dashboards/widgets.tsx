"use client";

/** v12 Dashboard Studio: the library widgets (numbers, charts, saved reports, lists, notes, links) and borrowed sections. */
import dynamic from "next/dynamic";
import Link from "next/link";
import type { ComponentType } from "react";
import {
  DASHBOARD_BUILTINS,
  dashboardListInfo,
  dashboardPeriodLabels,
  dashboardPeriodRange,
  opsDimensionLabels,
  opsMetricInfo,
  type DashboardBuiltinKey,
  type DashboardWidget,
  type DashboardWidgetOf,
  type OpsExploreResult,
} from "@bmu/shared";
import { LineChart } from "@/components/charts";
import { BarList, ColumnChart, DataTable, Empty, Panel, StatTile } from "@/components/dash";
import { Badge } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { deltaOf, fmtDay, inr, inrShort, num, pctText } from "@/app/(admin)/admin/analytics/team/ops-kit";
import type { DashLayoutProps } from "./grid";

const valueText = (unit: OpsExploreResult["unit"], n: number | null, short = false) =>
  n === null ? "—" : unit === "paise" ? (short ? inrShort(n) : inr(n)) : unit === "pct" ? pctText(n) : unit === "hours" ? `${num(n)}h` : num(n);

/** "Not for you" errors read calmly; anything else shows the server's message. */
function WidgetError({ error, title }: { error: string; title?: string }) {
  const denied = /only|not shared|for the|for BMU|is shown to/i.test(error);
  return (
    <div className="border border-border bg-surface-raised px-5 py-4 text-sm" data-widget-error>
      {title && <p className="font-medium">{title}</p>}
      <p className={denied ? "mt-1 text-ink-muted" : "mt-1 text-[#b4432c]"}>{denied ? `Not available to you: ${error}` : error}</p>
    </div>
  );
}

function Loading({ title }: { title?: string }) {
  return (
    <div className="border border-border bg-surface-raised px-5 py-4 text-sm text-ink-muted">
      {title && <p className="font-medium text-ink">{title}</p>}
      <p className="mt-1">Loading…</p>
    </div>
  );
}

export function WidgetView({ w }: { w: DashboardWidget }) {
  // Remount when the settings change so the data reloads.
  const k = JSON.stringify(w);
  switch (w.type) {
    case "section":
      return <BorrowedSection key={k} w={w} />;
    case "kpi":
      return <KpiWidget key={k} w={w} />;
    case "chart":
      return <ChartWidget key={k} w={w} />;
    case "report":
      return <ReportWidget key={k} w={w} />;
    case "list":
      return <ListWidget key={k} w={w} />;
    case "custom_field":
      return <CustomFieldWidget key={k} w={w} />;
    case "note":
      return <NoteWidget w={w} />;
    case "links":
      return <LinksWidget w={w} />;
  }
}

// ---------------------------------------------------------------------------
// Numbers and charts

const ownNote = (own: boolean) => (own ? "your own" : undefined);

function KpiWidget({ w }: { w: DashboardWidgetOf<"kpi"> }) {
  const info = opsMetricInfo[w.metric];
  const state = useLoad(() => api.dashboards.explore({ metric: w.metric, dimension: "month", chart: "table", ...dashboardPeriodRange(w.period) }));
  const title = w.title || info.label;
  if (state.error) return <WidgetError error={state.error} title={title} />;
  if (!state.data) return <Loading title={title} />;
  const r = state.data;
  const lower = w.metric === "sla_breaches";
  return (
    <div className="border border-border" title={info.hint}>
      <StatTile
        label={title}
        value={valueText(r.unit, r.total)}
        delta={r.total === null ? undefined : deltaOf({ value: r.total, prev: r.prevTotal }, { lowerIsBetter: lower })}
        hint={[dashboardPeriodLabels[w.period].toLowerCase(), ownNote(r.ownOnly)].filter(Boolean).join(" · ")}
      />
    </div>
  );
}

function ResultChart({ r, chart }: { r: OpsExploreResult; chart: string }) {
  const time = r.config.dimension === "month" || r.config.dimension === "week";
  if (!r.rows.length || r.rows.every((x) => !x.value)) return <p className="py-6 text-center text-sm text-ink-muted">Nothing to show for this period yet.</p>;
  if (chart === "line") return <LineChart labels={r.rows.map((x) => x.label)} series={[{ key: "v", label: r.metricLabel, values: r.rows.map((x) => x.value), area: true }]} format={(n) => valueText(r.unit, n, true)} />;
  if (chart === "columns") return <ColumnChart data={r.rows.slice(0, 24).map((x) => ({ label: x.label, value: x.value }))} format={(n) => valueText(r.unit, n, true)} highlightLast={time} />;
  if (chart === "bars")
    return <BarList items={r.rows.slice(0, 10).map((x, i) => ({ label: x.label, value: x.value, href: x.href, highlight: !time && i === 0 }))} format={(n) => valueText(r.unit, n)} max={r.unit === "pct" ? 100 : undefined} />;
  return (
    <div className="-mx-5 -mb-5">
      <DataTable
        rows={r.rows.slice(0, 15)}
        rowKey={(x) => x.key}
        columns={[
          { key: "l", header: r.dimensionLabel, cell: (x) => (x.href ? <Link href={x.href} className="hover:underline">{x.label}</Link> : x.label) },
          { key: "v", header: r.metricLabel, align: "right", cell: (x) => valueText(r.unit, x.value) },
        ]}
      />
    </div>
  );
}

function ChartWidget({ w }: { w: DashboardWidgetOf<"chart"> }) {
  const info = opsMetricInfo[w.metric];
  const state = useLoad(() => api.dashboards.explore({ metric: w.metric, dimension: w.dimension, chart: w.chart, ...dashboardPeriodRange(w.period) }));
  const title = w.title || `${info.label} by ${opsDimensionLabels[w.dimension].toLowerCase()}`;
  if (state.error) return <WidgetError error={state.error} title={title} />;
  if (!state.data) return <Loading title={title} />;
  const r = state.data;
  return (
    <Panel className="min-w-0 h-full" title={title} subtitle={`${dashboardPeriodLabels[w.period]}${r.ownOnly ? " · your own numbers" : ""} · total ${valueText(r.unit, r.total)}`}>
      <ResultChart r={r} chart={w.chart} />
    </Panel>
  );
}

function ReportWidget({ w }: { w: DashboardWidgetOf<"report"> }) {
  const state = useLoad(() => api.dashboards.report(w.reportId));
  if (state.error) return <WidgetError error={state.error} title={w.title || "Saved report"} />;
  if (!state.data) return <Loading title={w.title || "Saved report"} />;
  const r = state.data;
  return (
    <Panel
      className="min-w-0 h-full"
      title={w.title || r.name}
      subtitle={`${fmtDay(r.range.from)} – ${fmtDay(r.range.to)}${r.ownOnly ? " · your own numbers" : ""} · total ${valueText(r.unit, r.total)}`}
      action={
        <Link href="/admin/analytics/explore" className="text-xs text-ink-muted hover:text-ink">
          Report Builder →
        </Link>
      }
    >
      <ResultChart r={r} chart={r.config.chart} />
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Lists, notes and links

const badgeTone = { red: "red", amber: "amber", green: "green", grey: "neutral" } as const;

function ListWidget({ w }: { w: DashboardWidgetOf<"list"> }) {
  const info = dashboardListInfo[w.source];
  const state = useLoad(() => api.dashboards.list(w.source, w.limit));
  const title = w.title || info.label;
  if (state.error) return <WidgetError error={state.error} title={title} />;
  if (!state.data) return <Loading title={title} />;
  const d = state.data;
  return (
    <Panel
      className="min-w-0 h-full"
      title={title}
      subtitle={d.total > d.rows.length ? `${d.rows.length} of ${d.total}` : d.total ? `${d.total}` : undefined}
      flush
      action={
        <Link href={d.href} className="text-xs text-ink-muted hover:text-ink">
          See all →
        </Link>
      }
    >
      {d.rows.length ? (
        <ul className="divide-y divide-border">
          {d.rows.map((r) => (
            <li key={r.id}>
              <Link href={r.href} className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-canvas/40">
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{r.title}</span>
                  {r.meta && <span className="block truncate text-xs text-ink-muted">{r.meta}</span>}
                </span>
                {r.badge && (
                  <span className="shrink-0">
                    <Badge tone={badgeTone[r.badge.tone]}>{r.badge.label}</Badge>
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <Empty>Nothing here right now.</Empty>
      )}
    </Panel>
  );
}

function CustomFieldWidget({ w }: { w: DashboardWidgetOf<"custom_field"> }) {
  const state = useLoad(() => api.dashboards.fieldBreakdown(w.entity, w.field, w.scope));
  if (state.error) return <WidgetError error={state.error} title={w.title} />;
  if (!state.data) return <Loading title={w.title} />;
  const d = state.data;
  const filled = d.total - d.empty;
  return (
    <Panel className="min-w-0 h-full" title={w.title || d.label} subtitle={`${w.scope === "open" ? "Open records" : "All records"} · ${filled} of ${d.total} filled in`}>
      {d.rows.length ? <BarList items={d.rows.map((r) => ({ label: r.label, value: r.count, href: r.href ?? undefined }))} /> : <Empty>Nobody has filled this field in yet.</Empty>}
    </Panel>
  );
}

function NoteWidget({ w }: { w: DashboardWidgetOf<"note"> }) {
  return (
    <Panel className="min-w-0 h-full" title={w.title || undefined}>
      <div className="space-y-2 text-sm leading-relaxed whitespace-pre-line">{w.text}</div>
    </Panel>
  );
}

function LinksWidget({ w }: { w: DashboardWidgetOf<"links"> }) {
  return (
    <Panel className="min-w-0 h-full" title={w.title || "Quick links"} flush>
      <ul className="divide-y divide-border">
        {w.links.map((l, i) => (
          <li key={`${l.href}-${i}`}>
            {l.href.startsWith("/") ? (
              <Link href={l.href} className="flex items-center justify-between px-5 py-3 text-sm hover:bg-canvas/40">
                {l.label} <span className="text-ink-muted">→</span>
              </Link>
            ) : (
              <a href={l.href} target="_blank" rel="noopener noreferrer" className="flex items-center justify-between px-5 py-3 text-sm hover:bg-canvas/40">
                {l.label} <span className="text-ink-muted">↗</span>
              </a>
            )}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// A section borrowed from another built-in dashboard: that dashboard drawn with just this one section.

const hosts: Partial<Record<DashboardBuiltinKey, ComponentType<DashLayoutProps>>> = {
  command_centre: dynamic(() => import("@/app/(admin)/admin/weekly-review").then((m) => m.WeeklyReviewBody), { loading: () => <Loading /> }),
  scorecard: dynamic(() => import("@/app/(admin)/admin/analytics/scorecard-body").then((m) => m.ScorecardEmbed), { loading: () => <Loading /> }),
  my_day: dynamic(() => import("@/components/my-day-panel").then((m) => m.MyDayPanel), { loading: () => <Loading /> }),
  manager: dynamic(() => import("@/components/craft/manager-dashboard").then((m) => m.ManagerDashboard), { loading: () => <Loading /> }),
  specialist: dynamic(() => import("@/components/craft/craft-dashboard").then((m) => m.CraftDashboard), { loading: () => <Loading /> }),
};

function BorrowedSection({ w }: { w: DashboardWidgetOf<"section"> }) {
  const Host = hosts[w.dashboard];
  const def = DASHBOARD_BUILTINS[w.dashboard];
  if (!Host) return <WidgetError error={`${def.name} sections can only be shown on ${def.name}`} />;
  return <Host layout={[{ ...w, size: "full" }]} />;
}
