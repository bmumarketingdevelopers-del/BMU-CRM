import { PageTitle } from "@/components/ui";
import { requireMe } from "@/lib/session";
import { ApprovalsList } from "@/components/actions/approvals-list";
import { ApprovalsInbox } from "./approvals-inbox";
import { PeopleApprovals } from "./people-approvals";
import { MyDiscounts } from "./my-discounts";

export const metadata = { title: "Approvals | BMU Hub" };

/** Roles that approve or manage something; a Sales Executive holding one of these keeps the full page. */
const DECIDING_ROLES = ["founder", "admin", "sales_manager", "am_lead", "department_head", "finance", "hr_ops", "qc_reviewer"];

/** One inbox for managers: leave and timesheets from their team, plus discount approvals for sales leaders. */
export default async function ApprovalsPage() {
  const me = await requireMe(["staff"]);
  // Sales Executives see only the discounts on their own proposals (the API scopes it to them).
  if (me.roles.includes("sales_executive") && !me.roles.some((r) => DECIDING_ROLES.includes(r))) {
    return (
      <>
        <PageTitle title="My discount approvals" subtitle="Special discounts on your proposals: waiting, approved, and the history of approved and rejected ones. Only your own proposals are shown." />
        <MyDiscounts />
      </>
    );
  }
  const discounts = me.roles.some((r) => ["sales_manager", "admin", "founder"].includes(r));
  return (
    <>
      <section className="mb-10" data-testid="needs-you">
        <PageTitle title="Needs you" subtitle="Reassignments, deadline changes, hand-backs and other requests waiting for your decision. Each expires after 72 working hours." />
        <ApprovalsList box="mine" emptyText="Nothing is waiting for your decision." />
        <details className="mt-4">
          <summary className="cursor-pointer text-sm text-ink-muted">What I asked for</summary>
          <div className="mt-3">
            <ApprovalsList box="requested" emptyText="You haven't asked for anything." />
          </div>
        </details>
      </section>
      <PeopleApprovals />
      {discounts && (
        <section className="mt-10">
          <PageTitle title="Discount approvals" subtitle="Proposals with a special discount above the sales limit. Sales managers approve first; discounts above the admin limit then go to the Founder." />
          <ApprovalsInbox />
        </section>
      )}
    </>
  );
}
