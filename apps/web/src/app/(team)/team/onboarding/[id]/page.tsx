"use client";

import { use } from "react";
import Link from "next/link";
import { PeopleChecklist } from "@/components/people-checklist";
import { LoadState, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

/** A buddy's (or the new hire's) view of one onboarding checklist. */
export default function OnboardingViewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const p = useLoad(() => api.teamFlows.people.get(id));
  return (
    <>
      <Link href="/team" className="text-sm text-ink-muted hover:text-ink">
        ← My Day
      </Link>
      <PageTitle title={p.data ? `Onboarding: ${p.data.user.name}` : "Onboarding"} subtitle="Follow the new hire's progress. HR ticks the items; the new hire confirms the SOPs." />
      <LoadState loading={p.loading} error={p.error} />
      {p.data && <PeopleChecklist process={p.data} />}
    </>
  );
}
