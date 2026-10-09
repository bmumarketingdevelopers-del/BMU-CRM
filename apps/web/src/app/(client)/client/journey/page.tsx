import { JourneyPanel } from "@/components/flows/journey-timeline";
import { PageTitle } from "@/components/ui";
import { requireMe } from "@/lib/session";

export const metadata = { title: "Project journey | BMU Hub" };

export default async function ClientJourneyPage() {
  await requireMe(["client"]);
  return (
    <>
      <PageTitle title="Project journey" subtitle="Every step of your project, from signing to final files, with the dates we planned and the dates it happened." />
      <div className="border border-border bg-surface-raised p-5 sm:p-6">
        <JourneyPanel friendly />
      </div>
    </>
  );
}
