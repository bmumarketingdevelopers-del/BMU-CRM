"use client";

import Link from "next/link";
import { useState } from "react";
import type { OrgBranchView, OrgStructureView } from "@bmu/shared";
import { BarList, DataTable, Panel, StatRow, StatTile, type Column } from "@/components/dash";
import { Button, Input, LoadState, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { ErrorNote, Field } from "../_admin-org/kit";

export default function BranchesPage() {
  const s = useLoad(() => api.adminOrg.structure());
  const [view, setView] = useState<OrgStructureView>();
  const [error, setError] = useState<string>();
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const data = view ?? s.data;

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const input = { name: String(f.get("name")), city: String(f.get("city")) };
    setError(undefined);
    try {
      setView(editing === "new" ? await api.adminOrg.createBranch(input) : await api.adminOrg.updateBranch(editing!, input));
      setEditing(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const current = data?.branches.find((b) => b.id === editing);
  const columns: Column<OrgBranchView>[] = [
    {
      key: "name",
      header: "Branch",
      cell: (b) => (
        <div>
          <div className="font-medium">{b.name}</div>
          <div className="text-xs text-ink-muted">{b.city}</div>
        </div>
      ),
    },
    { key: "departments", header: "Departments", cell: (b) => (b.departments.length ? b.departments.map((d) => d.name).join(", ") : <span className="text-ink-muted">None yet</span>), className: "max-w-md text-ink-muted" },
    { key: "teams", header: "Teams", align: "right", cell: (b) => b.departments.reduce((n, d) => n + d.teams.length, 0) },
    { key: "headcount", header: "People", align: "right", cell: (b) => b.headcount },
    {
      key: "edit",
      header: "",
      align: "right",
      cell: (b) =>
        data?.canEdit ? (
          <Button variant="ghost" onClick={() => setEditing(b.id)}>
            Edit
          </Button>
        ) : null,
    },
  ];

  return (
    <>
      <PageTitle
        title="Branches"
        subtitle="Your offices and studios, with the departments and people in each."
        action={data?.canEdit && <Button onClick={() => setEditing(editing === "new" ? null : "new")}>{editing === "new" ? "Cancel" : "New branch"}</Button>}
      />
      <ErrorNote>{error}</ErrorNote>
      <LoadState loading={!data && s.loading} error={s.error} />
      {data && (
        <div className="space-y-6">
          <StatRow cols={3}>
            <StatTile label="Branches" value={data.branches.length} />
            <StatTile label="Cities" value={new Set(data.branches.map((b) => b.city)).size} />
            <StatTile label="People" value={data.staff.length} />
          </StatRow>

          {editing && (
            <form key={editing} onSubmit={save} className="grid gap-3 border border-border bg-surface-raised p-5 sm:grid-cols-[1fr_1fr_auto_auto] sm:items-end">
              <Field label="Branch name">
                <Input name="name" required minLength={2} defaultValue={current?.name} placeholder="e.g. Pune Studio" />
              </Field>
              <Field label="City">
                <Input name="city" required minLength={2} defaultValue={current?.city} placeholder="e.g. Pune" />
              </Field>
              <Button type="submit">{editing === "new" ? "Create branch" : "Save changes"}</Button>
              <Button type="button" variant="ghost" onClick={() => setEditing(null)}>
                Cancel
              </Button>
            </form>
          )}

          <div className="grid grid-cols-1 gap-6 [&>*]:min-w-0 lg:grid-cols-[2fr_1fr]">
            <Panel title="All branches" flush>
              <DataTable rows={data.branches} columns={columns} rowKey={(b) => b.id} empty="No branches yet." />
            </Panel>
            <Panel title="People by branch" subtitle="Manage departments under Departments & Teams">
              <BarList items={data.branches.map((b, i) => ({ label: b.name, value: b.headcount, highlight: i === 0 }))} />
              <Link href="/admin/departments" className="mt-5 inline-block text-sm underline">
                Departments & Teams →
              </Link>
            </Panel>
          </div>
        </div>
      )}
    </>
  );
}
