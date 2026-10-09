"use client";

import type { DashboardView } from "@bmu/shared";
import { Empty } from "@/components/dash";
import { PageTitle } from "@/components/ui";
import { CustomiseLink } from "./customise-link";
import { DashGrid } from "./grid";

/** v12: a dashboard built in the Studio, shown to the people it was made for. */
export function CustomDashboard({ view }: { view: DashboardView }) {
  return (
    <div data-dashboard={view.key}>
      <PageTitle title={view.name} subtitle={view.description ?? undefined} action={view.canEdit ? <CustomiseLink id={view.id} /> : undefined} />
      {view.layout.length ? <DashGrid items={view.layout} /> : <Empty>This dashboard has no widgets yet.{view.canEdit ? " Open it in the Studio to add some." : ""}</Empty>}
    </div>
  );
}
