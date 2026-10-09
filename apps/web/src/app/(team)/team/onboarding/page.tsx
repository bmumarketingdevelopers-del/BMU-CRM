"use client";

import Link from "next/link";
import { PeopleChecklist } from "@/components/people-checklist";
import { Empty, Panel } from "@/components/dash";
import { LoadState, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

/** A new hire's own onboarding: progress, SOPs to read and their buddy. */
export default function MyOnboardingPage() {
  const mine = useLoad(() => api.teamFlows.people.mine());
  const open = mine.data?.find((p) => p.status === "open") ?? mine.data?.[0];
  return (
    <>
      <PageTitle title="My onboarding" subtitle="Your first-week checklist. HR ticks documents, laptop and accounts; you read the SOPs and confirm each one." />
      <LoadState loading={mine.loading} error={mine.error} />
      {mine.data && !open && (
        <Panel>
          <Empty>
            You have no onboarding checklist. <Link href="/team" className="underline">Back to My Day</Link>
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
    </>
  );
}
