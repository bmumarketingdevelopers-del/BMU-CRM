"use client";

/**
 * Users: everyone on the team with + Add, Import (CSV with duplicate check), search, filters, saved views, multi-select
 * bulk (Move, Add role, Export), CSV export and a ⋯ menu per row. Click a name for the full profile and its History.
 * `?u=<id>` (from global search) highlights and scrolls to that person.
 */
import { use, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { PEOPLE_EMPLOYMENT_TYPES, peopleEmploymentLabels, type PeopleOptions, type PeoplePersonRow } from "@bmu/shared";
import { useActions } from "@/components/actions/actions-provider";
import { ActionDialog, Field, inputCls } from "@/components/actions/action-drawer";
import { BulkBar, BulkButton, useSelection } from "@/components/actions/bulk-bar";
import { ImportWizard } from "@/components/actions/import-wizard";
import { LoadBar } from "@/components/actions/person-picker";
import { RowMenu } from "@/components/actions/row-menu";
import { SavedViewsMenu } from "@/components/actions/saved-views-menu";
import { CsvButton } from "@/components/charts";
import { Avatar, statusTone } from "@/components/people/person-drawer";
import { personMenuItems, usePersonActions } from "@/components/people/person-actions";
import { fmtDay, todayIst, usePeopleOptions } from "@/components/people/use-people-options";
import { Badge, Card, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";

type Filters = { q: string; departmentId: string; roleId: string; status: string; branchId: string; employmentType: string; former: string };
type Undo = { token: string; label: string; expiresAt: string } | null;
const EMPTY: Filters = { q: "", departmentId: "", roleId: "", status: "", branchId: "", employmentType: "", former: "" };
const sel = "min-w-0 max-w-[11rem] border border-border bg-surface-raised px-2 py-1.5 text-sm";

const csvColumns: { header: string; value: (r: PeoplePersonRow) => string | number | null }[] = [
  { header: "Name", value: (r) => r.name },
  { header: "Email", value: (r) => r.email },
  { header: "Mobile", value: (r) => r.phone },
  { header: "Roles", value: (r) => r.roles.map((x) => x.name).join(" + ") },
  { header: "Department", value: (r) => r.department?.name ?? "" },
  { header: "Team", value: (r) => r.team?.name ?? "" },
  { header: "Reports to", value: (r) => r.manager?.name ?? "" },
  { header: "Branch", value: (r) => r.branch?.name ?? "" },
  { header: "Joined", value: (r) => r.joiningDate },
  { header: "Employment", value: (r) => (r.employmentType ? peopleEmploymentLabels[r.employmentType] : "") },
  { header: "Status", value: (r) => (r.leftAt ? "former" : r.status) },
  { header: "Load %", value: (r) => r.loadPct },
];

function downloadCsv(rows: PeoplePersonRow[], filename: string) {
  const esc = (v: unknown) => {
    const t = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const csv = [csvColumns.map((c) => esc(c.header)).join(","), ...rows.map((r) => csvColumns.map((c) => esc(c.value(r))).join(","))].join("\n");
  const url = URL.createObjectURL(new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${filename}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function UsersPage({ searchParams }: { searchParams: Promise<{ u?: string }> }) {
  const { u: focus } = use(searchParams);
  const { openNew, openBulkReassign, notify, version, changed, me } = useActions();
  const { opts, error: optsError } = usePeopleOptions(true);
  const [f, setF] = useState<Filters>(EMPTY);
  const [rows, setRows] = useState<PeoplePersonRow[]>();
  const [error, setError] = useState<string>();
  const [n, setN] = useState(0);
  const [importing, setImporting] = useState(false);
  const [bulk, setBulk] = useState<"move" | "add_role" | null>(null);
  const reload = () => {
    setN((x) => x + 1);
    changed();
  };
  const pa = usePersonActions(reload);
  const query = JSON.stringify(f);

  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      api.peopleActions
        .list(JSON.parse(query) as Filters)
        .then((r) => {
          if (!live) return;
          setRows(r);
          setError(undefined);
        })
        .catch((e: Error) => live && setError(e.message));
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [query, version, n]);

  useEffect(() => {
    if (focus && rows) document.getElementById(`user-${focus}`)?.scrollIntoView({ block: "center" });
  }, [focus, rows]);

  const ids = useMemo(() => (rows ?? []).filter((r) => !r.leftAt).map((r) => r.id), [rows]);
  const selection = useSelection(ids);
  const picked = (rows ?? []).filter((r) => selection.has(r.id));
  const can = opts?.can;
  const filtered = Object.entries(f).some(([k, v]) => k !== "q" && v);
  const set = (k: keyof Filters, v: string) => setF((x) => ({ ...x, [k]: v }));

  async function setStatus(r: PeoplePersonRow, status: "active" | "suspended") {
    if (status === "suspended" && !window.confirm(`Suspend ${r.name}? They lose access straight away.`)) return;
    try {
      await api.org.updateUser(r.id, { status });
      notify(status === "active" ? `${r.name} can sign in again` : `${r.name} is suspended`);
      reload();
    } catch (e) {
      notify((e as Error).message, null, "error");
    }
  }

  async function resend(r: PeoplePersonRow) {
    try {
      notify((await api.peopleActions.resendInvite(r.id)).message);
    } catch (e) {
      notify((e as Error).message, null, "error");
    }
  }

  function menu(r: PeoplePersonRow) {
    if (!can) return [];
    const items = personMenuItems(r, can, pa.open, { meId: me.id, reassign: () => openBulkReassign(r.id, reload), onInvite: () => resend(r) });
    const founder = r.roles.some((x) => x.baseRole === "founder");
    if (can.edit && !r.leftAt && !founder && r.id !== me.id) {
      items.splice(items.length - 2, 0, r.status === "suspended" ? { key: "restore", label: "Restore access", onSelect: () => setStatus(r, "active") } : { key: "suspend", label: "Suspend access", onSelect: () => setStatus(r, "suspended"), danger: true });
    }
    return items;
  }

  const status = (r: PeoplePersonRow) => (
    <div className="flex flex-wrap gap-1">
      <Badge tone={statusTone(r.status)}>{r.leftAt ? "Former" : r.status}</Badge>
      {r.onLeaveToday && <Badge tone="amber">On leave</Badge>}
      {r.pending.scheduled + r.pending.approvals > 0 && <Badge tone="dark">Change pending</Badge>}
    </div>
  );

  return (
    <>
      <PageTitle
        title="Users"
        subtitle="Everyone on the team. Add, move, change roles or offboard; every change is logged in the person's History."
        action={
          <div className="flex flex-wrap gap-2">
            {can?.import && (
              <button type="button" className="border border-border px-3 py-2 text-sm hover:border-ink" onClick={() => setImporting(true)}>
                Import
              </button>
            )}
            {can?.addPerson && (
              <button type="button" className="bg-charcoal px-4 py-2 text-sm font-medium text-ivory" onClick={() => openNew("person", {}, () => reload())}>
                + Add person
              </button>
            )}
          </div>
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input value={f.q} onChange={(e) => set("q", e.target.value)} placeholder="Search name, email or mobile" aria-label="Search people" className="min-w-0 flex-1 border border-border bg-surface-raised px-3 py-1.5 text-sm sm:max-w-xs" />
        <select className={sel} value={f.departmentId} onChange={(e) => set("departmentId", e.target.value)} aria-label="Department">
          <option value="">All departments</option>
          {opts?.departments.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
        <select className={sel} value={f.roleId} onChange={(e) => set("roleId", e.target.value)} aria-label="Role">
          <option value="">All roles</option>
          {opts?.roles.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
        <select className={sel} value={f.status} onChange={(e) => set("status", e.target.value)} aria-label="Status">
          <option value="">Any status</option>
          <option value="active">Active</option>
          <option value="invited">Invited</option>
          <option value="suspended">Suspended</option>
        </select>
        {(opts?.branches.length ?? 0) > 1 && (
          <select className={sel} value={f.branchId} onChange={(e) => set("branchId", e.target.value)} aria-label="Branch">
            <option value="">All branches</option>
            {opts?.branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        )}
        <select className={sel} value={f.employmentType} onChange={(e) => set("employmentType", e.target.value)} aria-label="Employment type">
          <option value="">Any employment</option>
          {PEOPLE_EMPLOYMENT_TYPES.map((t) => (
            <option key={t} value={t}>
              {peopleEmploymentLabels[t]}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-sm">
          <input type="checkbox" checked={f.former === "1"} onChange={(e) => set("former", e.target.checked ? "1" : "")} /> Former
        </label>
        {(filtered || f.q) && (
          <button type="button" className="text-sm underline" onClick={() => setF(EMPTY)}>
            Clear
          </button>
        )}
        <span className="ml-auto flex flex-wrap items-center gap-2">
          <SavedViewsMenu entity="person" filters={f} onApply={(x) => setF({ ...EMPTY, ...(x as Partial<Filters>) })} />
          <CsvButton rows={rows ?? []} columns={csvColumns} filename="people" label="Export" />
        </span>
      </div>

      {(error || optsError) && (
        <p className="mb-4 border border-red bg-red/10 px-4 py-2 text-sm" role="alert">
          {error ?? optsError}{" "}
          <button type="button" className="underline" onClick={() => setN((x) => x + 1)}>
            Try again
          </button>
        </p>
      )}
      {(!rows || !opts) && !error && !optsError && <p className="text-sm text-ink-muted">Loading people…</p>}
      {rows && opts && rows.length === 0 && (
        <Card>
          <p className="text-sm">{filtered || f.q ? "No one matches these filters." : "No one here yet."}</p>
          {can?.addPerson && (
            <button type="button" className="mt-3 bg-charcoal px-4 py-2 text-sm font-medium text-ivory" onClick={() => openNew("person", {}, () => reload())}>
              + Add person
            </button>
          )}
        </Card>
      )}

      {rows && rows.length > 0 && can && (
        <>
          {/* Phone: cards. Wider: table. */}
          <ul className="grid grid-cols-1 gap-2 md:hidden" data-testid="people-cards">
            {rows.map((r) => (
              <li key={r.id} data-person-card={r.id} className={`flex items-start gap-2 border border-border bg-surface-raised p-3 ${focus === r.id ? "outline outline-1 outline-amber" : ""}`}>
                {!r.leftAt && <input type="checkbox" className="mt-1" checked={selection.has(r.id)} onChange={() => selection.toggle(r.id)} aria-label={`Select ${r.name}`} />}
                <Avatar name={r.name} photoUrl={r.photoUrl} size={32} />
                <div className="min-w-0 flex-1 text-sm">
                  <Link href={`/admin/users/${r.id}`} className="font-medium hover:underline">
                    {r.name}
                  </Link>
                  <p className="truncate text-xs text-ink-muted">{r.roles.map((x) => x.name).join(" + ")}</p>
                  <p className="truncate text-xs text-ink-muted">
                    {r.department?.name ?? "No department"}
                    {r.team ? ` · ${r.team.name}` : ""}
                  </p>
                  {status(r)}
                </div>
                <RowMenu items={menu(r)} label={`Actions for ${r.name}`} />
              </li>
            ))}
          </ul>
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full bg-surface-raised text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[11px] uppercase tracking-[0.12em] text-ink-muted">
                  <th className="w-8 px-3 py-2">
                    <input type="checkbox" checked={selection.allSelected} onChange={selection.toggleAll} aria-label="Select all" />
                  </th>
                  <th className="px-3 py-2">Name</th>
                  <th className="px-3 py-2">Role</th>
                  <th className="px-3 py-2">Department · Team</th>
                  <th className="px-3 py-2">Reports to</th>
                  <th className="px-3 py-2">Joined</th>
                  <th className="px-3 py-2">Load</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="w-10 px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} id={`user-${r.id}`} data-person-row={r.id} className={`border-b border-border ${focus === r.id ? "bg-amber/10 outline outline-1 outline-amber" : ""} ${r.leftAt ? "text-ink-muted" : ""}`}>
                    <td className="px-3 py-2">{!r.leftAt && <input type="checkbox" checked={selection.has(r.id)} onChange={() => selection.toggle(r.id)} aria-label={`Select ${r.name}`} />}</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <Avatar name={r.name} photoUrl={r.photoUrl} size={28} />
                        <div className="min-w-0">
                          <Link href={`/admin/users/${r.id}`} className="font-medium hover:underline">
                            {r.name}
                          </Link>
                          <div className="text-xs text-ink-muted">{r.email ?? r.phone}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2">{r.roles.map((x) => x.name).join(" + ") || "—"}</td>
                    <td className="px-3 py-2">
                      {r.department?.name ?? "—"}
                      {r.team && <span className="text-ink-muted"> · {r.team.name}</span>}
                    </td>
                    <td className="px-3 py-2">{r.manager?.name ?? "—"}</td>
                    <td className="whitespace-nowrap px-3 py-2">{fmtDay(r.joiningDate)}</td>
                    <td className="w-24 px-3 py-2">{r.loadPct === null ? "—" : <LoadBar pct={r.loadPct} />}</td>
                    <td className="px-3 py-2">{status(r)}</td>
                    <td className="px-3 py-2">
                      <RowMenu items={menu(r)} label={`Actions for ${r.name}`} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <BulkBar count={selection.count} onClear={selection.clear} label="people">
        {can?.move && <BulkButton onClick={() => setBulk("move")}>Move</BulkButton>}
        {can?.changeRole && <BulkButton onClick={() => setBulk("add_role")}>Add role</BulkButton>}
        <BulkButton onClick={() => downloadCsv(picked, "people-selected")}>Export</BulkButton>
      </BulkBar>

      {bulk && opts && (
        <BulkDialog
          kind={bulk}
          people={picked}
          opts={opts}
          onClose={() => setBulk(null)}
          onDone={(msg, undo) => {
            notify(msg, undo);
            setBulk(null);
            selection.clear();
            reload();
          }}
        />
      )}
      <ImportWizard entity="people" open={importing} onClose={() => setImporting(false)} onDone={() => reload()} />
      {pa.dialogs}
    </>
  );
}

function BulkDialog({ kind, people, opts, onClose, onDone }: { kind: "move" | "add_role"; people: PeoplePersonRow[]; opts: PeopleOptions; onClose: () => void; onDone: (msg: string, undo: Undo) => void }) {
  const [departmentId, setDept] = useState("");
  const [teamId, setTeam] = useState("");
  const [roleId, setRole] = useState("");
  const [effectiveDate, setDate] = useState(todayIst());
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const dept = opts.departments.find((d) => d.id === departmentId);
  const roles = opts.roles.filter((r) => r.assignable);
  const who = `${people.length} ${people.length === 1 ? "person" : "people"}`;

  async function save() {
    if (reason.trim().length < 3) return setError("Give a short reason (at least 3 characters)");
    setBusy(true);
    setError(undefined);
    try {
      const userIds = people.map((p) => p.id);
      const r =
        kind === "move"
          ? await api.peopleActions.bulk({ action: "move", userIds, move: { departmentId, teamId: teamId || null, effectiveDate, reason: reason.trim(), openWork: "keep" } })
          : await api.peopleActions.bulk({ action: "add_role", userIds, roleId, effectiveDate, reason: reason.trim() });
      const failed = r.failed.length ? ` ${r.failed.length} not changed: ${r.failed.map((x) => `${x.name} (${x.error})`).join("; ")}` : "";
      onDone(`${r.message}${failed}`, r.undo);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const ready = kind === "move" ? !!departmentId && (!dept?.teams.length || !!teamId) : !!roleId;
  return (
    <ActionDialog
      open
      title={kind === "move" ? `Move ${who}` : `Add a role to ${who}`}
      onClose={onClose}
      testId="bulk-people-dialog"
      footer={
        <>
          <button type="button" className="bg-charcoal px-4 py-2 text-sm font-medium text-ivory disabled:opacity-40" disabled={!ready || busy} onClick={save}>
            {busy ? "Saving…" : kind === "move" ? "Move them" : "Add role"}
          </button>
          <button type="button" className="px-3 py-2 text-sm text-ink-muted hover:text-ink" onClick={onClose}>
            Cancel
          </button>
        </>
      }
    >
      <p className="text-xs text-ink-muted">{people.map((p) => p.name).join(", ")}</p>
      {kind === "move" ? (
        <>
          <Field label="Department" required htmlFor="bulk-dept">
            <select
              id="bulk-dept"
              className={inputCls}
              value={departmentId}
              onChange={(e) => {
                setDept(e.target.value);
                setTeam("");
              }}
            >
              <option value="">Pick the department</option>
              {opts.departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </Field>
          {!!dept?.teams.length && (
            <Field label="Team or pod" required htmlFor="bulk-team">
              <select id="bulk-team" className={inputCls} value={teamId} onChange={(e) => setTeam(e.target.value)}>
                <option value="">Pick the team</option>
                {dept.teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <p className="text-xs text-ink-muted">Open work stays with each person. Moves across departments may need an Admin&apos;s approval.</p>
        </>
      ) : (
        <Field label="Role to add" required htmlFor="bulk-role" hint="Added as a secondary role; their main role stays.">
          <select id="bulk-role" className={inputCls} value={roleId} onChange={(e) => setRole(e.target.value)}>
            <option value="">Pick a role</option>
            {roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label="Effective date" required htmlFor="bulk-date">
        <input id="bulk-date" type="date" className={inputCls} value={effectiveDate} min={todayIst()} onChange={(e) => setDate(e.target.value)} />
      </Field>
      <Field label="Reason" required htmlFor="bulk-reason">
        <input id="bulk-reason" className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      {error && <p className="border border-red bg-red/10 px-3 py-2 text-sm">{error}</p>}
    </ActionDialog>
  );
}
