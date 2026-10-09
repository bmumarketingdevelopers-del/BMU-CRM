"use client";

/**
 * Hierarchy Tree: Organisation → Branch → Department → Team → Person, plus reporting lines and client pods.
 * Every node has "+ Add person" (pre-filled with that node) and "+ Add team". Drag a person onto a department, team or
 * manager to move them (opens the Move dialog with the preview). Click a person for the profile drawer with Reassign
 * work, Change role, Move and Offboard. On a phone, use Move in the drawer instead of dragging.
 */
import { useEffect, useMemo, useState, useSyncExternalStore, type DragEvent, type ReactNode } from "react";
import type { PeoplePersonRow, PeopleTree } from "@bmu/shared";
import { useActions } from "@/components/actions/actions-provider";
import { LoadBar } from "@/components/actions/person-picker";
import { Avatar, PersonDrawer } from "@/components/people/person-drawer";
import { usePersonActions, type PersonLite } from "@/components/people/person-actions";
import { fmtDay } from "@/components/people/use-people-options";
import { Badge, Card, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";

type View = "departments" | "reporting";
type Prefs = { view: View; load: boolean; leave: boolean };
type Target = { departmentId?: string; teamId?: string | null; managerId?: string | null };
const PREF = "people.tree.prefs";
const DEFAULT_PREFS: Prefs = { view: "departments", load: true, leave: true };
const addBtn = "border border-dashed border-border px-2 py-1 text-xs text-ink-muted hover:border-ink hover:text-ink";

function readPrefs(): Prefs {
  try {
    const raw = window.localStorage.getItem(PREF);
    if (raw) return { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<Prefs>) };
  } catch {
    /* storage unavailable */
  }
  return DEFAULT_PREFS;
}

let prefsCache: Prefs | undefined;
const prefsListeners = new Set<() => void>();
function readPrefsCached() {
  return (prefsCache ??= readPrefs());
}
function subscribePrefs(fn: () => void) {
  prefsListeners.add(fn);
  return () => prefsListeners.delete(fn);
}
function writePrefs(p: Prefs) {
  prefsCache = p;
  try {
    window.localStorage.setItem(PREF, JSON.stringify(p));
  } catch {
    /* storage unavailable */
  }
  prefsListeners.forEach((fn) => fn());
}

export default function HierarchyPage() {
  const { openNew, version, changed } = useActions();
  const [tree, setTree] = useState<PeopleTree>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [n, setN] = useState(0);
  // Saved view and toggles live in this browser only (the server render uses the defaults).
  const prefs = useSyncExternalStore(subscribePrefs, readPrefsCached, () => DEFAULT_PREFS);
  const [q, setQ] = useState("");
  const [openId, setOpenId] = useState<string>();
  const [dragId, setDragId] = useState<string>();
  const [over, setOver] = useState<string>();
  const reload = () => {
    setN((x) => x + 1);
    changed();
  };
  const pa = usePersonActions(reload);

  const savePrefs = writePrefs;

  useEffect(() => {
    let live = true;
    api.peopleActions
      .tree()
      .then((t) => {
        if (!live) return;
        setTree(t);
        setError(undefined);
      })
      .catch((e: Error) => live && setError(e.message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [version, n]);

  const byId = useMemo(() => new Map((tree?.people ?? []).map((p) => [p.id, p])), [tree]);
  const needle = q.trim().toLowerCase();
  const matches = (p: PeoplePersonRow) => !needle || p.name.toLowerCase().includes(needle) || p.roles.some((r) => r.name.toLowerCase().includes(needle));
  const can = tree?.can;

  const addPerson = (prefill: Record<string, string>) => openNew("person", prefill, () => reload());
  const addTeam = (prefill: Record<string, string>) => openNew("team", prefill, () => reload());

  async function removePod(id: string, name: string) {
    if (!window.confirm(`Remove the pod "${name}"? Tasks already assigned stay as they are.`)) return;
    try {
      await api.peopleActions.removePod(id);
      reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // Drag and drop (desktop). Drop zones carry data-drop with their key.
  const dropProps = (key: string, target: Target) =>
    can?.move
      ? {
          "data-drop": key,
          onDragOver: (e: DragEvent) => {
            if (!dragId) return;
            e.preventDefault();
            e.stopPropagation();
            if (over !== key) setOver(key);
          },
          onDrop: (e: DragEvent) => {
            e.preventDefault();
            e.stopPropagation();
            const id = e.dataTransfer.getData("text/plain") || dragId;
            setOver(undefined);
            setDragId(undefined);
            const p = id ? byId.get(id) : undefined;
            if (!p || p.id === target.managerId) return;
            pa.open("move", p as PersonLite, target);
          },
        }
      : {};
  const ring = (key: string) => (over === key ? "outline outline-2 outline-charcoal" : "");

  const chip = (p: PeoplePersonRow, note?: string) => {
    const dim = needle && !matches(p);
    return (
      <li
        key={p.id}
        data-person-node={p.id}
        data-name={p.name}
        draggable={!!can?.move && !p.roles.some((r) => r.baseRole === "founder")}
        onDragStart={(e) => {
          e.dataTransfer.setData("text/plain", p.id);
          e.dataTransfer.effectAllowed = "move";
          setDragId(p.id);
        }}
        onDragEnd={() => {
          setDragId(undefined);
          setOver(undefined);
        }}
        className={dim ? "opacity-30" : ""}
      >
        <button type="button" onClick={() => setOpenId(p.id)} className="flex w-full items-center gap-2 border border-border bg-surface-raised px-2 py-1.5 text-left text-sm hover:border-ink">
          <Avatar name={p.name} photoUrl={p.photoUrl} size={28} />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">{p.name}</span>
            <span className="block truncate text-xs text-ink-muted">
              {p.roles.map((r) => r.name).join(" + ") || "No role"}
              {note}
            </span>
          </span>
          <span className="flex shrink-0 flex-col items-end gap-0.5">
            {p.status === "invited" && <Badge tone="amber">Invited</Badge>}
            {p.status === "suspended" && <Badge tone="red">Suspended</Badge>}
            {prefs.leave && p.onLeaveToday && <Badge tone="amber">On leave</Badge>}
            {prefs.leave && !p.onLeaveToday && p.nextLeave && <span className="text-[10px] text-ink-muted">Leave {fmtDay(p.nextLeave)}</span>}
            {p.pending.scheduled + p.pending.approvals > 0 && <span className="text-[10px] text-ink-muted">Change pending</span>}
            {prefs.load && p.loadPct !== null && (
              <span className="w-16">
                <LoadBar pct={p.loadPct} />
              </span>
            )}
          </span>
        </button>
      </li>
    );
  };

  const people = (ids: string[]) => ids.map((id) => byId.get(id)).filter((p): p is PeoplePersonRow => !!p);

  // Reporting lines: walk the manager graph (guarded against loops).
  const reporting = (rows: PeoplePersonRow[]) => {
    const ids = new Set(rows.map((u) => u.id));
    const roots = rows.filter((u) => !u.manager || !ids.has(u.manager.id));
    const walk = (p: PeoplePersonRow, seen: Set<string>): ReactNode => {
      if (seen.has(p.id)) return null;
      const next = new Set(seen).add(p.id);
      const kids = rows.filter((u) => u.manager?.id === p.id);
      return (
        <li key={p.id}>
          <div className={`flex items-center gap-2 py-1 ${ring(`m:${p.id}`)}`} data-node={`person:${p.id}`} {...dropProps(`m:${p.id}`, { departmentId: p.department?.id, managerId: p.id, teamId: p.team?.id ?? null })}>
            <ul className="min-w-0 flex-1">{chip(p, p.department ? ` · ${p.department.name}` : "")}</ul>
            {can?.addPerson && (
              <button type="button" className={addBtn} aria-label={`Add a person reporting to ${p.name}`} onClick={() => addPerson({ managerId: p.id, ...(p.department ? { departmentId: p.department.id } : {}), ...(p.team ? { teamId: p.team.id } : {}), ...(p.branch ? { branchId: p.branch.id } : {}) })}>
                + Add
              </button>
            )}
          </div>
          {kids.length > 0 && <ul className="ml-3 border-l border-border pl-2 sm:ml-6 sm:pl-3">{kids.map((k) => walk(k, next))}</ul>}
        </li>
      );
    };
    return <ul>{roots.map((r) => walk(r, new Set()))}</ul>;
  };

  return (
    <>
      <PageTitle
        title="Hierarchy Tree"
        subtitle="Branch → Department → Team → Person. Drag someone to move them, or click them for actions."
        action={
          can?.addPerson ? (
            <button type="button" className="bg-charcoal px-4 py-2 text-sm font-medium text-ivory" onClick={() => addPerson({})}>
              + Add person
            </button>
          ) : undefined
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex border border-border" role="tablist" aria-label="View">
          {(["departments", "reporting"] as View[]).map((v) => (
            <button key={v} type="button" role="tab" aria-selected={prefs.view === v} onClick={() => savePrefs({ ...prefs, view: v })} className={`px-3 py-1.5 text-sm ${prefs.view === v ? "bg-charcoal text-ivory" : ""}`}>
              {v === "departments" ? "By department" : "Reporting lines"}
            </button>
          ))}
        </div>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a person or role" aria-label="Find a person or role" className="min-w-0 flex-1 border border-border bg-surface-raised px-3 py-1.5 text-sm sm:max-w-xs" />
        <label className="flex items-center gap-1.5 text-sm">
          <input type="checkbox" checked={prefs.load} onChange={(e) => savePrefs({ ...prefs, load: e.target.checked })} /> Load %
        </label>
        <label className="flex items-center gap-1.5 text-sm">
          <input type="checkbox" checked={prefs.leave} onChange={(e) => savePrefs({ ...prefs, leave: e.target.checked })} /> Leave
        </label>
      </div>

      {loading && !tree && !error && <p className="text-sm text-ink-muted">Loading the hierarchy…</p>}
      {error && (
        <p className="mb-4 border border-red bg-red/10 px-4 py-2 text-sm" role="alert">
          {error}{" "}
          <button type="button" className="underline" onClick={() => setN((x) => x + 1)}>
            Try again
          </button>
        </p>
      )}

      {tree && tree.people.length === 0 && (
        <Card>
          <p className="text-sm">No one is in the hierarchy yet.</p>
          {can?.addPerson && (
            <button type="button" className="mt-3 bg-charcoal px-4 py-2 text-sm font-medium text-ivory" onClick={() => addPerson({})}>
              + Add the first person
            </button>
          )}
        </Card>
      )}

      {tree && prefs.view === "departments" && (
        <>
          {tree.branches.map((b, bi) => {
            const unplaced = people(tree.unplacedIds).filter((p) => p.branch?.id === b.id || (!p.branch && bi === 0));
            return (
              <section key={b.id} className="mb-8" data-node={`branch:${b.id}`}>
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <h2 className="font-semibold">
                    {b.name} <span className="font-normal text-ink-muted">· {b.city}</span>
                  </h2>
                  {b.workStart && b.workEnd && (
                    <span className="text-xs text-ink-muted">
                      Hours {b.workStart}–{b.workEnd}
                    </span>
                  )}
                  {can?.addUnit && (
                    <button type="button" className={addBtn} onClick={() => addTeam({ kind: "department", branchId: b.id })}>
                      + Add department
                    </button>
                  )}
                </div>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {b.departments.map((d) => {
                    const teamed = new Set(d.teams.flatMap((t) => t.memberIds));
                    const loose = people(d.memberIds.filter((id) => !teamed.has(id)));
                    return (
                      <div key={d.id} data-node={`department:${d.id}`} data-name={d.name} className={`min-w-0 border border-border bg-surface p-3 ${ring(`d:${d.id}`)}`} {...dropProps(`d:${d.id}`, { departmentId: d.id, teamId: null })}>
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div className="min-w-0">
                            <h3 className="font-semibold">{d.name}</h3>
                            <p className="text-xs text-ink-muted">
                              Head: {d.head?.name ?? "None"} · {d.memberIds.length} {d.memberIds.length === 1 ? "person" : "people"}
                            </p>
                          </div>
                          <div className="flex flex-wrap gap-1">
                            {can?.addPerson && (
                              <button type="button" className={addBtn} data-add-person={d.id} onClick={() => addPerson({ departmentId: d.id, branchId: b.id, ...(d.head ? { managerId: d.head.id } : {}) })}>
                                + Add person
                              </button>
                            )}
                            {can?.addUnit && (
                              <button type="button" className={addBtn} data-add-team={d.id} onClick={() => addTeam({ kind: "team", departmentId: d.id })}>
                                + Add team
                              </button>
                            )}
                          </div>
                        </div>
                        {d.teams.map((t) => (
                          <div key={t.id} data-node={`team:${t.id}`} data-name={t.name} className={`mt-3 border-l-2 border-border pl-2 ${ring(`t:${t.id}`)}`} {...dropProps(`t:${t.id}`, { departmentId: d.id, teamId: t.id })}>
                            <div className="mb-1 flex flex-wrap items-center justify-between gap-1">
                              <p className="text-xs font-semibold uppercase tracking-wide">
                                {t.name} <span className="font-normal normal-case text-ink-muted">· lead {t.lead?.name ?? "none"}</span>
                              </p>
                              {can?.addPerson && (
                                <button type="button" className={addBtn} data-add-person={t.id} onClick={() => addPerson({ departmentId: d.id, teamId: t.id, branchId: b.id, ...(t.lead ? { managerId: t.lead.id } : {}) })}>
                                  + Add person
                                </button>
                              )}
                            </div>
                            <ul className="grid grid-cols-1 gap-1">
                              {people(t.memberIds).map((p) => chip(p))}
                              {t.memberIds.length === 0 && <li className="text-xs text-ink-muted">No one in this team yet.</li>}
                            </ul>
                          </div>
                        ))}
                        {(loose.length > 0 || d.teams.length === 0) && (
                          <div className="mt-3">
                            {d.teams.length > 0 && <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-muted">Not in a team</p>}
                            <ul className="grid grid-cols-1 gap-1">
                              {loose.map((p) => chip(p))}
                              {loose.length === 0 && <li className="text-xs text-ink-muted">No one here yet.</li>}
                            </ul>
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {b.departments.length === 0 && <p className="text-sm text-ink-muted">No departments in this branch yet.</p>}
                </div>
                {unplaced.length > 0 && (
                  <div className="mt-3">
                    <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-muted">Leadership and people without a department</p>
                    <ul className="grid grid-cols-1 gap-1 sm:grid-cols-2 xl:grid-cols-3">{unplaced.map((p) => chip(p))}</ul>
                  </div>
                )}
              </section>
            );
          })}
          {can?.addUnit && (
            <p className="mb-8">
              <button type="button" className={addBtn} onClick={() => addTeam({ kind: "branch" })}>
                + Add branch
              </button>
            </p>
          )}
        </>
      )}

      {tree && prefs.view === "reporting" && tree.people.length > 0 && <Card className="mb-8">{reporting(tree.people)}</Card>}

      {tree && (tree.pods.length > 0 || can?.addPod) && (
        <section className="mb-8" data-node="pods">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <h2 className="font-semibold">Client pods</h2>
            <span className="text-xs text-ink-muted">New tasks for a pod&apos;s clients go to pod members by default.</span>
            {can?.addPod && (
              <button type="button" className={addBtn} onClick={() => addTeam({ kind: "pod" })}>
                + Add pod
              </button>
            )}
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {tree.pods.map((pod) => (
              <div key={pod.id} className="min-w-0 border border-border bg-surface p-3 text-sm" data-node={`pod:${pod.id}`} data-name={pod.name}>
                <div className="flex items-start justify-between gap-2">
                  <h3 className="font-semibold">{pod.name}</h3>
                  {can?.addPod && (
                    <button type="button" className="text-xs text-red underline" onClick={() => removePod(pod.id, pod.name)}>
                      Remove
                    </button>
                  )}
                </div>
                <p className="text-xs text-ink-muted">
                  AM {pod.am?.name ?? "—"} · Strategist {pod.strategist?.name ?? "—"}
                </p>
                <p className="mt-1">Producers: {pod.producers.map((x) => x.name).join(", ") || "None"}</p>
                <p className="text-xs text-ink-muted">Clients: {pod.clients.map((x) => x.name).join(", ") || "None"}</p>
              </div>
            ))}
            {tree.pods.length === 0 && <p className="text-sm text-ink-muted">No client pods yet.</p>}
          </div>
        </section>
      )}

      {tree && tree.former.length > 0 && (
        <details className="mb-8" data-testid="former-list">
          <summary className="cursor-pointer font-semibold">Former ({tree.former.length})</summary>
          <ul className="mt-2 grid gap-1 sm:grid-cols-2 xl:grid-cols-3">
            {tree.former.map((p) => (
              <li key={p.id}>
                <button type="button" onClick={() => setOpenId(p.id)} className="flex w-full items-center gap-2 border border-border px-2 py-1.5 text-left text-sm text-ink-muted hover:border-ink">
                  <Avatar name={p.name} photoUrl={p.photoUrl} size={24} />
                  <span className="flex-1 truncate">{p.name}</span>
                  <span className="text-xs">Left {fmtDay(p.leftAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}

      {openId && (
        <PersonDrawer
          id={openId}
          version={version}
          onClose={() => setOpenId(undefined)}
          onAction={(k, p) => {
            setOpenId(undefined);
            pa.open(k, p);
          }}
        />
      )}
      {pa.dialogs}
    </>
  );
}
