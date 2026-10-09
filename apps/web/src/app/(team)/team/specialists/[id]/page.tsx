import { CraftDashboard } from "@/components/craft/craft-dashboard";
import { PageTitle } from "@/components/ui";

export const metadata = { title: "Specialist dashboard | BMU Hub" };

/** v10 craft: a team member's dashboard, read-only, for leads and the managers of their clients. */
export default async function SpecialistPage({ params }: PageProps<"/team/specialists/[id]">) {
  const { id } = await params;
  return (
    <>
      <PageTitle title="Specialist dashboard" subtitle="Exactly what they see, without the actions." />
      <CraftDashboard userId={id} />
    </>
  );
}
