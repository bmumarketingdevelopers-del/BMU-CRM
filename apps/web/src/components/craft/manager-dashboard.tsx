"use client";
// v10 craft: the Manager workspace for client managers, project managers, CM leads and department heads.
// My Day strip, KPIs, Today, the assignment board, the client portfolio and the team's next two weeks.
import { useEffect, useState, type ReactNode } from "react";
import { dashboardDefaultLayout, type CraftManagerView } from "@bmu/shared";
import { DeliveryDeadlinesPanel } from "@/components/deliver/deadlines-panel";
import { DashGrid, type DashLayoutProps } from "@/components/dashboards/grid";
import { Insight } from "@/components/charts";
import { Panel, StatRow, StatTile } from "@/components/dash";
import { LoadState } from "@/components/ui";
import { api } from "@/lib/api";
import { fmtKpi, kpiDelta } from "./craft-bits";
import { Strip } from "./craft-dashboard";
import { AssignmentBoard } from "./manager-board";
import { ClientPortfolio, TeamView, TodayList } from "./manager-clients";

export function ManagerDashboard({ layout, wrap }: DashLayoutProps = {}) {
  const [v, setV] = useState<CraftManagerView>();
  const [error, setError] = useState<string>();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    api.craftManager
      .view()
      .then((d) => live && (setV(d), setError(undefined)))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [tick]);
  if (!v) return <LoadState loading={!error} error={error} />;
  const reload = () => setTick((t) => t + 1);
  const sections: Record<string, ReactNode> = {
    strip: <Strip strip={v.strip} readOnly={false} onChanged={reload} />,
    kpis: (
      <StatRow cols={5}>
        {v.kpis.map((k) => (
          <StatTile key={k.key} label={k.label} value={fmtKpi(k)} delta={kpiDelta(k)} hint={k.hint} href={k.href} />
        ))}
      </StatRow>
    ),
    today: <TodayList v={v} onChanged={reload} />,
    insights: (
      <Panel className="h-full" title="What the numbers say" subtitle={`Across ${v.scopeLabel.toLowerCase()}.`}>
        <div className="-mt-4">
          {v.insights.map((t) => (
            <Insight key={t} tone={/over capacity|no owner|waited|red/i.test(t) ? "warn" : /balanced/i.test(t) ? "good" : "default"}>
              {t}
            </Insight>
          ))}
        </div>
      </Panel>
    ),
    board: <AssignmentBoard v={v} onChanged={reload} />,
    portfolio: <ClientPortfolio v={v} onChanged={reload} />,
    team: <TeamView v={v} />,
    deadlines: <DeliveryDeadlinesPanel className="" />,
  };
  return (
    <div data-manager={v.scope}>
      <DashGrid host="manager" items={layout ?? dashboardDefaultLayout("manager")} sections={sections} wrap={wrap} />
    </div>
  );
}
