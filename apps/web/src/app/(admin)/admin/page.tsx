import { redirect } from "next/navigation";
import { CustomDashboard } from "@/components/dashboards/custom-dashboard";
import { requireMe, serverApi } from "@/lib/session";
import WeeklyReview from "./weekly-review";

// HR & Ops have no access to money and pipeline numbers, so their Command Centre starts at attendance.
export default async function AdminHome() {
  const me = await requireMe(["staff"]);
  if (me.roles.every((r) => r === "hr_ops")) redirect("/admin/attendance");
  // v12: the Dashboard Studio lays out the Weekly Review, or gives some people a custom Command Centre home.
  const dash = await (await serverApi()).dashboards.home("admin").catch(() => null);
  if (dash && !dash.builtin) return <CustomDashboard view={dash} />;
  return <WeeklyReview layout={dash?.layout} canEdit={dash?.canEdit} dashboardId={dash?.id} />;
}
