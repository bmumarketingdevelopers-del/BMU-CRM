import Link from "next/link";
import { CustomDashboard } from "@/components/dashboards/custom-dashboard";
import { Empty, Panel } from "@/components/dash";
import { PageTitle } from "@/components/ui";
import { serverApi } from "@/lib/session";

export const metadata = { title: "Dashboard | BMU Hub" };

export default async function TeamDashboardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await (await serverApi()).dashboards.get(id).then(
    (view) => ({ view, error: null }),
    (e: Error) => ({ view: null, error: e.message }),
  );
  if (!result.view || result.view.builtin)
    return (
      <>
        <PageTitle title="Dashboard" />
        <Panel>
          <Empty>
            {result.error ?? "This is a built-in dashboard."}{" "}
            <Link href="/team/dashboards" className="underline">
              All dashboards
            </Link>
          </Empty>
        </Panel>
      </>
    );
  return <CustomDashboard view={result.view} />;
}
