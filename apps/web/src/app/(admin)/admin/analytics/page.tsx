"use client";

import { CustomiseLink } from "@/components/dashboards/customise-link";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { PeriodPage } from "./_sales/kit";
import { ScorecardBody } from "./scorecard-body";

export default function ScorecardPage() {
  // v12: the layout comes from the Dashboard Studio (the original one until someone changes it).
  const dash = useLoad(() => api.dashboards.builtin("scorecard"));
  if (dash.loading) return null;
  return (
    <PeriodPage
      title="Scorecard"
      subtitle="The few numbers that show how the business is doing, against your targets. Amounts are before GST."
      extra={dash.data?.canEdit ? <CustomiseLink id={dash.data.id} /> : undefined}
    >
      {(p) => <ScorecardBody period={p} layout={dash.data?.layout} />}
    </PeriodPage>
  );
}
