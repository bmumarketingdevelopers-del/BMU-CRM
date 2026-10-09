import { redirect } from "next/navigation";
import { LeadBoard } from "@/components/lead-board";
import { FollowUpsStrip } from "@/components/sell/follow-ups-strip";
import { PageTitle } from "@/components/ui";
import { requireMe } from "@/lib/session";

export const metadata = { title: "Leads | BMU Hub" };

export default async function TeamLeads() {
  const me = await requireMe();
  const scope = me.permissions.leads_pipeline?.scope ?? "none";
  if (scope === "none") redirect("/team");
  return (
    <>
      <PageTitle title="Leads" subtitle={scope === "own" ? "Leads assigned to you." : "All leads."} />
      <FollowUpsStrip />
      <LeadBoard canAssign={scope === "all"} />
    </>
  );
}
