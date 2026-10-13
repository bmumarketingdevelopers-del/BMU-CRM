"use client";

import { useState } from "react";
import type { SettingsValue, SettingsView } from "@bmu/shared";
import { Empty, KeyValues, Panel, StatRow, StatTile } from "@/components/dash";
import { Badge, Button, Input, LoadState, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { DAY_NAMES, ErrorNote, Field, fmtDate, weekday } from "../_admin-org/kit";

const todayIst = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

export default function HolidaysPage() {
  const s = useLoad(() => api.settings.all());
  const [view, setView] = useState<SettingsView>();
  const data = view ?? s.data;
  return (
    <>
      <PageTitle title="Holidays & Working Hours" subtitle="The office calendar. Request SLAs, plan deadlines and attendance all skip these holidays and count only working hours." />
      <LoadState loading={!data && s.loading} error={s.error} />
      {data && <Editor key={JSON.stringify([data.holidays, data.workingHours])} data={data} onSaved={setView} />}
    </>
  );
}

function Editor({ data, onSaved }: { data: SettingsView; onSaved: (v: SettingsView) => void }) {
  const [list, setList] = useState(() => [...data.holidays.list].sort((a, b) => a.date.localeCompare(b.date)));
  const [hours, setHours] = useState<SettingsValue<"workingHours">>(data.workingHours);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState<string>();
  const canHolidays = data.canEdit.holidays;
  const canHours = data.canEdit.workingHours;
  const today = todayIst();
  const upcoming = list.filter((h) => h.date >= today);
  const next = upcoming[0];

  async function save<S extends "holidays" | "workingHours">(section: S, value: SettingsValue<S>, msg: string) {
    setError(undefined);
    setSaved(undefined);
    try {
      onSaved(await api.settings.save(section, value));
      setSaved(msg);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function addHoliday(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const date = String(f.get("date"));
    const name = String(f.get("name")).trim();
    if (list.some((h) => h.date === date)) return setError(`${fmtDate(date)} is already a holiday`);
    const nextList = [...list, { date, name }].sort((a, b) => a.date.localeCompare(b.date));
    setList(nextList);
    save("holidays", { list: nextList }, `Added ${name}`);
  }

  function removeHoliday(date: string) {
    const h = list.find((x) => x.date === date);
    if (!h || !window.confirm(`Remove ${h.name} (${fmtDate(date)})? Deadlines will start counting that day.`)) return;
    const nextList = list.filter((x) => x.date !== date);
    setList(nextList);
    save("holidays", { list: nextList }, `Removed ${h.name}`);
  }

  const toggleDay = (d: number) => setHours((h) => ({ ...h, days: h.days.includes(d) ? h.days.filter((x) => x !== d) : [...h.days, d].sort() }));
  const hoursPerDay = (() => {
    const [sh, sm] = hours.start.split(":").map(Number);
    const [eh, em] = hours.end.split(":").map(Number);
    return Math.max(0, (eh * 60 + em - sh * 60 - sm) / 60);
  })();

  return (
    <div className="space-y-6">
      <ErrorNote>{error}</ErrorNote>
      {saved && <p className="border border-green bg-green/10 px-4 py-2 text-sm">{saved}. Saved and logged.</p>}
      {!canHolidays && <p className="text-sm text-ink-muted">You can view the calendar. Only the Founder or Branch Manager can change it.</p>}

      <StatRow>
        <StatTile label="Next holiday" value={next ? fmtDate(next.date) : "None"} hint={next?.name} tone={next ? "good" : "default"} />
        <StatTile label="Holidays ahead" value={upcoming.length} hint={`${list.length} in the list`} />
        <StatTile label="Working hours" value={`${hours.start}–${hours.end}`} hint={`${hoursPerDay} h a day`} />
        <StatTile label="Working days" value={hours.days.length} hint={hours.days.map((d) => DAY_NAMES[d]).join(" ")} />
      </StatRow>

      <div className="grid grid-cols-1 gap-6 [&>*]:min-w-0 lg:grid-cols-[3fr_2fr]">
        <Panel title="Holidays" subtitle="Sorted by date. Upcoming ones are highlighted." flush>
          {canHolidays && (
            <form onSubmit={addHoliday} className="grid gap-3 border-b border-border p-5 sm:grid-cols-[10rem_1fr_auto] sm:items-end">
              <Field label="Date">
                <Input type="date" name="date" required />
              </Field>
              <Field label="Name">
                <Input name="name" required maxLength={80} placeholder="e.g. Ugadi" />
              </Field>
              <Button type="submit">Add holiday</Button>
            </form>
          )}
          {list.length === 0 ? (
            <Empty>No holidays yet. Sundays are always off.</Empty>
          ) : (
            <ul className="divide-y divide-border">
              {list.map((h) => {
                const past = h.date < today;
                return (
                  <li key={h.date} className={`flex items-center gap-3 px-4 sm:gap-4 sm:px-5 py-3 text-sm ${past ? "text-ink-muted" : ""}`}>
                    <span className={`w-1 self-stretch ${h === next ? "bg-green" : past ? "bg-transparent" : "bg-charcoal"}`} aria-hidden />
                    <span className="w-28 shrink-0 tabular-nums">{fmtDate(h.date)}</span>
                    <span className="hidden w-10 shrink-0 text-xs text-ink-muted sm:inline">{weekday(h.date)}</span>
                    <span className="min-w-0 flex-1 truncate font-medium">{h.name}</span>
                    {h === next && <Badge tone="green">Next</Badge>}
                    {past && <span className="hidden text-xs sm:inline">Past</span>}
                    {canHolidays && (
                      <button className="text-xs text-ink-muted hover:text-ink" onClick={() => removeHoliday(h.date)} aria-label={`Remove ${h.name}`}>
                        Remove
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>

        <div className="space-y-6">
          <Panel title="Working hours" subtitle="Used for late check-ins and as the office day.">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Day starts">
                <Input type="time" value={hours.start} disabled={!canHours} onChange={(e) => setHours({ ...hours, start: e.target.value })} />
              </Field>
              <Field label="Day ends">
                <Input type="time" value={hours.end} disabled={!canHours} onChange={(e) => setHours({ ...hours, end: e.target.value })} />
              </Field>
            </div>
            <p className="mt-4 mb-2 text-xs text-ink-muted">Working days</p>
            <div className="flex flex-wrap gap-1">
              {DAY_NAMES.map((n, d) => (
                <button
                  key={n}
                  type="button"
                  disabled={!canHours}
                  aria-pressed={hours.days.includes(d)}
                  onClick={() => toggleDay(d)}
                  className={`w-11 border py-1.5 text-sm ${hours.days.includes(d) ? "border-charcoal bg-charcoal text-ivory" : "border-border text-ink-muted"}`}
                >
                  {n}
                </button>
              ))}
            </div>
            {canHours && (
              <Button className="mt-5" disabled={!hours.days.length || hours.start >= hours.end} onClick={() => save("workingHours", hours, "Working hours updated")}>
                Save working hours
              </Button>
            )}
          </Panel>
          <Panel title="Where this is used">
            <KeyValues
              items={[
                { k: "Request first-reply SLAs", v: "Pause outside hours & on holidays" },
                { k: "Plan deadline (Gate 2)", v: "Counts working days" },
                { k: "Attendance", v: "Late after start time" },
                { k: "Leave balances", v: "Holidays not deducted" },
              ]}
            />
            <p className="mt-3 text-xs text-ink-muted">Timezone: {hours.timezone}. SLA timers currently follow the standard 9:30–18:30 day; holidays apply everywhere.</p>
          </Panel>
        </div>
      </div>
    </div>
  );
}
