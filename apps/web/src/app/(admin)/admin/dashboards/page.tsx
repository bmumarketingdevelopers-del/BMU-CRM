"use client";

/** v12 Dashboard Studio: every dashboard in one place. Edit the built-in ones, build new ones, restore archived ones. */
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { DASHBOARD_BUILTINS, type DashboardRow } from "@bmu/shared";
import { ActionDialog, Field, TextArea } from "@/components/actions/action-drawer";
import { RowMenu } from "@/components/actions/row-menu";
import { DataTable, Empty, Panel, Tabs } from "@/components/dash";
import { NewDashboardDrawer } from "@/components/dashboards/new-dashboard-drawer";
import { Badge, Button, LoadState, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

const when = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });
const changed = (r: DashboardRow) => (r.updatedBy ? `${when.format(new Date(r.updatedAt))} by ${r.updatedBy}` : "Never changed");

export default function DashboardStudioPage() {
  const router = useRouter();
  const state = useLoad(() => api.dashboards.studio());
  const [tab, setTab] = useState<"active" | "archived">("active");
  const [creating, setCreating] = useState(false);
  const [archiving, setArchiving] = useState<DashboardRow | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  async function run(fn: () => Promise<unknown>, message: string) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setToast(message);
      state.reload();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  const duplicate = (r: DashboardRow) =>
    api.dashboards.duplicate(r.id).then(
      (d) => router.push(`/admin/dashboards/${d.id}`),
      (e: Error) => setError(e.message),
    );

  const builtinMenu = (r: DashboardRow) => [
    { key: "edit", label: "Edit layout", href: `/admin/dashboards/${r.id}` },
    { key: "open", label: "Open it", href: r.builtin ? DASHBOARD_BUILTINS[r.builtin].path : "/admin" },
    { key: "copy", label: "Copy into a new dashboard", onSelect: () => duplicate(r), hidden: r.builtin === "client_home" },
    { key: "reset", label: "Reset to original", onSelect: () => run(() => api.dashboards.reset(r.id), `${r.name} is back to its original layout`), disabledReason: r.customised ? null : "It already has the original layout" },
  ];
  const customMenu = (r: DashboardRow) => [
    { key: "edit", label: "Edit", href: `/admin/dashboards/${r.id}` },
    { key: "open", label: "Open it", href: `/team/dashboards/${r.id}` },
    { key: "copy", label: "Duplicate", onSelect: () => duplicate(r) },
    { key: "archive", label: "Archive", danger: true, onSelect: () => (setArchiving(r), setReason("")) },
  ];

  return (
    <>
      <PageTitle
        title="Dashboard Studio"
        subtitle="Change any dashboard in the app, or build a new one and choose who sees it. Every save is kept, so you can go back."
        action={
          <Button onClick={() => setCreating(true)} data-testid="new-dashboard">
            + New dashboard
          </Button>
        }
      />
      {toast && (
        <p role="status" className="mb-4 border border-green bg-green/10 px-4 py-2 text-sm">
          {toast}
        </p>
      )}
      {error && (
        <p role="alert" className="mb-4 border border-red bg-red/10 px-4 py-2 text-sm">
          {error}
        </p>
      )}
      {!state.data ? (
        <LoadState loading={state.loading} error={state.error} />
      ) : (
        <div className="space-y-8">
          <Panel title="Built-in dashboards" subtitle="The home pages everyone already uses. Hide, move and resize their sections, or add your own widgets." flush>
            <DataTable
              rows={state.data.builtins}
              rowKey={(r) => r.id}
              columns={[
                {
                  key: "name",
                  header: "Dashboard",
                  className: "min-w-56",
                  cell: (r) => (
                    <Link href={`/admin/dashboards/${r.id}`} className="font-medium hover:underline">
                      {r.name}
                    </Link>
                  ),
                },
                { key: "where", header: "Where", className: "min-w-48", cell: (r) => <span className="text-ink-muted">{r.where}</span> },
                { key: "who", header: "Who sees it", className: "min-w-56", cell: (r) => <span className="text-ink-muted">{r.who}</span> },
                { key: "state", header: "Layout", cell: (r) => (r.customised ? <Badge tone="green">Customised</Badge> : <Badge>Original</Badge>) },
                { key: "changed", header: "Last changed", className: "min-w-40", cell: (r) => <span className="text-xs text-ink-muted">{changed(r)}</span> },
                { key: "menu", header: "", align: "right", cell: (r) => <RowMenu label={`Actions for ${r.name}`} items={builtinMenu(r)} /> },
              ]}
            />
          </Panel>

          <Panel
            title="Your dashboards"
            subtitle="Built in the Studio. Show them under Dashboards in the menu, or make one someone's home page."
            action={<Tabs value={tab} onChange={setTab} options={[{ value: "active", label: `Active (${state.data.custom.length})` }, { value: "archived", label: `Archived (${state.data.archived.length})` }]} />}
            flush
          >
            {(tab === "active" ? state.data.custom : state.data.archived).length ? (
              <DataTable
                rows={tab === "active" ? state.data.custom : state.data.archived}
                rowKey={(r) => r.id}
                columns={[
                  {
                    key: "name",
                    header: "Dashboard",
                    className: "min-w-56",
                    cell: (r) => (
                      <span>
                        <Link href={`/admin/dashboards/${r.id}`} className="font-medium hover:underline">
                          {r.name}
                        </Link>
                        {r.description && <span className="block text-xs text-ink-muted">{r.description}</span>}
                      </span>
                    ),
                  },
                  { key: "who", header: "Who sees it", className: "min-w-48", cell: (r) => <span className="text-ink-muted">{r.who}</span> },
                  { key: "where", header: "Where", className: "min-w-48", cell: (r) => <span className="text-ink-muted">{r.where}</span> },
                  { key: "widgets", header: "Widgets", align: "right", cell: (r) => r.widgets },
                  tab === "active"
                    ? { key: "changed", header: "Last changed", className: "min-w-40", cell: (r) => <span className="text-xs text-ink-muted">{changed(r)}</span> }
                    : { key: "reason", header: "Why archived", className: "min-w-40", cell: (r) => <span className="text-xs text-ink-muted">{r.archivedReason}</span> },
                  {
                    key: "menu",
                    header: "",
                    align: "right",
                    cell: (r) =>
                      tab === "active" ? (
                        <RowMenu label={`Actions for ${r.name}`} items={customMenu(r)} />
                      ) : (
                        <Button variant="secondary" className="px-3 py-1 text-xs" disabled={busy} onClick={() => run(() => api.dashboards.restore(r.id), `${r.name} restored`)}>
                          Restore
                        </Button>
                      ),
                  },
                ]}
              />
            ) : tab === "active" ? (
              <Empty>
                No dashboards of your own yet.{" "}
                <button className="underline" onClick={() => setCreating(true)}>
                  New dashboard
                </button>
              </Empty>
            ) : (
              <Empty>Nothing archived.</Empty>
            )}
          </Panel>
        </div>
      )}

      {creating && <NewDashboardDrawer open onClose={() => setCreating(false)} studio={state.data} />}
      <ActionDialog
        open={!!archiving}
        title={`Archive ${archiving?.name ?? ""}`}
        onClose={() => setArchiving(null)}
        testId="archive-dashboard"
        footer={
          <>
            <Button
              disabled={busy || reason.trim().length < 3}
              onClick={async () => {
                if (archiving && (await run(() => api.dashboards.archive(archiving.id, reason), `${archiving.name} archived. Restore it from the Archived tab.`))) setArchiving(null);
              }}
            >
              Archive
            </Button>
            <Button variant="ghost" onClick={() => setArchiving(null)}>
              Cancel
            </Button>
          </>
        }
      >
        <p>People stop seeing it straight away. You can restore it any time.</p>
        <Field label="Why" required htmlFor="archive-reason">
          <TextArea id="archive-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Replaced by the new sales dashboard" />
        </Field>
      </ActionDialog>
    </>
  );
}
