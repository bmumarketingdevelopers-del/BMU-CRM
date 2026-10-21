"use client";

import { HandoffInboxView } from "@/components/deliver/handoff";
import { EstimateInbox } from "@/components/deliver/project-flow";
import { PageTitle } from "@/components/ui";

/** v37: Client Managers send new project work to Department Heads; Department Heads pick their team here. */
export default function HandoffPage() {
  return (
    <>
      <PageTitle title="Work hand-off" subtitle="New project work goes from the Client Manager to the Department Head, who picks the people. Production starts once every step has a person." />
      <div className="grid gap-6">
        <EstimateInbox />
        <HandoffInboxView />
      </div>
    </>
  );
}
