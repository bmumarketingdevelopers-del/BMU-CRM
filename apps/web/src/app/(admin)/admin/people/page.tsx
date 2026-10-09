"use client";

import { useState } from "react";
import type { TeamPeopleOptions, TeamPeopleProcess } from "@bmu/shared";
import { processStatusTone } from "@/components/people-checklist";
import { DataTable, Meter, Panel, StatRow, StatTile, Tabs, type Column } from "@/components/dash";
import { Badge, Button, Input, LoadState, PageTitle, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

type Kind = "onboarding" | "offboarding";
const fmt = (d: string | null) => (d ? new Date(`${d}T12:00:00+05:30`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "—");
const todayIst = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

/** Command Centre → Onboarding & Offboarding: HR runs new-hire and leaver checklists. */
export default function PeoplePage() {
  const [kind, setKind] = useState<Kind>("onboarding");
  const [starting, setStarting] = useState<Kind>();
  const list = useLoad(() => api.teamFlows.people.list());
  const options = useLoad(() => api.teamFlows.people.options());
  const rows = (list.data ?? []).filter((p) => p.kind === kind);
  const open = (k: Kind) => (list.data ?? []).filter((p) => p.kind === k && p.status === "open");

  const columns: Column<TeamPeopleProcess>[] = [
    { key: "who", header: "Person", cell: (p) => <span><span className="font-medium">{p.user.name}</span><span className="block text-xs text-ink-muted">{[p.user.role, p.user.department].filter(Boolean).join(" · ") || p.user.email}</span></span> },
    { key: "date", header: kind === "onboarding" ? "Start date" : "Last day", cell: (p) => fmt(kind === "onboarding" ? p.startDate : p.lastDay) },
    ...(kind === "onboarding" ? [{ key: "buddy", header: "Buddy", cell: (p: TeamPeopleProcess) => p.buddy?.name ?? "—" }] : [{ key: "access", header: "Access", cell: (p: TeamPeopleProcess) => (p.user.status === "suspended" ? <Badge tone="red">Suspended</Badge> : <Badge>Active</Badge>) }]),
    { key: "progress", header: "Progress", cell: (p) => <div className="w-40"><Meter value={p.progressPct} tone={p.progressPct === 100 ? "good" : "default"} /></div> },
    { key: "status", header: "Status", cell: (p) => <Badge tone={processStatusTone(p.status)}>{p.status === "open" ? "In progress" : p.status === "done" ? "Complete" : "Cancelled"}</Badge> },
  ];

  return (
    <>
      <PageTitle
        title="Onboarding & Offboarding"
        subtitle="Checklists for new hires (documents, laptop, accounts, SOPs to read, buddy) and leavers (hand over work, return equipment, access ends on the last day)."
        action={
          <div className="flex gap-2">
            <Button onClick={() => setStarting(starting === "onboarding" ? undefined : "onboarding")}>Start onboarding</Button>
            <Button variant="secondary" onClick={() => setStarting(starting === "offboarding" ? undefined : "offboarding")}>
              Start offboarding
            </Button>
          </div>
        }
      />
      <div className="mb-6">
        <StatRow cols={3}>
          <StatTile label="New hires onboarding" value={open("onboarding").length} hint="checklists in progress" />
          <StatTile label="Leavers offboarding" value={open("offboarding").length} tone={open("offboarding").length ? "warn" : "default"} hint="work to hand over" />
          <StatTile label="SOPs still to read" value={open("onboarding").reduce((s, p) => s + p.items.filter((i) => i.sopId && !i.done).length, 0)} hint="by people onboarding" />
        </StatRow>
      </div>

      {starting && options.data && <StartForm kind={starting} options={options.data} onDone={() => { setStarting(undefined); list.reload(); }} />}
      {starting && options.error && <p className="mb-4 border border-red bg-red/10 px-4 py-2 text-sm">{options.error}</p>}

      <div className="mb-4">
        <Tabs value={kind} onChange={setKind} options={[{ value: "onboarding", label: `Onboarding (${(list.data ?? []).filter((p) => p.kind === "onboarding").length})` }, { value: "offboarding", label: `Offboarding (${(list.data ?? []).filter((p) => p.kind === "offboarding").length})` }]} />
      </div>
      <LoadState loading={list.loading && !list.data} error={list.error} />
      {list.data && (
        <Panel flush>
          <DataTable rows={rows} columns={columns} rowKey={(p) => p.id} rowHref={(p) => `/admin/people/${p.id}`} empty={kind === "onboarding" ? "No onboarding yet. Start one when someone joins." : "No offboarding yet."} />
        </Panel>
      )}
    </>
  );
}

function StartForm({ kind, options, onDone }: { kind: Kind; options: TeamPeopleOptions; onDone: () => void }) {
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [sopIds, setSopIds] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const v = (k: string) => String(f.get(k) ?? "").trim() || undefined;
    setBusy(true);
    setError(undefined);
    try {
      if (kind === "offboarding") {
        await api.teamFlows.people.startOffboarding({ userId: v("userId")!, lastDay: v("lastDay")!, note: v("note") });
      } else {
        const contact = v("contact");
        await api.teamFlows.people.startOnboarding({
          ...(mode === "existing"
            ? { userId: v("userId") }
            : { newHire: { name: v("name") ?? "", ...(contact?.includes("@") ? { email: contact } : { phone: contact }), roleId: v("roleId") ?? "", departmentId: v("departmentId"), managerId: v("managerId") } }),
          buddyId: v("buddyId"),
          startDate: v("startDate"),
          sopIds,
          note: v("note"),
        });
      }
      onDone();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Panel className="mb-6" title={kind === "onboarding" ? "Start onboarding" : "Start offboarding"} subtitle={kind === "onboarding" ? "A new hire gets a BMU Hub login straight away and sees their checklist under Team app → My onboarding." : "Their open tasks, clients and leads are listed so you can hand them over. Access is suspended on the last day."}>
      <form onSubmit={submit} className="grid gap-3">
        {kind === "onboarding" && (
          <div className="flex gap-4 text-sm">
            <label className="flex items-center gap-2">
              <input type="radio" checked={mode === "new"} onChange={() => setMode("new")} /> New hire (creates their login)
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" checked={mode === "existing"} onChange={() => setMode("existing")} /> Someone already invited
            </label>
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {kind === "onboarding" && mode === "new" ? (
            <>
              <Input name="name" placeholder="Full name" required aria-label="Full name" />
              <Input name="contact" placeholder="Email or mobile" required aria-label="Email or mobile" />
              <Select name="roleId" required defaultValue="" aria-label="Role">
                <option value="" disabled>
                  Role
                </option>
                {options.roles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </Select>
              <Select name="departmentId" defaultValue="" aria-label="Department">
                <option value="">Department</option>
                {options.departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </Select>
              <Select name="managerId" defaultValue="" aria-label="Reports to">
                <option value="">Reports to</option>
                {options.staff.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </Select>
            </>
          ) : (
            <Select name="userId" required defaultValue="" aria-label="Person">
              <option value="" disabled>
                Person
              </option>
              {options.staff.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                  {u.department ? ` · ${u.department}` : ""}
                </option>
              ))}
            </Select>
          )}
          {kind === "onboarding" ? (
            <>
              <Select name="buddyId" defaultValue="" aria-label="Buddy">
                <option value="">Buddy (optional)</option>
                {options.staff.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </Select>
              <label className="text-xs text-ink-muted">
                Start date
                <Input name="startDate" type="date" defaultValue={todayIst()} />
              </label>
            </>
          ) : (
            <label className="text-xs text-ink-muted">
              Last working day
              <Input name="lastDay" type="date" required min={todayIst()} />
            </label>
          )}
          <Input name="note" placeholder="Note (optional)" aria-label="Note" />
        </div>
        {kind === "onboarding" && options.sops.length > 0 && (
          <fieldset className="border border-border p-3">
            <legend className="px-1 text-xs text-ink-muted">Induction SOPs to read (they press “I have read this” for each)</legend>
            <div className="grid gap-1 sm:grid-cols-2">
              {options.sops.map((s) => (
                <label key={s.id} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={sopIds.includes(s.id)} onChange={(e) => setSopIds(e.target.checked ? [...sopIds, s.id] : sopIds.filter((x) => x !== s.id))} />
                  <span>
                    {s.title} <span className="text-xs text-ink-muted">· {s.department}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        )}
        {error && <p className="border border-red bg-red/10 px-3 py-2 text-sm">{error}</p>}
        <div>
          <Button type="submit" disabled={busy}>
            {busy ? "Starting…" : kind === "onboarding" ? "Start onboarding" : "Start offboarding"}
          </Button>
        </div>
      </form>
    </Panel>
  );
}

