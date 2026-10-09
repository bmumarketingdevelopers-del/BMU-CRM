"use client";

/**
 * v12 Dashboard Studio: lays out a dashboard's widgets on a 6-column grid (one column on a phone).
 * Built-in dashboards pass their own sections as `sections`; anything else (library widgets, sections borrowed from
 * another dashboard) is drawn by WidgetView. The Studio editor passes `wrap` to add its toolbar around each widget.
 */
import type { ReactNode } from "react";
import { DASHBOARD_BUILTINS, type DashboardBuiltinKey, type DashboardSize, type DashboardWidget } from "@bmu/shared";
import { WidgetView } from "./widgets";

export type DashWrap = (w: DashboardWidget, node: ReactNode, index: number) => ReactNode;
export type DashLayoutProps = { layout?: DashboardWidget[]; wrap?: DashWrap };

export const sizeClass: Record<DashboardSize, string> = {
  full: "lg:col-span-6",
  wide: "lg:col-span-4",
  half: "lg:col-span-3",
  third: "lg:col-span-2",
};

export function DashGrid({ host, items, sections = {}, wrap }: { host?: DashboardBuiltinKey; items: DashboardWidget[]; sections?: Record<string, ReactNode>; wrap?: DashWrap }) {
  const cells = items.map((w, i) => {
    let node: ReactNode;
    if (w.type === "section" && w.dashboard === host) {
      node = sections[w.section];
      if ((node === null || node === undefined || node === false) && wrap) node = <EmptySection w={w} />;
    } else {
      node = <WidgetView w={w} />;
    }
    if (node === null || node === undefined || node === false) return null;
    return (
      <div key={w.id} className={`min-w-0 ${sizeClass[w.size]}`} data-widget={w.type} data-widget-id={w.id}>
        {wrap ? wrap(w, node, i) : node}
      </div>
    );
  });
  return <div className="grid grid-cols-1 gap-6 lg:grid-cols-6 [&>*]:min-w-0">{cells}</div>;
}

function EmptySection({ w }: { w: Extract<DashboardWidget, { type: "section" }> }) {
  const def = DASHBOARD_BUILTINS[w.dashboard].sections.find((s) => s.key === w.section);
  return (
    <div className="border border-dashed border-border bg-canvas/40 px-5 py-6 text-sm text-ink-muted">
      <p className="font-medium text-ink">{def?.label ?? w.section}</p>
      <p className="mt-1">{def?.hint ? `${def.hint}.` : "Nothing to show here for you right now."} It appears for people when it has something to show.</p>
    </div>
  );
}
