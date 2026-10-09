import { FlowMapPage } from "@/components/flows/flow-map-page";
import { PageTitle } from "@/components/ui";
import { requireMe } from "@/lib/session";

export const metadata = { title: "Business Flow Map | BMU Hub" };

const ROLES = ["founder", "admin", "am_lead", "department_head"];

export default async function BusinessFlowMap() {
  const me = await requireMe(["staff"]);
  if (!me.roles.some((r) => ROLES.includes(r))) return <PageTitle title="Business flow map" subtitle="This view is for the Founder, Admins, the AM Lead and Department Heads." />;
  return <FlowMapPage />;
}
