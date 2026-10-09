import { Suspense } from "react";
import { PageTitle } from "@/components/ui";
import { ProposalBuilder } from "./proposal-builder";

export const metadata = { title: "New proposal | BMU Hub" };

export default function NewProposalPage() {
  return (
    <>
      <PageTitle title="New proposal" subtitle="Prices come from the active price book. Bundle savings apply automatically." />
      <Suspense>
        <ProposalBuilder />
      </Suspense>
    </>
  );
}
