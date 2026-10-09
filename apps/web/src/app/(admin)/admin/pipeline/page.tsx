import { LeadBoard } from "@/components/lead-board";
import { FollowUpsStrip } from "@/components/sell/follow-ups-strip";
import { PageTitle } from "@/components/ui";
import { requireMe } from "@/lib/session";

export const metadata = { title: "Pipeline | BMU Hub" };

export default async function PipelinePage() {
  const me = await requireMe();
  const scope = me.permissions.leads_pipeline?.scope ?? "none";
  if (scope === "none") return <PageTitle title="Pipeline" subtitle="Your role doesn't include the sales pipeline." />;
  return (
    <>
      <PageTitle title="Pipeline" subtitle="Every enquiry from the website lands here. Move leads through stages and assign owners." />
      <FollowUpsStrip />
      <LeadBoard canAssign={scope === "all"} />
    </>
  );
}
