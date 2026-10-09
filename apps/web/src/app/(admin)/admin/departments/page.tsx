"use client";

import { useState } from "react";
import type { OrgDepartmentView, OrgStructureView, PersonRef } from "@bmu/shared";
import { Empty, Panel, StatRow, StatTile, Tabs } from "@/components/dash";
import { Button, Input, LoadState, PageTitle, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { ErrorNote, Field } from "../_admin-org/kit";

export default function DepartmentsPage() {
  const s = useLoad(() => api.adminOrg.structure());
  const [branchId, setBranchId] = useState<string>();
  const [error, setError] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [view, setView] = useState<OrgStructureView>();
  const data = view ?? s.data;

  async function run(fn: () => Promise<OrgStructureView>) {
    setError(undefined);
    try {
      setView(await fn());
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  }

  if (!data) {
    return (
      <>
        <PageTitle title="Departments & Teams" subtitle="Who works where: departments in each branch, their heads, and the teams (pods) inside them." />
        <LoadState loading={s.loading} error={s.error} />
      </>
    );
  }

  const branch = data.branches.find((b) => b.id === branchId) ?? data.branches[0];
  const allTeams = data.branches.flatMap((b) => b.departments.flatMap((d) => d.teams.map((t) => ({ ...t, label: `${t.name} · ${d.name}${data.branches.length > 1 ? ` (${b.name})` : ""}` }))));
  const departments = data.branches.flatMap((b) => b.departments);
  const noTeam = data.staff.filter((p) => !p.teamId).length;
  const noDept = data.staff.filter((p) => !p.departmentId);

  return (
    <>
      <PageTitle
        title="Departments & Teams"
        subtitle="Who works where: departments in each branch, their heads, and the teams (pods) inside them. Every change is logged."
        action={data.canEdit && <Button onClick={() => setAdding((v) => !v)}>{adding ? "Cancel" : "New department"}</Button>}
      />
      <ErrorNote>{error}</ErrorNote>

      <StatRow>
        <StatTile label="Departments" value={departments.length} hint={`across ${data.branches.length} branch${data.branches.length === 1 ? "" : "es"}`} />
        <StatTile label="Teams (pods)" value={allTeams.length} />
        <StatTile label="People" value={data.staff.length} />
        <StatTile label="Not in a team" value={noTeam} tone={noDept.length ? "warn" : "default"} hint={noDept.length ? `${noDept.length} with no department` : undefined} />
      </StatRow>

      {adding && branch && (
        <form
          className="mt-6 grid gap-3 border border-border bg-surface-raised p-5 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            if (await run(() => api.adminOrg.createDepartment({ branchId: String(f.get("branchId")), name: String(f.get("name")) }))) setAdding(false);
          }}
        >
          <Field label="Department name">
            <Input name="name" required minLength={2} placeholder="e.g. Performance Marketing" />
          </Field>
          <Field label="Branch">
            <Select name="branchId" defaultValue={branch.id} className="w-full py-2">
              {data.branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          </Field>
          <Button type="submit">Create department</Button>
        </form>
      )}

      {data.branches.length > 1 && (
        <div className="mt-8">
          <Tabs value={branch?.id ?? ""} onChange={setBranchId} options={data.branches.map((b) => ({ value: b.id, label: `${b.name} · ${b.headcount}` }))} />
        </div>
      )}

      <div className="mt-6 space-y-6">
        {branch && branch.departments.length === 0 && (
          <Panel>
            <Empty>No departments in {branch.name} yet. Create one to start placing people.</Empty>
          </Panel>
        )}
        {branch?.departments.map((d) => (
          <DepartmentPanel key={d.id} d={d} staff={data.staff} teams={allTeams} canEdit={data.canEdit} run={run} />
        ))}
      </div>
    </>
  );
}

type Run = (fn: () => Promise<OrgStructureView>) => Promise<boolean>;

function DepartmentPanel({ d, staff, teams, canEdit, run }: { d: OrgDepartmentView; staff: PersonRef[]; teams: { id: string; label: string }[]; canEdit: boolean; run: Run }) {
  const [renaming, setRenaming] = useState(false);
  const [addingTeam, setAddingTeam] = useState(false);
  const empty = d.headcount === 0 && d.teams.length === 0;

  const move = (userId: string, value: string) =>
    run(() => api.adminOrg.moveMember(value === "__none" ? { userId, teamId: null, departmentId: d.id } : { userId, teamId: value }));

  const moveSelect = (person: PersonRef, current: string | null) =>
    canEdit ? (
      <Select aria-label={`Move ${person.name}`} value={current ?? "__none"} onChange={(e) => move(person.id, e.target.value)} className="max-w-[11rem] text-xs">
        <option value="__none">No team</option>
        {teams.map((t) => (
          <option key={t.id} value={t.id}>
            {t.label}
          </option>
        ))}
      </Select>
    ) : null;

  return (
    <Panel
      title={d.name}
      subtitle={`${d.headcount} ${d.headcount === 1 ? "person" : "people"} · ${d.teams.length} team${d.teams.length === 1 ? "" : "s"}`}
      action={
        canEdit && (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="ghost" onClick={() => setRenaming((v) => !v)}>
              Rename
            </Button>
            <Button variant="ghost" onClick={() => setAddingTeam((v) => !v)}>
              Add team
            </Button>
            <Button
              variant="ghost"
              disabled={!empty}
              title={empty ? "Delete this department" : "Move everyone out and remove its teams first"}
              onClick={() => window.confirm(`Delete ${d.name}?`) && run(() => api.adminOrg.deleteDepartment(d.id))}
            >
              Delete
            </Button>
          </div>
        )
      }
    >
      {renaming && (
        <form
          className="mb-5 flex flex-wrap gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            const name = String(new FormData(e.currentTarget).get("name"));
            if (await run(() => api.adminOrg.updateDepartment(d.id, { name }))) setRenaming(false);
          }}
        >
          <Input name="name" defaultValue={d.name} required minLength={2} className="max-w-xs" aria-label="Department name" />
          <Button type="submit">Save name</Button>
        </form>
      )}

      <div className="mb-5 flex flex-wrap items-center gap-3 text-sm">
        <span className="text-ink-muted">Department head</span>
        {canEdit ? (
          <Select aria-label="Department head" value={d.head?.id ?? ""} onChange={(e) => run(() => api.adminOrg.updateDepartment(d.id, { headUserId: e.target.value || null }))}>
            <option value="">Not set</option>
            {staff.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        ) : (
          <span className="font-medium">{d.head?.name ?? "Not set"}</span>
        )}
      </div>

      {addingTeam && (
        <form
          className="mb-5 grid gap-3 border border-border p-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const lead = String(f.get("lead") || "");
            if (await run(() => api.adminOrg.createTeam({ departmentId: d.id, name: String(f.get("name")), leadUserId: lead || null }))) setAddingTeam(false);
          }}
        >
          <Field label="Team name">
            <Input name="name" required minLength={2} placeholder="e.g. Pod C" />
          </Field>
          <Field label="Team lead (joins the team)">
            <Select name="lead" defaultValue="" className="w-full py-2">
              <option value="">Choose later</option>
              {staff.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <Button type="submit">Create team</Button>
        </form>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {d.teams.map((t) => (
          <div key={t.id} className="border border-border bg-surface-raised p-4">
            <div className="flex items-start justify-between gap-2">
              <p className="font-medium">{t.name}</p>
              {canEdit && t.members.length === 0 && (
                <button className="text-xs text-ink-muted hover:text-ink" onClick={() => window.confirm(`Remove ${t.name}?`) && run(() => api.adminOrg.deleteTeam(t.id))}>
                  Remove
                </button>
              )}
            </div>
            <div className="mt-2 flex items-center gap-2 text-xs text-ink-muted">
              Lead
              {canEdit ? (
                <Select aria-label={`${t.name} lead`} value={t.lead?.id ?? ""} onChange={(e) => run(() => api.adminOrg.updateTeam(t.id, { leadUserId: e.target.value || null }))} className="text-xs">
                  <option value="">Not set</option>
                  {staff.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              ) : (
                <span className="text-ink">{t.lead?.name ?? "Not set"}</span>
              )}
            </div>
            <ul className="mt-3 divide-y divide-border border-t border-border text-sm">
              {t.members.map((m) => (
                <li key={m.id} className="flex items-center justify-between gap-2 py-2">
                  <span className="truncate">
                    {m.name}
                    {t.lead?.id === m.id && <span className="ml-2 text-xs text-[#5f8a12]">Lead</span>}
                  </span>
                  {moveSelect(m, t.id)}
                </li>
              ))}
              {t.members.length === 0 && <li className="py-2 text-xs text-ink-muted">No members yet</li>}
            </ul>
          </div>
        ))}
        {d.teams.length === 0 && <p className="text-sm text-ink-muted sm:col-span-2 lg:col-span-3">No teams yet. Small departments can work without one.</p>}
      </div>

      {d.unassigned.length > 0 && (
        <div className="mt-5">
          <p className="mb-2 text-[11px] uppercase tracking-[0.1em] text-ink-muted">In the department, not in a team</p>
          <ul className="divide-y divide-border border-y border-border text-sm">
            {d.unassigned.map((m) => (
              <li key={m.id} className="flex items-center justify-between gap-2 py-2">
                <span className="truncate">{m.name}</span>
                {moveSelect(m, null)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  );
}
