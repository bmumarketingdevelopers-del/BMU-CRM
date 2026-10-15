import { canOpenCraftManager } from "@bmu/shared";
import { ManagerDashboard } from "@/components/craft/manager-dashboard";
import { Empty } from "@/components/dash";
import { PageTitle } from "@/components/ui";
import { CustomiseLink } from "@/components/dashboards/customise-link";
import { requireMe, serverApi } from "@/lib/session";

export const metadata = { title: "Manager workspace | BMU Hub" };

/** v10 craft: the Manager workspace at its own address (founders and admins reach it from the nav). */
export default async function ManagerPage() {
  const me = await requireMe();
  const dash = await (await serverApi()).dashboards.builtin("manager").catch(() => null);
  return (
    <>
      <PageTitle title="Manager workspace" subtitle="Assign work across the team, keep clients moving and see who has room." action={dash?.canEdit ? <CustomiseLink id={dash.id} /> : undefined} />
      {canOpenCraftManager(me) ? <ManagerDashboard layout={dash?.layout} /> : <Empty>The manager workspace is for client managers, project managers and department heads.</Empty>}
    </>
  );
}
