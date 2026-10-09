"use client";

import { ContentCalendar } from "@/components/deliver/content-calendar";
import { PageTitle } from "@/components/ui";
import { ResultsSummary } from "@/components/creative/publishing";

export default function ClientCalendarPage() {
  return (
    <>
      <PageTitle title="Content calendar" subtitle="Your approved posts and when they go out. Once a post is live you can open it from here." />
      <ContentCalendar mode="client" />
      <ResultsSummary mode="client" />
    </>
  );
}
