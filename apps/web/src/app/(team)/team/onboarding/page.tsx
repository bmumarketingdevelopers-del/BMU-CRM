"use client";

import Link from "next/link";
import { PeopleChecklist } from "@/components/people-checklist";
import { Empty, Panel } from "@/components/dash";
import { LoadState, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { OnboardingHistory } from "./onboarding-history";

/** A new hire's own onboarding (progress, SOPs to read, buddy), then the history of every onboarding they are part of. */
export default function MyOnboardingPage() {
  const mine = useLoad(() => api.teamFlows.people.mine());
  const open = mine.data?.find((p) => p.status === "open") ?? mine.data?.[0];
  return (
    <>
      <PageTitle title="My onboarding" subtitle="Your first-week checklist (if you are new), and the onboarding of people you added, who report to you, who join your department, or whom you buddy." />
      <LoadState loading={mine.loading} error={mine.error} />
      {mine.data && !open && (
        <Panel>
          <Empty>
            You have no onboarding checklist of your own. <Link href="/team" className="underline">Back to My Day</Link>
          </Empty>
        </Panel>
      )}
      {open && (
        <>
          {open.status === "done" && <p className="mb-4 border border-green bg-green/10 px-4 py-2 text-sm">Your onboarding is complete. Welcome aboard!</p>}
          {open.buddy && <p className="mb-4 text-sm">Your buddy is <strong>{open.buddy.name}</strong>. Ask them anything in your first weeks.</p>}
          <PeopleChecklist process={open} viewerIsUser />
        </>
      )}
      <section className="mt-10">
        <PageTitle title="Onboarding history" subtitle="Everyone whose onboarding involves you, with progress and what was done, by whom and when." />
        <OnboardingHistory />
      </section>
    </>
  );
}
