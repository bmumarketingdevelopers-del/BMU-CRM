import { requireMe } from "@/lib/session";
import { HrIssuesWorkspace } from "./hr-issues-workspace";

export const metadata = { title: "Raise an issue with HR | BMU Hub" };

/** v50: any team member raises a concern with HR; HR see and answer them here too. v52: HR people raise theirs with the Branch Manager. */
export default async function HrIssuesPage() {
  await requireMe(["staff"]);
  return <HrIssuesWorkspace />;
}
