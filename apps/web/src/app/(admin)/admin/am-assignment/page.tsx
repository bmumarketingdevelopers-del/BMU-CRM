"use client";

import { useState } from "react";
import type { AmWorkloadView } from "@bmu/shared";
import { BarList, DataTable, Panel, StatRow, StatTile } from "@/components/dash";
import { Badge, Button, LoadState, PageTitle, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { ErrorNote, ROLE_LABEL } from "../_admin-org/kit";

type ClientRow = AmWorkloadView["clients"][number];

export default function AmAssignmentPage() {
  const w = useLoad(() => api.adminOrg.amWorkload());
  const [view, setView] = useState<AmWorkloadView>();
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<string>();
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState("");
  const data = view ?? w.data;

  async function reassign(c: ClientRow) {
    const amId = choice[c.id];
    const am = data?.ams.find((a) => a.id === amId);
    if (!am) return;
    if (!window.confirm(`Move ${c.name} to ${am.name}? Their open engagements and the client's message thread move too, and ${am.name} is notified.`)) return;
    setError(undefined);
    setDone(undefined);
    try {
      setView(await api.adminOrg.reassignAm(c.id, am.id));
      setChoice((s) => ({ ...s, [c.id]: "" }));
      setDone(`${c.name} is now with ${am.name}.`);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const unassigned = data?.clients.filter((c) => !c.am) ?? [];
  const busiest = data?.ams.reduce<AmWorkloadView["ams"][number] | undefined>((top, a) => (!top || a.activeEngagements > top.activeEngagements ? a : top), undefined);
  const rows = (data?.clients ?? []).filter((c) => !filter || (filter === "none" ? !c.am : c.am?.id === filter));

  return (
    <>
      <PageTitle title="AM Assignment" subtitle="How many clients each account manager looks after, and who should take a client over." />
      <ErrorNote>{error}</ErrorNote>
      {done && <p className="mb-4 border border-green bg-green/10 px-4 py-2 text-sm">{done}</p>}
      <LoadState loading={!data && w.loading} error={w.error} />
      {data && (
        <div className="space-y-6">
          <StatRow>
            <StatTile label="Account managers" value={data.ams.length} />
            <StatTile label="Clients" value={data.clients.length} />
            <StatTile label="Without an AM" value={unassigned.length} tone={unassigned.length ? "bad" : "default"} />
            <StatTile label="Busiest" value={busiest?.activeEngagements ?? 0} hint={busiest ? `${busiest.name} · active engagements` : undefined} />
          </StatRow>

          <div className="grid grid-cols-1 gap-6 [&>*]:min-w-0 lg:grid-cols-[1fr_2fr]">
            <div className="space-y-6">
              <Panel title="Active engagements per AM" subtitle="Paused, offboarding, delivered and closed work is not counted.">
                <BarList
                  items={[...data.ams]
                    .sort((a, b) => b.activeEngagements - a.activeEngagements)
                    .map((a) => ({ label: a.name, value: a.activeEngagements, note: `${a.clients} client${a.clients === 1 ? "" : "s"}`, highlight: a.id === busiest?.id && a.activeEngagements > 0 }))}
                />
              </Panel>
              <Panel title="Team" flush>
                <ul className="divide-y divide-border text-sm">
                  {data.ams.map((a) => (
                    <li key={a.id} className="flex items-center justify-between px-5 py-3">
                      <span>{a.name}</span>
                      <span className="text-xs text-ink-muted">{ROLE_LABEL[a.role]}</span>
                    </li>
                  ))}
                  {data.ams.length === 0 && <li className="px-5 py-6 text-center text-ink-muted">No account managers yet. Give someone the Account Manager role under Users.</li>}
                </ul>
              </Panel>
            </div>

            <Panel
              title="Clients"
              subtitle="Pick a new AM and confirm. It is logged in the audit trail."
              action={
                <Select aria-label="Filter by AM" value={filter} onChange={(e) => setFilter(e.target.value)}>
                  <option value="">All AMs</option>
                  <option value="none">No AM</option>
                  {data.ams.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </Select>
              }
              flush
            >
              <DataTable
                rows={rows}
                rowKey={(c) => c.id}
                empty="No clients yet."
                columns={[
                  {
                    key: "client",
                    header: "Client",
                    cell: (c) => (
                      <div className="flex items-center gap-2">
                        <span className={`inline-block h-2 w-2 ${c.health === "red" ? "bg-red" : c.health === "amber" ? "bg-amber" : "bg-green"}`} title={`Health: ${c.health}`} />
                        <span className="font-medium">{c.name}</span>
                      </div>
                    ),
                  },
                  { key: "active", header: "Active work", align: "right", cell: (c) => c.activeEngagements },
                  { key: "am", header: "Current AM", cell: (c) => c.am?.name ?? <Badge tone="red">None</Badge> },
                  {
                    key: "move",
                    header: "Move to",
                    cell: (c) => (
                      <div className="flex items-center gap-2">
                        <Select aria-label={`New AM for ${c.name}`} value={choice[c.id] ?? ""} onChange={(e) => setChoice((s) => ({ ...s, [c.id]: e.target.value }))}>
                          <option value="">Choose…</option>
                          {data.ams
                            .filter((a) => a.id !== c.am?.id)
                            .map((a) => (
                              <option key={a.id} value={a.id}>
                                {a.name} ({a.activeEngagements})
                              </option>
                            ))}
                        </Select>
                        <Button variant="secondary" disabled={!choice[c.id]} onClick={() => reassign(c)}>
                          Move
                        </Button>
                      </div>
                    ),
                  },
                ]}
              />
            </Panel>
          </div>
        </div>
      )}
    </>
  );
}
