"use client";

import { use, useState } from "react";
import Link from "next/link";
import { TEAM_PROCESS_GROUPS, TEAM_PROCESS_GROUP_LABELS, type TeamPeopleOptions, type TeamPeopleProcess, type TeamProcessItem } from "@bmu/shared";
import { PeopleChecklist } from "@/components/people-checklist";
import { ActivityFeed } from "@/components/activity-feed";
import { Empty, Panel } from "@/components/dash";
import { Button, Input, LoadState, PageTitle, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" }) : "no deadline");

/** One onboarding or offboarding checklist, with bulk handover of a leaver's work. */
export default function PeopleProcessPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const loaded = useLoad(() => api.teamFlows.people.get(id));
  const options = useLoad(() => api.teamFlows.people.options());
  const [fresh, setFresh] = useState<TeamPeopleProcess>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const p = fresh ?? loaded.data;

  async function run(fn: () => Promise<TeamPeopleProcess>, ok?: string) {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      setFresh(await fn());
      if (ok) setNotice(ok);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!p) {
    return (
      <>
        <Link href="/admin/people" className="text-sm text-ink-muted hover:text-ink">
          ← Onboarding & Offboarding
        </Link>
        <div className="mt-6">
          <LoadState loading={loaded.loading} error={loaded.error} />
        </div>
      </>
    );
  }

  const tick = (i: TeamProcessItem, done: boolean) => run(() => api.teamFlows.people.tick(p.id, i.key, done));

  return (
    <div className="[&_.grid>*]:min-w-0">
      <Link href="/admin/people" className="text-sm text-ink-muted hover:text-ink">
        ← Onboarding & Offboarding
      </Link>
      <PageTitle
        title={`${p.kind === "onboarding" ? "Onboarding" : "Offboarding"}: ${p.user.name}`}
        subtitle={[p.user.role, p.user.department, p.user.email, p.startedBy ? `started by ${p.startedBy}` : null].filter(Boolean).join(" · ")}
        action={
          p.canEdit ? (
            <div className="flex gap-2">
              {p.kind === "onboarding" ? (
                <Button disabled={busy} onClick={() => run(() => api.teamFlows.people.complete(p.id), "Onboarding complete. The new hire has been told.")}>
                  Mark complete
                </Button>
              ) : (
                // v11 people: offboarding ends with the final confirmation (blocked while they own open work; a Branch Manager confirms).
                <Button
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      const r = await api.peopleActions.confirmOffboarding(p.user.id);
                      setNotice(r.message);
                      return api.teamFlows.people.get(p.id);
                    })
                  }
                >
                  Final confirmation
                </Button>
              )}
              <Button variant="ghost" disabled={busy} onClick={() => window.confirm("Cancel this checklist?") && run(() => api.teamFlows.people.cancel(p.id))}>
                Cancel
              </Button>
            </div>
          ) : undefined
        }
      />
      {error && <p className="mb-4 border border-red bg-red/10 px-4 py-2 text-sm">{error}</p>}
      {notice && <p className="mb-4 border border-green bg-green/10 px-4 py-2 text-sm">{notice}</p>}
      {p.kind === "offboarding" && p.user.status === "suspended" && <p className="mb-4 border border-border bg-canvas px-4 py-2 text-sm">BMU Hub access was suspended{p.suspendedAt ? ` on ${fmt(p.suspendedAt)}` : ""}. They can no longer sign in.</p>}

      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        <div className="grid gap-6">
          {p.kind === "offboarding" && p.openWork && p.canEdit && <Handover process={p} staff={options.data?.staff ?? []} busy={busy} onMove={(kind, ids, to) => run(() => api.teamFlows.people.reassign(p.id, { kind, ids, toUserId: to }), `Moved ${ids.length} ${kind}.`)} />}
          {p.kind === "offboarding" && p.openWork && !p.canEdit && (
            <Panel title="Work still owned">
              <p className="text-sm">
                {p.openWork.tasks.length} tasks · {p.openWork.clients.length} clients · {p.openWork.leads.length} leads
              </p>
            </Panel>
          )}
          <PeopleChecklist process={p} onTick={p.canEdit ? tick : undefined} busy={busy} />
          {p.canEdit && <AddItem busy={busy} onAdd={(label, group) => run(() => api.teamFlows.people.addItem(p.id, label, group))} />}
        </div>
        <ActivityFeed entity="User" id={p.user.id} title="History" subtitle="Everything recorded for this person" />
      </div>
    </div>
  );
}

function AddItem({ busy, onAdd }: { busy: boolean; onAdd: (label: string, group: string) => void }) {
  const [label, setLabel] = useState("");
  const [group, setGroup] = useState<string>("documents");
  return (
    <form
      className="flex flex-wrap gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (label.trim().length < 2) return;
        onAdd(label.trim(), group);
        setLabel("");
      }}
    >
      <Input className="min-w-[200px] flex-1" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Add a checklist item" aria-label="New checklist item" />
      <Select value={group} onChange={(e) => setGroup(e.target.value)} aria-label="Group">
        {TEAM_PROCESS_GROUPS.filter((g) => g !== "induction").map((g) => (
          <option key={g} value={g}>
            {TEAM_PROCESS_GROUP_LABELS[g]}
          </option>
        ))}
      </Select>
      <Button type="submit" variant="secondary" disabled={busy}>
        Add item
      </Button>
    </form>
  );
}

type Kind = "tasks" | "clients" | "leads";

/** Bulk reassign with a picker: tick rows, choose the new owner, move. */
function Handover({ process, staff, busy, onMove }: { process: TeamPeopleProcess; staff: TeamPeopleOptions["staff"]; busy: boolean; onMove: (kind: Kind, ids: string[], to: string) => void }) {
  const work = process.openWork!;
  const sections: { kind: Kind; title: string; rows: { id: string; label: string; sub: string }[]; who: (s: TeamPeopleOptions["staff"][number]) => boolean }[] = [
    { kind: "tasks", title: "Open tasks", rows: work.tasks.map((t) => ({ id: t.id, label: t.title, sub: [t.client, `due ${fmt(t.deadline)}`].filter(Boolean).join(" · ") })), who: () => true },
    { kind: "clients", title: "Clients (client manager)", rows: work.clients.map((c) => ({ id: c.id, label: c.name, sub: "All their open services move too" })), who: (s) => s.roles.some((r) => ["account_manager", "am_lead", "admin", "founder"].includes(r)) },
    { kind: "leads", title: "Open leads", rows: work.leads.map((l) => ({ id: l.id, label: l.name, sub: l.stage.replace("_", " ") })), who: (s) => s.roles.some((r) => ["sales_executive", "sales_manager", "founder", "admin", "account_manager", "am_lead"].includes(r)) },
  ];
  return (
    <Panel title="Hand over work" subtitle="Tick what to move, pick the new owner, then move. The checklist ticks itself when nothing is left.">
      <div className="grid gap-6">
        {sections.map((s) => (
          <HandoverSection key={s.kind} {...s} staff={staff.filter((u) => u.id !== process.user.id && s.who(u))} busy={busy} onMove={(ids, to) => onMove(s.kind, ids, to)} />
        ))}
      </div>
    </Panel>
  );
}

function HandoverSection({ title, rows, staff, busy, onMove }: { title: string; rows: { id: string; label: string; sub: string }[]; staff: TeamPeopleOptions["staff"]; busy: boolean; onMove: (ids: string[], to: string) => void }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [to, setTo] = useState("");
  const live = picked.filter((id) => rows.some((r) => r.id === id));
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">
          {title} <span className="font-normal text-ink-muted">({rows.length})</span>
        </h3>
        {rows.length > 0 && (
          <label className="flex items-center gap-2 text-xs text-ink-muted">
            <input type="checkbox" checked={live.length === rows.length} onChange={(e) => setPicked(e.target.checked ? rows.map((r) => r.id) : [])} /> Select all
          </label>
        )}
      </div>
      {rows.length === 0 ? (
        <Empty>Nothing left to hand over.</Empty>
      ) : (
        <>
          <ul className="max-h-64 divide-y divide-border overflow-y-auto border border-border">
            {rows.map((r) => (
              <li key={r.id}>
                <label className="flex items-start gap-3 px-3 py-2 text-sm">
                  <input type="checkbox" className="mt-0.5" checked={live.includes(r.id)} onChange={(e) => setPicked(e.target.checked ? [...live, r.id] : live.filter((x) => x !== r.id))} />
                  <span className="min-w-0">
                    <span className="block truncate">{r.label}</span>
                    <span className="block text-xs text-ink-muted">{r.sub}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <div className="mt-2 flex flex-wrap gap-2">
            <Select value={to} onChange={(e) => setTo(e.target.value)} aria-label={`New owner for ${title}`}>
              <option value="">Move to…</option>
              {staff.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                  {u.department ? ` · ${u.department}` : ""}
                </option>
              ))}
            </Select>
            <Button
              variant="secondary"
              disabled={busy || !live.length || !to}
              onClick={() => {
                onMove(live, to);
                setPicked([]);
              }}
            >
              Move {live.length || ""} selected
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
