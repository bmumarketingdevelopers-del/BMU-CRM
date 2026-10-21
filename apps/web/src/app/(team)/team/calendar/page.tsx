"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { CalendarItem, CalendarItemKind, CalendarView } from "@bmu/shared";
import { Empty, Panel, Tabs } from "@/components/dash";
import { fmtIsoDay, istMonth, monthLabel, shiftMonth } from "@/components/workspace/format";
import { Button, LoadState, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { WhoIsOut } from "@/components/who-is-out";
import { useActionsMaybe } from "@/components/actions/actions-provider";
import { useAutoRefresh } from "@/lib/use-auto-refresh";

const KINDS: { kind: CalendarItemKind; label: string; dot: string }[] = [
  { kind: "task", label: "Task deadlines", dot: "bg-charcoal" },
  { kind: "deliverable", label: "Deliverables due", dot: "bg-green" },
  { kind: "draft_due", label: "First drafts due", dot: "bg-amber" },
  { kind: "meeting", label: "Meetings", dot: "bg-[#3b6fb6]" },
  { kind: "post", label: "Social posts", dot: "bg-[#8a4fbf]" },
  { kind: "leave", label: "Leave", dot: "bg-grey" },
  { kind: "holiday", label: "Holidays", dot: "bg-red" },
];
const dotFor = (k: CalendarItemKind) => KINDS.find((x) => x.kind === k)?.dot ?? "bg-grey";
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Monday-first grid of the month: leading blanks, then each yyyy-mm-dd. */
function grid(month: string) {
  const first = new Date(`${month}-01T00:00:00Z`);
  const lead = (first.getUTCDay() + 6) % 7;
  const days = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  const cells: (string | null)[] = Array.from({ length: lead }, () => null);
  for (let d = 1; d <= days; d++) cells.push(`${month}-${String(d).padStart(2, "0")}`);
  while (cells.length % 7) cells.push(null);
  return cells;
}

export default function CalendarPage() {
  const [month, setMonth] = useState(istMonth());
  const [view, setView] = useState<"mine" | "team">("mine");
  const [data, setData] = useState<CalendarView>();
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<string>();
  const [hidden, setHidden] = useState<CalendarItemKind[]>([]);
  const actions = useActionsMaybe();
  const [added, setAdded] = useState(0);
  // v34: refresh on its own while open (changes anywhere, and every minute).
  useAutoRefresh(() => setAdded((n) => n + 1), ["Task", "Deliverable", "Cycle", "LeaveRequest", "Meeting", "MeetingParticipant", "Settings"]);

  useEffect(() => {
    let live = true;
    api.workspace
      .calendar(month, view)
      .then((d) => {
        if (!live) return;
        setData(d);
        setError(undefined);
        setSelected((s) => (s?.startsWith(month) ? s : d.today.startsWith(month) ? d.today : undefined));
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [month, view, added, actions?.version]);

  const items = (data?.month === month ? data.items : []).filter((i) => !hidden.includes(i.kind));
  const byDay = new Map<string, CalendarItem[]>();
  for (const i of items) byDay.set(i.date, [...(byDay.get(i.date) ?? []), i]);
  const dayItems = selected ? (byDay.get(selected) ?? []) : [];
  const loading = !error && data?.month !== month;

  return (
    <div className="[&_.grid>*]:min-w-0">
      <PageTitle
        title="Calendar"
        subtitle="Deadlines, due dates, first drafts, meetings, social posts, holidays and leave. Click a day to see what is on it. Times are IST. Updates on its own."
        action={
          <Tabs
            value={view}
            onChange={(v) => setView(v)}
            options={[
              { value: "mine", label: "Mine" },
              { value: "team", label: "My team" },
            ]}
          />
        }
      />
      <WhoIsOut />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button variant="secondary" className="px-3" onClick={() => setMonth(shiftMonth(month, -1))} aria-label="Previous month">
            ←
          </Button>
          <h2 className="min-w-40 text-center text-lg font-semibold tracking-tight">{monthLabel(month)}</h2>
          <Button variant="secondary" className="px-3" onClick={() => setMonth(shiftMonth(month, 1))} aria-label="Next month">
            →
          </Button>
          {month !== istMonth() && (
            <Button variant="ghost" onClick={() => setMonth(istMonth())}>
              Today
            </Button>
          )}
        </div>
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {KINDS.map((k) => {
            const off = hidden.includes(k.kind);
            return (
              <li key={k.kind}>
                <button className={`flex items-center gap-1.5 ${off ? "text-ink-muted/50 line-through" : "text-ink-muted hover:text-ink"}`} onClick={() => setHidden(off ? hidden.filter((h) => h !== k.kind) : [...hidden, k.kind])} aria-pressed={!off}>
                  <span className={`inline-block h-2 w-2 ${k.dot} ${off ? "opacity-30" : ""}`} />
                  {k.label}
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      {error && <LoadState loading={false} error={error} />}

      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <div className={`border border-border bg-surface-raised ${loading ? "opacity-60" : ""}`}>
          <div className="grid grid-cols-7 border-b border-border text-[11px] uppercase tracking-[0.1em] text-ink-muted">
            {WEEKDAYS.map((d) => (
              <div key={d} className="px-2 py-2 text-center sm:text-left">
                {d}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-px bg-border">
            {grid(month).map((d, i) => {
              if (!d) return <div key={`b${i}`} className="min-h-16 bg-canvas/40 sm:min-h-24" />;
              const list = byDay.get(d) ?? [];
              const isToday = d === data?.today;
              const sunday = i % 7 === 6;
              const holiday = list.some((x) => x.kind === "holiday");
              return (
                <button
                  key={d}
                  onClick={() => setSelected(d)}
                  className={`flex min-h-16 flex-col items-start justify-start p-1.5 text-left transition-colors hover:bg-canvas/60 sm:min-h-24 sm:p-2 ${selected === d ? "outline-2 -outline-offset-2 outline-charcoal" : ""} ${sunday || holiday ? "bg-canvas/50" : "bg-surface-raised"}`}
                  aria-label={`${fmtIsoDay(d)}: ${list.length} item${list.length === 1 ? "" : "s"}`}
                >
                  <span className={`inline-flex h-6 w-6 items-center justify-center text-xs tabular-nums ${isToday ? "bg-green font-semibold text-charcoal" : sunday ? "text-ink-muted" : ""}`}>{Number(d.slice(8))}</span>
                  <ul className="mt-1 hidden w-full space-y-0.5 sm:block">
                    {list.slice(0, 3).map((x) => (
                      <li key={x.id} className={`flex items-center gap-1 truncate text-[11px] ${x.done ? "text-ink-muted line-through" : x.overdue ? "text-red" : ""}`}>
                        <span className={`inline-block h-1.5 w-1.5 shrink-0 ${dotFor(x.kind)}`} />
                        <span className="truncate">
                          {x.time && <span className="tabular-nums text-ink-muted">{x.time} </span>}
                          {x.title}
                        </span>
                      </li>
                    ))}
                    {list.length > 3 && <li className="text-[11px] text-ink-muted">+{list.length - 3} more</li>}
                  </ul>
                  {list.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-0.5 sm:hidden">
                      {list.slice(0, 4).map((x) => (
                        <span key={x.id} className={`inline-block h-1.5 w-1.5 ${dotFor(x.kind)}`} />
                      ))}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        <Panel title={selected ? fmtIsoDay(selected, true) : "Pick a day"} subtitle={selected ? `${dayItems.length} item${dayItems.length === 1 ? "" : "s"}` : "Click any day in the calendar"} className="self-start lg:sticky lg:top-6"
          action={
            selected && actions?.canNew("task") ? (
              <button type="button" className="text-xs text-ink-muted hover:text-ink" onClick={() => actions.openNew("task", { deadline: selected }, () => setAdded((n) => n + 1))} data-testid="calendar-add-task">
                + Add task
              </button>
            ) : undefined
          }
        >
          {!selected || dayItems.length === 0 ? (
            <Empty>{selected ? "Nothing on this day." : "Nothing selected."}</Empty>
          ) : (
            <ul className="space-y-3">
              {dayItems.map((x) => {
                const body = (
                  <div className="[&_.grid>*]:min-w-0">
                    <p className={`flex items-start gap-2 text-sm font-medium ${x.done ? "text-ink-muted line-through" : ""}`}>
                      <span className={`mt-1.5 inline-block h-2 w-2 shrink-0 ${dotFor(x.kind)}`} />
                      <span>{x.title}</span>
                    </p>
                    <p className="ml-4 text-xs text-ink-muted">
                      {KINDS.find((k) => k.kind === x.kind)?.label.replace(/s$/, "")}
                      {x.sub && ` · ${x.sub}`}
                      {x.overdue && <span className="text-red"> · overdue</span>}
                    </p>
                  </div>
                );
                return <li key={x.id}>{x.href ? <Link href={x.href} className="block hover:opacity-75">{body}</Link> : body}</li>;
              })}
            </ul>
          )}
        </Panel>
      </div>

      {data && data.month === month && items.length === 0 && <p className="mt-4 text-sm text-ink-muted">Nothing scheduled in {monthLabel(month)}{view === "mine" ? " for you" : " for your team"}.</p>}
    </div>
  );
}
