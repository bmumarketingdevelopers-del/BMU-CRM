import Link from "next/link";
import { Empty, Panel } from "@/components/dash";
import { PageTitle } from "@/components/ui";
import { requireMe, serverApi } from "@/lib/session";

export const metadata = { title: "Dashboards | BMU Hub" };

/** v12: dashboards made in the Dashboard Studio for this person. */
export default async function TeamDashboardsPage() {
  const me = await requireMe();
  const mine = await (await serverApi()).dashboards.mine().catch(() => []);
  const admin = me.roles.some((r) => r === "founder" || r === "admin");
  return (
    <>
      <PageTitle
        title="Dashboards"
        subtitle="Dashboards made for you and your team."
        action={
          admin ? (
            <Link href="/admin/dashboards" className="text-sm text-ink-muted hover:text-ink">
              Dashboard Studio →
            </Link>
          ) : undefined
        }
      />
      {mine.length ? (
        <Panel flush>
          <ul className="divide-y divide-border">
            {mine.map((d) => (
              <li key={d.id}>
                <Link href={`/team/dashboards/${d.id}`} className="flex items-center justify-between gap-3 px-5 py-4 hover:bg-canvas/40">
                  <span className="min-w-0">
                    <span className="block font-medium">{d.name}</span>
                    {d.description && <span className="block truncate text-sm text-ink-muted">{d.description}</span>}
                  </span>
                  <span className="shrink-0 text-sm text-ink-muted">Open →</span>
                </Link>
              </li>
            ))}
          </ul>
        </Panel>
      ) : (
        <Panel>
          <Empty>No dashboards have been shared with you yet.{admin ? " Build one in the Dashboard Studio." : ""}</Empty>
        </Panel>
      )}
    </>
  );
}
