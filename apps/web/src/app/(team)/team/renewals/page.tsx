import { redirect } from "next/navigation";
import { PageTitle } from "@/components/ui";
import { requireMe } from "@/lib/session";
import { RenewalsList } from "./renewals-list";

export const metadata = { title: "Renewals | BMU Hub" };

export default async function RenewalsPage() {
  const me = await requireMe(["staff"]);
  if (me.permissions.leads_pipeline?.scope !== "all") redirect("/team");
  return (
    <>
      <PageTitle title="Renewals and upsells" subtitle="Engagements ending in the next 45 days, and monthly retainers reaching 6 or 12 months. One click drafts a renewal proposal from the current services; add services to upsell." />
      <RenewalsList />
    </>
  );
}
