import { redirect } from "next/navigation";
import { requireMe } from "@/lib/session";
import { LeadDetail } from "./lead-detail";

export const metadata = { title: "Lead | BMU Hub" };

export default async function LeadPage({ params }: { params: Promise<{ id: string }> }) {
  const me = await requireMe(["staff"]);
  if ((me.permissions.leads_pipeline?.scope ?? "none") === "none") redirect("/team");
  const { id } = await params;
  return <LeadDetail key={id} id={id} />;
}
