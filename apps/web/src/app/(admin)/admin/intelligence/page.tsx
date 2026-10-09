"use client";

import { ForecastRisks } from "@/components/intelligence/forecast-risks";
import { PageTitle } from "@/components/ui";

export default function IntelligencePage() {
  return (
    <>
      <PageTitle title="Forecast & Risks" subtitle="Where revenue is heading, which clients may leave, which deals will close, what work may slip and where the team is short. Each comes with the reasons behind it." />
      <ForecastRisks />
    </>
  );
}
