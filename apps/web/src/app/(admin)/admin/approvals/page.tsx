import { redirect } from "next/navigation";
import { PageTitle } from "@/components/ui";
import { requireMe } from "@/lib/session";
import { ApprovalsList } from "@/components/actions/approvals-list";

export const metadata = { title: "Approvals | Command Centre" };

/** v11 core: every ApprovalRequest in the organisation (admins) or in my area (AM leads, department heads). */
export default async function AdminApprovalsPage() {
  const me = await requireMe(["staff"]);
  if (!me.roles.some((r) => ["founder", "admin", "am_lead", "department_head"].includes(r))) redirect("/admin");
  return (
    <>
      <PageTitle title="Approvals" subtitle="Reassignments over 120% load or onto leave, deadline changes, hand-backs and other requests. Waiting requests expire after 72 working hours." />
      <section className="mb-8">
        <h2 className="mb-2 text-sm font-semibold">Needs you</h2>
        <ApprovalsList box="mine" emptyText="Nothing is waiting for your decision." />
      </section>
      <ApprovalsList box="all" title="All requests" status="pending" emptyText="No requests match." />
    </>
  );
}
