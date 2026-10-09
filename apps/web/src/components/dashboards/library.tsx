"use client";

/** v12: the widget library — everything that can go on a dashboard, grouped, with one "Add" per item. */
import { useState } from "react";
import {
  DASHBOARD_BUILTINS,
  DASHBOARD_BUILTIN_KEYS,
  DASHBOARD_LIST_SOURCES,
  OPS_METRICS,
  customFieldEntityLabels,
  customFieldTypeLabels,
  dashboardListInfo,
  opsDimensionLabels,
  opsMetricInfo,
  type DashboardBuiltinKey,
  type DashboardSurface,
  type CustomFieldDefView,
  type DashboardWidget,
  type OpsReportsList,
} from "@bmu/shared";
import { ActionDrawer } from "@/components/actions/action-drawer";
import { Tabs } from "@/components/dash";
import { Badge, Button, LoadState } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { newWidgetId } from "./studio-kit";

/** A widget before it has an id (Omit spread over each widget type). */
type NewWidget = DashboardWidget extends infer T ? (T extends DashboardWidget ? Omit<T, "id"> : never) : never;
type Group = "sections" | "numbers" | "charts" | "lists" | "reports" | "fields" | "text";

function Item({ title, hint, badge, onAdd, added }: { title: string; hint?: string; badge?: string; onAdd: () => void; added?: boolean }) {
  return (
    <li className="flex items-center justify-between gap-3 px-4 py-3">
      <span className="min-w-0">
        <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
          {title}
          {badge && <Badge tone="amber">{badge}</Badge>}
        </span>
        {hint && <span className="block text-xs text-ink-muted">{hint}</span>}
      </span>
      <Button variant="secondary" className="shrink-0 px-3 py-1 text-xs" onClick={onAdd} aria-label={`Add ${title}`}>
        {added ? "Add again" : "Add"}
      </Button>
    </li>
  );
}

export function WidgetLibrary({
  open,
  onClose,
  onAdd,
  host,
  surface,
  layout,
}: {
  open: boolean;
  onClose: () => void;
  onAdd: (w: DashboardWidget) => void;
  host: DashboardBuiltinKey | null;
  surface: DashboardSurface;
  layout: DashboardWidget[];
}) {
  const clientOnly = surface === "client";
  const [group, setGroup] = useState<Group>(host || clientOnly ? "sections" : "numbers");
  const reports = useLoad<OpsReportsList | null>(() => (clientOnly ? Promise.resolve(null) : api.opsAnalytics.reports()));
  const fields = useLoad<CustomFieldDefView[]>(() => (clientOnly ? Promise.resolve([]) : api.customFields.list().catch(() => [])), { live: false });
  const onPage = (k: DashboardBuiltinKey, s: string) => layout.some((w) => w.type === "section" && w.dashboard === k && w.section === s);
  const add = (w: NewWidget) => onAdd({ ...w, id: newWidgetId() } as DashboardWidget);

  const groups: { value: Group; label: string }[] = clientOnly
    ? [
        { value: "sections", label: "Sections" },
        { value: "text", label: "Notes & links" },
      ]
    : [
        { value: "numbers", label: "Numbers" },
        { value: "charts", label: "Charts" },
        { value: "lists", label: "Lists" },
        { value: "reports", label: "Saved reports" },
        { value: "fields", label: "Custom fields" },
        { value: "sections", label: "Sections" },
        { value: "text", label: "Notes & links" },
      ];
  const sectionDashboards = clientOnly ? (["client_home"] as const) : DASHBOARD_BUILTIN_KEYS.filter((k) => k !== "client_home").sort((a, b) => (a === host ? -1 : b === host ? 1 : 0));
  const money = "Money";

  return (
    <ActionDrawer open={open} title="Add a widget" subtitle="It goes at the bottom. Drag it or use the arrows to move it, and the cog to change it." onClose={onClose} wide testId="widget-library">
      <Tabs value={group} onChange={setGroup} options={groups} />
      {group === "numbers" && (
        <ul className="divide-y divide-border border border-border">
          {OPS_METRICS.map((m) => (
            <Item key={m} title={opsMetricInfo[m].label} hint={opsMetricInfo[m].hint} badge={opsMetricInfo[m].money ? money : undefined} onAdd={() => add({ type: "kpi", size: "third", metric: m, period: "last_30" })} />
          ))}
        </ul>
      )}
      {group === "charts" && (
        <ul className="divide-y divide-border border border-border">
          {OPS_METRICS.flatMap((m) =>
            opsMetricInfo[m].dimensions
              .filter((d) => d !== "week")
              .map((d) => (
                <Item
                  key={`${m}-${d}`}
                  title={`${opsMetricInfo[m].label} by ${opsDimensionLabels[d].toLowerCase()}`}
                  hint={d === "month" ? "Trend over time" : `Compare by ${opsDimensionLabels[d].toLowerCase()}`}
                  badge={opsMetricInfo[m].money ? money : undefined}
                  onAdd={() => add({ type: "chart", size: "half", metric: m, dimension: d, chart: d === "month" ? "columns" : "bars", period: d === "month" ? "this_fy" : "last_90" })}
                />
              )),
          )}
        </ul>
      )}
      {group === "lists" && (
        <ul className="divide-y divide-border border border-border">
          {DASHBOARD_LIST_SOURCES.map((s) => (
            <Item key={s} title={dashboardListInfo[s].label} hint={dashboardListInfo[s].hint} badge={dashboardListInfo[s].money ? money : undefined} onAdd={() => add({ type: "list", size: "half", source: s, limit: 6 })} />
          ))}
        </ul>
      )}
      {group === "reports" &&
        (!reports.data ? (
          <LoadState loading={reports.loading} error={reports.error} />
        ) : [...reports.data.mine, ...reports.data.shared].length ? (
          <ul className="divide-y divide-border border border-border">
            {[...reports.data.mine, ...reports.data.shared].map((r) => (
              <Item key={r.id} title={r.name} hint={`${opsMetricInfo[r.config.metric].label} by ${opsDimensionLabels[r.config.dimension].toLowerCase()} · by ${r.owner}${r.mine && !r.shared ? " · will be shared when you save" : ""}`} onAdd={() => add({ type: "report", size: "half", reportId: r.id })} />
            ))}
          </ul>
        ) : (
          <p className="border border-border px-4 py-6 text-center text-sm text-ink-muted">No saved reports yet. Save one in Analytics → Report Builder and it shows here.</p>
        ))}
      {group === "fields" &&
        ((fields.data ?? []).filter((f) => f.type !== "long_text" && f.type !== "date").length ? (
          <ul className="divide-y divide-border border border-border">
            {(fields.data ?? [])
              .filter((f) => f.type !== "long_text" && f.type !== "date")
              .map((f) => (
                <Item key={f.id} title={`${customFieldEntityLabels[f.entity].many} by ${f.label.toLowerCase()}`} hint={`${customFieldTypeLabels[f.type]} · how many records have each answer`} onAdd={() => add({ type: "custom_field", size: "half", entity: f.entity, field: f.key, scope: "open" })} />
              ))}
          </ul>
        ) : (
          <p className="border border-border px-4 py-6 text-center text-sm text-ink-muted">{fields.loading ? "Loading…" : "No custom fields yet. Add some in Customise → Custom Fields and they show here."}</p>
        ))}
      {group === "sections" && (
        <div className="space-y-4">
          {sectionDashboards.map((k) => (
            <div key={k}>
              <p className="mb-1.5 text-[11px] tracking-[0.1em] text-ink-muted uppercase">{k === host ? `This dashboard (${DASHBOARD_BUILTINS[k].name})` : DASHBOARD_BUILTINS[k].name}</p>
              <ul className="divide-y divide-border border border-border">
                {DASHBOARD_BUILTINS[k].sections.map((s) => {
                  const there = onPage(k, s.key);
                  return there ? (
                    <li key={s.key} className="flex items-center justify-between gap-3 px-4 py-3 text-sm text-ink-muted">
                      {s.label} <span className="text-xs">On the dashboard</span>
                    </li>
                  ) : (
                    <Item key={s.key} title={s.label} hint={s.hint} onAdd={() => add({ type: "section", size: s.size, dashboard: k, section: s.key })} />
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
      {group === "text" && (
        <ul className="divide-y divide-border border border-border">
          <Item title="Note" hint="A heading and a few lines of text: a goal, a reminder, how to use this page" onAdd={() => add({ type: "note", size: "half", title: "Note", text: "Write something for the people who use this dashboard." })} />
          <Item title="Quick links" hint="Buttons to pages in the app or any https:// address" onAdd={() => add({ type: "links", size: "third", title: "Quick links", links: clientOnly ? [{ label: "Messages", href: "/client/messages" }] : [{ label: "Tasks", href: "/team/tasks" }] })} />
        </ul>
      )}
    </ActionDrawer>
  );
}
