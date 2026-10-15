import Link from "next/link";
import { craftSpecialtyLabel, isCraftManager, isCraftSpecialty } from "@bmu/shared";
import { CraftDashboard } from "@/components/craft/craft-dashboard";
import { ManagerDashboard } from "@/components/craft/manager-dashboard";
import { CustomiseLink } from "@/components/dashboards/customise-link";
import { CustomDashboard } from "@/components/dashboards/custom-dashboard";
import { MyDayPanel } from "@/components/my-day-panel";
import { PageTitle } from "@/components/ui";
import { requireMe, serverApi } from "@/lib/session";

export const metadata = { title: "My Day | BMU Hub" };

const today = new Intl.DateTimeFormat("en-IN", { weekday: "long", day: "numeric", month: "long", timeZone: "Asia/Kolkata" });

function greeting() {
  const h = Number(new Intl.DateTimeFormat("en-IN", { hour: "numeric", hourCycle: "h23", timeZone: "Asia/Kolkata" }).format(new Date()));
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

export default async function MyDay() {
  const me = await requireMe();
  // v12: the Dashboard Studio decides the layout, and can give some people a custom home instead.
  const dash = await (await serverApi()).dashboards.home("team").catch(() => null);
  const customise = dash?.canEdit ? <CustomiseLink id={dash.id} /> : null;
  if (dash && !dash.builtin) return <CustomDashboard view={dash} />;
  const layout = dash?.layout;
  // v10 craft: specialists get their own workspace (My Day essentials stay as a strip on top).
  if (isCraftSpecialty(me.specialty)) {
    return (
      <>
        <PageTitle
          title={`${greeting()}, ${me.name.split(" ")[0]}`}
          subtitle={`${today.format(new Date())}. Your ${craftSpecialtyLabel(me.specialty).toLowerCase()} workspace: what to do next, client feedback and how your work is trending.`}
          action={
            <div className="flex gap-4 text-sm">
              <Link href="/team/tasks" className="text-ink-muted hover:text-ink">
                All tasks →
              </Link>
              <Link href="/team/profile" className="text-ink-muted hover:text-ink">
                Leave & attendance →
              </Link>
              {customise}
            </div>
          }
        />
        <CraftDashboard layout={layout} />
      </>
    );
  }
  // v10 craft: client managers, project managers, CM leads and department heads get the Manager workspace.
  if (isCraftManager(me)) {
    return (
      <>
        <PageTitle
          title={`${greeting()}, ${me.name.split(" ")[0]}`}
          subtitle={`${today.format(new Date())}. Assign work, keep clients moving and see who has room.`}
          action={
            <div className="flex gap-4 text-sm">
              <Link href="/team/tasks" className="text-ink-muted hover:text-ink">
                Team tasks →
              </Link>
              <Link href="/team/capacity" className="text-ink-muted hover:text-ink">
                Capacity →
              </Link>
              {customise}
            </div>
          }
        />
        <ManagerDashboard layout={layout} />
      </>
    );
  }
  const hasLeads = (me.permissions.leads_pipeline?.scope ?? "none") !== "none";

  return (
    <>
      <PageTitle
        title={`${greeting()}, ${me.name.split(" ")[0]}`}
        subtitle={`${today.format(new Date())}. Your tasks, attendance and end-of-day report in one place.`}
        action={
          <div className="flex gap-4 text-sm">
            <Link href="/team/calendar" className="text-ink-muted hover:text-ink">
              Calendar →
            </Link>
            <Link href="/team/profile" className="text-ink-muted hover:text-ink">
              Leave & attendance →
            </Link>
            {customise}
          </div>
        }
      />
      <MyDayPanel layout={layout} hasLeads={hasLeads} />
    </>
  );
}
