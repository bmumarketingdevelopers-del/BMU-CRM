"use client";

/**
 * v51 Custom charts (Hierarchy Tree → "Custom charts"): extra org charts built from existing team members, apart from the
 * real hierarchy. People sit under people, any depth, with an optional label. Drag someone onto another person to move
 * them under that person (or use Move on a phone). Chart only: nothing here changes anyone's manager, department,
 * approvals, daily reports, alerts or access.
 */
import { useEffect, useState, type DragEvent, type ReactNode } from "react";
import { orgChartDescendants, personRoleTitle, type OrgChartList, type OrgChartMember, type OrgChartView, type PeoplePersonRow } from "@bmu/shared";
import { Avatar } from "@/components/people/person-drawer";
import { fmtDay } from "@/components/people/use-people-options";
import { Badge, Button, Card, Input, Select } from "@/components/ui";
import { api } from "@/lib/api";

const addBtn = "border border-dashed border-border px-2 py-1 text-xs text-ink-muted hover:border-ink hover:text-ink";
const linkBtn = "text-xs text-ink-muted underline hover:text-ink";

type Edit = { kind: "move" | "label"; userId: string } | null;

export function CustomCharts({ people, needle, onOpenPerson }: { people: PeoplePersonRow[]; needle: string; onOpenPerson: (id: string) => void }) {
  const [list, setList] = useState<OrgChartList>();
  const [selected, setSelected] = useState<string>();
  const [chart, setChart] = useState<OrgChartView>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [n, setN] = useState(0);

  useEffect(() => {
    let live = true;
    api.adminOrg
      .charts()
      .then((l) => {
        if (!live) return;
        setList(l);
        setSelected((s) => (s && l.charts.some((c) => c.id === s) ? s : l.charts[0]?.id));
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [n]);

  useEffect(() => {
    if (!selected) return;
    let live = true;
    api.adminOrg
      .chart(selected)
      .then((c) => live && setChart(c))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [selected]);

  /** Runs a change; a chart that comes back replaces the open one, and the list refreshes its counts. */
  async function run(fn: () => Promise<OrgChartView | { ok: true }>) {
    setBusy(true);
    setError(undefined);
    try {
      const r = await fn();
      if ("id" in r) {
        setChart(r);
        setSelected(r.id);
      }
      setN((x) => x + 1);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (!list) return error ? <p className="mb-4 border border-red bg-red/10 px-4 py-2 text-sm">{error}</p> : <p className="text-sm text-ink-muted">Loading custom charts…</p>;
  const canEdit = list.canEdit;
  const open = chart && chart.id === selected ? chart : undefined;

  return (
    <div className="mb-8 space-y-4" data-testid="custom-charts">
      <p className="border border-border bg-surface px-4 py-2 text-sm text-ink-muted">
        Custom charts are extra org charts built from your existing team, such as a campaign team or a region. They are for planning and viewing only: they never change anyone&apos;s
        manager, department, approvals, daily reports, alerts or access.
      </p>
      {error && (
        <p className="border border-red bg-red/10 px-4 py-2 text-sm" role="alert">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Custom charts">
        {list.charts.map((c) => (
          <button
            key={c.id}
            type="button"
            role="tab"
            aria-selected={c.id === selected}
            onClick={() => {
              setSelected(c.id);
              setRenaming(false);
            }}
            className={`border px-3 py-1.5 text-left text-sm ${c.id === selected ? "border-charcoal bg-charcoal text-ivory" : "border-border hover:border-ink"}`}
          >
            {c.name} <span className={c.id === selected ? "text-ivory/70" : "text-ink-muted"}>· {c.memberCount}</span>
          </button>
        ))}
        {canEdit && !creating && (
          <button type="button" className={addBtn} onClick={() => setCreating(true)}>
            + New chart
          </button>
        )}
      </div>

      {creating && (
        <NewChartForm
          busy={busy}
          onCancel={() => setCreating(false)}
          onCreate={async (input) => {
            if (await run(() => api.adminOrg.createChart(input))) setCreating(false);
          }}
        />
      )}

      {list.charts.length === 0 && !creating && (
        <Card>
          <p className="text-sm">No custom charts yet.</p>
          <p className="mt-1 text-sm text-ink-muted">
            {canEdit ? "Start one empty and add people, or copy today's reporting lines and rearrange them." : "The Founder or a Branch Manager can create one."}
          </p>
          {canEdit && (
            <Button className="mt-3" onClick={() => setCreating(true)}>
              + New chart
            </Button>
          )}
        </Card>
      )}

      {selected && !open && list.charts.length > 0 && <p className="text-sm text-ink-muted">Loading the chart…</p>}
      {open && (
        <ChartPanel
          key={open.id}
          chart={open}
          people={people}
          needle={needle}
          busy={busy}
          renaming={renaming}
          setRenaming={setRenaming}
          run={run}
          onOpenPerson={onOpenPerson}
          onDeleted={() => {
            setChart(undefined);
            setSelected(undefined);
          }}
        />
      )}
    </div>
  );
}

function NewChartForm({ busy, onCancel, onCreate }: { busy: boolean; onCancel: () => void; onCreate: (input: { name: string; description: string | null; startFrom: "empty" | "reporting" }) => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [startFrom, setStartFrom] = useState<"empty" | "reporting">("empty");
  return (
    <Card>
      <form
        className="grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          onCreate({ name, description: description.trim() || null, startFrom });
        }}
      >
        <h3 className="font-semibold">New custom chart</h3>
        <label className="grid gap-1 text-sm">
          Name
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Diwali campaign team" maxLength={80} required autoFocus />
        </label>
        <label className="grid gap-1 text-sm">
          What it is for <span className="text-xs text-ink-muted">(optional)</span>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. Who runs the October launch for Sunrise" maxLength={300} />
        </label>
        <fieldset className="grid gap-1 text-sm">
          <legend className="mb-1">Start with</legend>
          <label className="flex items-center gap-2">
            <input type="radio" name="startFrom" checked={startFrom === "empty"} onChange={() => setStartFrom("empty")} /> An empty chart (add people one by one)
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="startFrom" checked={startFrom === "reporting"} onChange={() => setStartFrom("reporting")} /> A copy of today&apos;s reporting lines (everyone), to rearrange
          </label>
        </fieldset>
        <div className="flex gap-2">
          <Button type="submit" disabled={busy || name.trim().length < 2}>
            {busy ? "Creating…" : "Create chart"}
          </Button>
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}

function ChartPanel({
  chart,
  people,
  needle,
  busy,
  renaming,
  setRenaming,
  run,
  onOpenPerson,
  onDeleted,
}: {
  chart: OrgChartView;
  people: PeoplePersonRow[];
  needle: string;
  busy: boolean;
  renaming: boolean;
  setRenaming: (v: boolean) => void;
  run: (fn: () => Promise<OrgChartView | { ok: true }>) => Promise<boolean>;
  onOpenPerson: (id: string) => void;
  onDeleted: () => void;
}) {
  const [name, setName] = useState(chart.name);
  const [description, setDescription] = useState(chart.description ?? "");
  const [addUser, setAddUser] = useState("");
  const [addUnder, setAddUnder] = useState("");
  const [addLabel, setAddLabel] = useState("");
  const [edit, setEdit] = useState<Edit>(null);
  const [editValue, setEditValue] = useState("");
  const [dragId, setDragId] = useState<string>();
  const [over, setOver] = useState<string>();
  const canEdit = chart.canEdit;

  const members = chart.members;
  const byId = new Map(members.map((m) => [m.userId, m]));
  const inChart = new Set(members.map((m) => m.userId));
  const available = people.filter((p) => !inChart.has(p.id) && p.status !== "suspended" && !p.leftAt);
  const roots = members.filter((m) => !m.parentUserId || !byId.has(m.parentUserId));
  const matches = (m: OrgChartMember) => !needle || m.name.toLowerCase().includes(needle) || m.title.toLowerCase().includes(needle) || (m.label ?? "").toLowerCase().includes(needle);

  const move = (userId: string, parentUserId: string | null) => {
    const m = byId.get(userId);
    if (!m || m.parentUserId === parentUserId || userId === parentUserId) return;
    if (parentUserId && orgChartDescendants(members, userId).has(parentUserId)) return;
    void run(() => api.adminOrg.updateChartMember(chart.id, userId, { parentUserId }));
  };

  const drop = (key: string, parentUserId: string | null) =>
    canEdit
      ? {
          onDragOver: (e: DragEvent) => {
            if (!dragId || dragId === parentUserId || (parentUserId && orgChartDescendants(members, dragId).has(parentUserId))) return;
            e.preventDefault();
            e.stopPropagation();
            if (over !== key) setOver(key);
          },
          onDragLeave: () => over === key && setOver(undefined),
          onDrop: (e: DragEvent) => {
            e.preventDefault();
            e.stopPropagation();
            const id = e.dataTransfer.getData("text/plain") || dragId;
            setOver(undefined);
            setDragId(undefined);
            if (id) move(id, parentUserId);
          },
        }
      : {};
  const ring = (key: string) => (over === key ? "outline outline-2 outline-charcoal" : "");

  const startEdit = (kind: "move" | "label", m: OrgChartMember) => {
    setEdit({ kind, userId: m.userId });
    setEditValue(kind === "move" ? (m.parentUserId ?? "") : (m.label ?? ""));
  };

  const node = (m: OrgChartMember, seen: Set<string>): ReactNode => {
    if (seen.has(m.userId)) return null;
    const next = new Set(seen).add(m.userId);
    const kids = members.filter((k) => k.parentUserId === m.userId);
    const editing = edit?.userId === m.userId ? edit.kind : null;
    const below = editing === "move" ? orgChartDescendants(members, m.userId) : new Set<string>();
    return (
      <li key={m.userId} data-chart-person={m.userId} data-name={m.name}>
        <div className={`flex flex-wrap items-center gap-2 py-1 ${ring(`p:${m.userId}`)}`} {...drop(`p:${m.userId}`, m.userId)}>
          <div
            draggable={canEdit}
            onDragStart={(e) => {
              e.dataTransfer.setData("text/plain", m.userId);
              e.dataTransfer.effectAllowed = "move";
              setDragId(m.userId);
            }}
            onDragEnd={() => {
              setDragId(undefined);
              setOver(undefined);
            }}
            className={`min-w-0 flex-1 ${needle && !matches(m) ? "opacity-30" : ""}`}
          >
            <button
              type="button"
              onClick={() => !m.former && onOpenPerson(m.userId)}
              className="flex w-full max-w-md items-center gap-2 border border-border bg-surface-raised px-2 py-1.5 text-left text-sm hover:border-ink"
            >
              <Avatar name={m.name} photoUrl={m.photoUrl} size={28} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{m.name}</span>
                <span className="block truncate text-xs text-ink-muted">
                  {m.title || "No role"}
                  {m.department ? ` · ${m.department}` : ""}
                </span>
              </span>
              <span className="flex shrink-0 flex-col items-end gap-0.5">
                {m.label && <Badge tone="dark">{m.label}</Badge>}
                {m.former && <Badge tone="red">Left</Badge>}
              </span>
            </button>
          </div>
          {canEdit && !editing && (
            <span className="flex flex-wrap gap-2">
              <button type="button" className={addBtn} aria-label={`Add someone under ${m.name}`} onClick={() => setAddUnder(m.userId)}>
                + Add under
              </button>
              <button type="button" className={linkBtn} onClick={() => startEdit("move", m)}>
                Move
              </button>
              <button type="button" className={linkBtn} onClick={() => startEdit("label", m)}>
                {m.label ? "Label" : "Add label"}
              </button>
              <button
                type="button"
                className="text-xs text-red underline"
                onClick={() => {
                  if (window.confirm(`Take ${m.name} out of "${chart.name}"?${kids.length ? ` The ${kids.length} ${kids.length === 1 ? "person" : "people"} under them move up a level.` : ""}`))
                    void run(() => api.adminOrg.removeFromChart(chart.id, m.userId));
                }}
              >
                Remove
              </button>
            </span>
          )}
          {editing && (
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={async (e) => {
                e.preventDefault();
                const ok = await run(() =>
                  api.adminOrg.updateChartMember(chart.id, m.userId, editing === "move" ? { parentUserId: editValue || null } : { label: editValue.trim() || null }),
                );
                if (ok) setEdit(null);
              }}
            >
              {editing === "move" ? (
                <Select value={editValue} onChange={(e) => setEditValue(e.target.value)} aria-label={`Move ${m.name} under`} className="!py-1 text-sm">
                  <option value="">Top of the chart</option>
                  {members
                    .filter((o) => o.userId !== m.userId && !below.has(o.userId))
                    .map((o) => (
                      <option key={o.userId} value={o.userId}>
                        Under {o.name}
                      </option>
                    ))}
                </Select>
              ) : (
                <Input value={editValue} onChange={(e) => setEditValue(e.target.value)} maxLength={60} placeholder="e.g. Campaign lead" aria-label={`Label for ${m.name}`} className="!py-1 text-sm" autoFocus />
              )}
              <Button type="submit" variant="secondary" className="!px-3 !py-1 text-xs" disabled={busy}>
                Save
              </Button>
              <button type="button" className={linkBtn} onClick={() => setEdit(null)}>
                Cancel
              </button>
            </form>
          )}
        </div>
        {kids.length > 0 && <ul className="ml-3 border-l border-border pl-2 sm:ml-6 sm:pl-3">{kids.map((k) => node(k, next))}</ul>}
      </li>
    );
  };

  return (
    <Card className="min-w-0">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        {renaming ? (
          <form
            className="grid w-full max-w-lg gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              if (await run(() => api.adminOrg.updateChart(chart.id, { name, description: description.trim() || null }))) setRenaming(false);
            }}
          >
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} aria-label="Chart name" required />
            <Input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} placeholder="What it is for (optional)" aria-label="What it is for" />
            <div className="flex gap-2">
              <Button type="submit" variant="secondary" className="!py-1.5 text-sm" disabled={busy || name.trim().length < 2}>
                Save
              </Button>
              <Button type="button" variant="ghost" className="!py-1.5 text-sm" onClick={() => setRenaming(false)}>
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <div className="min-w-0">
            <h2 className="font-semibold">{chart.name}</h2>
            {chart.description && <p className="text-sm text-ink-muted">{chart.description}</p>}
            <p className="text-xs text-ink-muted">
              {members.length} {members.length === 1 ? "person" : "people"} · updated {fmtDay(chart.updatedAt)}
              {chart.createdBy ? ` · made by ${chart.createdBy}` : ""}
            </p>
          </div>
        )}
        {canEdit && !renaming && (
          <div className="flex gap-3">
            <button type="button" className={linkBtn} onClick={() => setRenaming(true)}>
              Rename
            </button>
            <button
              type="button"
              className="text-xs text-red underline"
              onClick={async () => {
                if (window.confirm(`Delete the chart "${chart.name}"? Nobody's real manager or department changes.`) && (await run(() => api.adminOrg.deleteChart(chart.id)))) onDeleted();
              }}
            >
              Delete chart
            </button>
          </div>
        )}
      </div>

      {canEdit && (
        <form
          className="mb-4 grid gap-2 border border-border bg-surface p-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,2fr)_minmax(0,1.5fr)_auto] sm:items-end"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!addUser) return;
            const ok = await run(() => api.adminOrg.addToChart(chart.id, { userId: addUser, parentUserId: addUnder || null, label: addLabel.trim() || null }));
            if (ok) {
              setAddUser("");
              setAddLabel("");
            }
          }}
        >
          <label className="grid min-w-0 gap-1 text-xs text-ink-muted">
            Add a team member
            <Select value={addUser} onChange={(e) => setAddUser(e.target.value)} aria-label="Team member to add" className="text-sm">
              <option value="">{available.length ? "Pick a person…" : "Everyone is already in this chart"}</option>
              {available.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {personRoleTitle(p.roles, { specialty: p.specialty, department: p.department?.name }) || "No role"}
                </option>
              ))}
            </Select>
          </label>
          <label className="grid min-w-0 gap-1 text-xs text-ink-muted">
            Under
            <Select value={addUnder} onChange={(e) => setAddUnder(e.target.value)} aria-label="Put them under" className="text-sm">
              <option value="">Top of the chart</option>
              {members.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name}
                </option>
              ))}
            </Select>
          </label>
          <label className="grid min-w-0 gap-1 text-xs text-ink-muted">
            Label (optional)
            <Input value={addLabel} onChange={(e) => setAddLabel(e.target.value)} maxLength={60} placeholder="e.g. Campaign lead" className="text-sm" />
          </label>
          <Button type="submit" disabled={busy || !addUser}>
            Add
          </Button>
        </form>
      )}

      {members.length === 0 ? (
        <p className="text-sm text-ink-muted">{canEdit ? "No one in this chart yet. Add the person at the top first, then the people under them." : "No one in this chart yet."}</p>
      ) : (
        <>
          {canEdit && (
            <p className={`mb-2 border border-dashed border-border px-3 py-2 text-xs text-ink-muted ${ring("top")}`} {...drop("top", null)}>
              Drag someone onto another person to put them under that person, or drop them here to move them to the top.
            </p>
          )}
          <ul data-testid="chart-tree">{roots.map((r) => node(r, new Set()))}</ul>
        </>
      )}
    </Card>
  );
}
