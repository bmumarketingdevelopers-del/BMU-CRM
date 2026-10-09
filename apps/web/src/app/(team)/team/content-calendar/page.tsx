"use client";

import { ContentCalendar } from "@/components/deliver/content-calendar";
import { PageTitle } from "@/components/ui";
import { PublishingSettings, ResultsSummary } from "@/components/creative/publishing";

export default function TeamContentCalendarPage() {
  return (
    <>
      <PageTitle
        title="Content calendar"
        subtitle="Approved posts, reels and ads by the day they go out. Only approved work can be scheduled. Drag to schedule or move, post it on the channel, then mark it published with its live link and add its results. Clients see the same calendar."
      />
      <ContentCalendar mode="team" />
      <ResultsSummary mode="team" />
      <PublishingSettings />
    </>
  );
}
