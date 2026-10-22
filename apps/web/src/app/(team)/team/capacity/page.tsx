"use client";

import Link from "next/link";
import { useState } from "react";
import { coreCanManageTasks, type TeamCapacityPerson, type TeamCapacityView } from "@bmu/shared";
import { BarList, DataTable, Meter, Panel, StatRow, StatTile } from "@/components/dash";
import { fmtDay, fmtIsoDay } from "@/components/workspace/format";
import { Badge, LoadState, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { useActionsMaybe } from "@/components/actions/actions-provider";

const tone = (pct: number) => (pct > 100 ? "bad" : pct >= 80 ? "warn" : "default") as "bad" | "warn" | "default";

export default function CapacityPage() {
  const loaded = useLoad(() => api.workspace.capacity());
  const c = loaded.data;
  if (!c)
    return (
      <div className="[&_.grid>*]:min-w-0">
        <PageTitle title="Capacity" subtitle="Who has room this week, and who is overloaded." />
        <LoadState loading={loaded.loading} error={loaded.error} />
      </div>
    );
  const others = c.people;
  const over = c.people.filter((p) => p.loadPct > 100).length;
  const overdue = c.people.reduce((s, p) => s + p.overdue, 0);

  return (
    <div className="[&_.grid>*]:min-w-0">
      <PageTitle
        title="Capacity"
        subtitle={`Workload for ${c.scopeLabel.toLowerCase() === "everyone" ? "the whole team" : c.scopeLabel} this week (${fmtIsoDay(c.week.from)} – ${fmtIsoDay(c.week.to)}).`}
      />

      <Panel title="Your load" subtitle="Everyone sees their own card" flush>
        <div className="grid gap-px bg-border sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr_1fr]">
          <div className="bg-surface-raised p-5">
            <p className="text-[13px] text-ink-muted">This week</p>
            <p className="mt-2 text-[28px] leading-none font-semibold tracking-tight tabular-nums">{c.me.loadPct}%</p>
            <div className="mt-3">
              <Meter value={c.me.loadPct} tone={tone(c.me.loadPct)} label="Your load this week" />
            </div>
            <p className="mt-2 text-xs text-ink-muted">{c.me.loadPct > 100 ? "More than a week of work is due. Talk to your lead." : c.me.loadPct >= 80 ? "Nearly full." : "You have room."}</p>
          </div>
          <StatTile label="Open tasks" value={c.me.open} href="/team/tasks" />
          <StatTile label="Due this week" value={c.me.dueThisWeek} tone={c.me.dueThisWeek ? "warn" : "default"} />
          <StatTile label="Overdue" value={c.me.overdue} tone={c.me.overdue ? "bad" : "default"} />
        </div>
      </Panel>

      {c.people.length > 1 && (
        <div className="[&_.grid>*]:min-w-0">
          <div className="mt-8">
            <StatRow cols={4}>
              <StatTile label="People" value={c.people.length} hint={c.scopeLabel} />
              <StatTile label="Over capacity" value={over} tone={over ? "bad" : "default"} />
              <StatTile label="Overdue tasks" value={overdue} tone={overdue ? "bad" : "default"} />
              <StatTile label="Unassigned tasks" value={c.unassigned.length} tone={c.unassigned.length ? "warn" : "default"} />
            </StatRow>
          </div>
          <div className="mt-6 grid gap-6 lg:grid-cols-[2fr_1fr]">
            <Panel title="Team load" subtitle={c.hoursPerTask ? `Load = tasks due this week or overdue × ${c.hoursPerTask}h ÷ ${c.weekHours}h a week` : "Load = the hours Department Heads gave the tasks due this week or overdue ÷ each person's weekly hours"} flush>
              <DataTable<TeamCapacityPerson>
                rows={others}
                rowKey={(p) => p.id}
                columns={[
                  {
                    key: "n",
                    header: "Person",
                    cell: (p) => (
                      <span className="block min-w-32">
                        <span className="font-medium">{p.name}</span>
                        {p.id === c.me.id && <span className="text-ink-muted"> (you)</span>}
                        <span className="block text-xs text-ink-muted">
                          {p.department ?? "No department"}
                          {p.onLeave && " · on leave today"}
                        </span>
                      </span>
                    ),
                  },
                  { key: "o", header: "Open", align: "right", cell: (p) => p.open },
                  { key: "w", header: "This week", align: "right", cell: (p) => p.dueThisWeek },
                  { key: "d", header: "Overdue", align: "right", cell: (p) => <span className={p.overdue ? "font-medium text-red" : ""}>{p.overdue}</span> },
                  { key: "l", header: "Load", cell: (p) => <div className="min-w-32"><Meter value={p.loadPct} tone={tone(p.loadPct)} /></div> },
                ]}
              />
            </Panel>
            <Panel title="Open tasks by person" subtitle="Top 10">
              <BarList items={[...others].filter((p) => p.open > 0).sort((a, b) => b.open - a.open).slice(0, 10).map((p) => ({ label: p.name, value: p.open, note: p.overdue ? `${p.overdue} late` : undefined }))} />
            </Panel>
          </div>
        </div>
      )}

      <AssignByDrag c={c} onDone={loaded.reload} />

      <Panel title="Unassigned tasks" subtitle={c.scope === "all" ? "Across the agency" : "In your department"} className="mt-6" flush>
        <DataTable
          rows={c.unassigned}
          rowKey={(t) => t.id}
          rowHref={(t) => t.href ?? undefined}
          empty="Every open task has an owner."
          columns={[
            { key: "t", header: "Task", cell: (t) => t.title },
            { key: "c", header: "Client", cell: (t) => t.client ?? "—" },
            { key: "d", header: "Department", cell: (t) => (t.department ? <Badge>{t.department}</Badge> : "—") },
            { key: "due", header: "Deadline", align: "right", cell: (t) => (t.deadline ? <span className={new Date(t.deadline) < new Date() ? "text-red" : ""}>{fmtDay.format(new Date(t.deadline))}</span> : "—") },
          ]}
        />
        {c.unassigned.length > 0 && (
          <p className="border-t border-border px-5 py-3 text-xs text-ink-muted">
            Leads can assign these from the <Link href="/team/tasks" className="underline">task board</Link>.
          </p>
        )}
      </Panel>
    </div>
  );
}

/**
 * v11 core: managers drag an unassigned task onto a person (or use the Assign button) to open the reassignment
 * dialog with that person picked; "Move work…" moves an overloaded person's open work to others with a preview.
 */
function AssignByDrag({ c, onDone }: { c: TeamCapacityView; onDone: () => void }) {
  const actions = useActionsMaybe();
  const [dragging, setDragging] = useState<string>();
  const [over, setOver] = useState<string>();
  if (!actions || !coreCanManageTasks(actions.me) || c.people.length < 2) return null;
  const open = (taskId: string, toUserId?: string) => {
    const t = c.unassigned.find((x) => x.id === taskId);
    actions.openReassign({ type: "task", ids: [taskId], toUserId, title: t ? `Assign “${t.title}”` : undefined, onDone });
  };
  return (
    <Panel title="Assign and rebalance" subtitle="Drag an unassigned task onto a person, or move an overloaded person's work" className="mt-6">
      <div className="grid gap-4 md:grid-cols-[1fr_1.4fr]" data-testid="capacity-dnd">
        <div>
          <p className="mb-2 text-xs font-medium text-ink-muted">Unassigned ({c.unassigned.length})</p>
          {c.unassigned.length === 0 && <p className="text-xs text-ink-muted">Every open task has an owner.</p>}
          <ul className="grid max-h-80 gap-1 overflow-y-auto">
            {c.unassigned.slice(0, 40).map((t) => (
              <li
                key={t.id}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData("text/plain", t.id);
                  setDragging(t.id);
                }}
                onDragEnd={() => {
                  setDragging(undefined);
                  setOver(undefined);
                }}
                className={`flex cursor-grab items-center justify-between gap-2 border border-border bg-surface-raised px-2 py-1.5 text-sm ${dragging === t.id ? "opacity-50" : ""}`}
                data-unassigned={t.id}
              >
                <span className="min-w-0 truncate">
                  {t.title}
                  {t.client && <span className="text-xs text-ink-muted"> · {t.client}</span>}
                </span>
                <button type="button" className="shrink-0 text-xs underline" onClick={() => open(t.id)}>
                  Assign
                </button>
              </li>
            ))}
          </ul>
        </div>
        <ul className="grid max-h-96 content-start gap-1 overflow-y-auto">
          {c.people.map((p) => (
            <li
              key={p.id}
              onDragOver={(e) => {
                if (!dragging) return;
                e.preventDefault();
                if (over !== p.id) setOver(p.id);
              }}
              onDragLeave={() => over === p.id && setOver(undefined)}
              onDrop={(e) => {
                e.preventDefault();
                const id = e.dataTransfer.getData("text/plain") || dragging;
                setDragging(undefined);
                setOver(undefined);
                if (id) open(id, p.id);
              }}
              className={`grid grid-cols-[minmax(0,1fr)_8rem_auto] items-center gap-2 border px-2 py-1.5 text-sm ${over === p.id ? "border-dashed border-green bg-green/10" : "border-border"}`}
              data-person-drop={p.name}
            >
              <span className="min-w-0 truncate">
                {p.name}
                {p.onLeave && <span className="text-xs text-amber"> · on leave</span>}
              </span>
              <Meter value={p.loadPct} tone={tone(p.loadPct)} />
              {p.open > 0 ? (
                <button type="button" className="text-xs underline" onClick={() => actions.openBulkReassign(p.id, onDone)}>
                  Move work…
                </button>
              ) : (
                <span />
              )}
            </li>
          ))}
        </ul>
      </div>
    </Panel>
  );
}
