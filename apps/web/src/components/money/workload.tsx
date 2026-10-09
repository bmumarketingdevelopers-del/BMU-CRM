"use client";
// v18 workload: six-week heatmap of each person's booked and task hours against their free hours (after leave and
// holidays), booking people on projects, skill requests and the best free people for a week.
import { Fragment, useState } from "react";
import type { BookingRow, BookingSuggestions, MoneyOptions, WorkloadCell, WorkloadPerson } from "@bmu/shared";
import { Badge, Button, Input, LoadState, PageTitle, Select } from "@/components/ui";
import { DataTable, Panel } from "@/components/dash";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { addDays, day, Field, mondayOf, Note, todayIst } from "./kit";

function cellTone(c: WorkloadCell) {
  if (c.availableHours <= 0) return "bg-canvas text-ink-muted";
  const p = c.loadPct ?? 0;
  if (p > 120) return "bg-[#f6ddd6] text-[#b4432c]";
  if (p > 100) return "bg-[#fbeccc] text-[#9a6b00]";
  if (p >= 70) return "bg-[#e8f1d6] text-ink";
  return "bg-surface-raised text-ink";
}

type Draft = { engagementId: string; userId: string; specialty: string; weekStart: string; weeks: number; hours: number; note: string };

export function Workload() {
  const [from, setFrom] = useState(mondayOf(todayIst()));
  const view = useLoad(() => api.capacity.workload({ from, weeks: "6" }), { live: ["ResourceBooking", "LeaveRequest", "Task"] });
  const options = useLoad(() => api.money.options(), { live: false });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [suggest, setSuggest] = useState<BookingSuggestions | null>(null);
  const [msg, setMsg] = useState<{ error?: string; ok?: string }>({});
  const [q, setQ] = useState("");
  const move = (n: number) => {
    setFrom(addDays(from, n * 7));
    setTimeout(view.reload, 0);
  };
  if (!view.data) return <LoadState loading={view.loading} error={view.error} />;
  const v = view.data;
  const projects = (options.data?.clients ?? []).flatMap((c) => c.projects.map((p) => ({ id: p.id, label: `${c.name} · ${p.label}` })));
  const people = v.people.filter((p) => !q || `${p.name} ${p.specialty ?? ""}`.toLowerCase().includes(q.toLowerCase()));
  const open = (p: WorkloadPerson | null, week: string, specialty = "") => {
    if (!v.canBook) return;
    setMsg({});
    setSuggest(null);
    setDraft({ engagementId: draft?.engagementId ?? projects[0]?.id ?? "", userId: p?.userId ?? "", specialty, weekStart: week, weeks: 1, hours: 8, note: "" });
  };
  const book = async () => {
    if (!draft) return;
    try {
      const r = await api.capacity.book({ engagementId: draft.engagementId, userId: draft.userId || null, specialty: draft.userId ? null : draft.specialty || null, weekStart: draft.weekStart, weeks: draft.weeks, hours: draft.hours, note: draft.note || null });
      setMsg({ ok: `${r.created.length ? `Booked ${r.created.length} week${r.created.length === 1 ? "" : "s"}.` : ""}${r.skipped.length ? ` Skipped: ${r.skipped.map((s) => `${day(s.weekStart)} (${s.reason})`).join("; ")}` : ""}`.trim() });
      setDraft(null);
      view.reload();
    } catch (e) {
      setMsg({ error: (e as Error).message });
    }
  };
  const findPeople = async (week: string, specialty: string, hours: number) => {
    try {
      setSuggest(await api.capacity.suggest({ weekStart: week, specialty: specialty || undefined, hours: String(hours) }));
    } catch (e) {
      setMsg({ error: (e as Error).message });
    }
  };
  const fill = (r: BookingRow, userId: string) => api.capacity.updateBooking(r.id, { userId }).then(() => { setMsg({ ok: "Request filled." }); setSuggest(null); view.reload(); }).catch((e: Error) => setMsg({ error: e.message }));
  const setHours = (p: WorkloadPerson) => {
    const h = window.prompt(`${p.name}: working hours per week`, String(p.weeklyHours));
    if (h === null) return;
    api.capacity.setWeeklyHours(p.userId, Number(h)).then(view.reload).catch((e: Error) => setMsg({ error: e.message }));
  };
  return (
    <>
      <PageTitle
        title="Workload"
        subtitle="Six weeks ahead: booked project hours plus open task estimates, against each person's hours after leave and holidays."
        action={
          <div className="flex gap-2 text-sm">
            <Button variant="secondary" onClick={() => move(-1)}>← Earlier</Button>
            <Button variant="secondary" onClick={() => move(1)}>Later →</Button>
            {v.canBook && <Button onClick={() => open(null, from)} data-testid="new-booking">Book someone</Button>}
          </div>
        }
      />
      <div className="space-y-6">
        <Note {...msg} />
        {draft && (
          <Panel title="Book time on a project" subtitle="People on approved leave, or without free hours that week, are refused." action={<Button variant="ghost" onClick={() => setDraft(null)}>Close</Button>}>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Project">
                <Select value={draft.engagementId} onChange={(e) => setDraft({ ...draft, engagementId: e.target.value })} data-testid="booking-project">
                  {projects.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                </Select>
              </Field>
              <Field label="Person">
                <Select value={draft.userId} onChange={(e) => setDraft({ ...draft, userId: e.target.value })} data-testid="booking-person">
                  <option value="">Anyone with a skill (request)</option>
                  {v.people.map((p) => <option key={p.userId} value={p.userId}>{p.name}{p.specialty ? ` · ${p.specialty.replaceAll("_", " ")}` : ""}</option>)}
                </Select>
              </Field>
              {!draft.userId && (
                <Field label="Skill needed">
                  <Select value={draft.specialty} onChange={(e) => setDraft({ ...draft, specialty: e.target.value })}>
                    <option value="">Pick a skill</option>
                    {options.data?.specialties.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                  </Select>
                </Field>
              )}
              <Field label="Week starting (Monday)"><Input type="date" value={draft.weekStart} step={7} onChange={(e) => setDraft({ ...draft, weekStart: mondayOf(e.target.value) })} /></Field>
              <Field label="Hours per week"><Input type="number" min={1} max={80} value={draft.hours} onChange={(e) => setDraft({ ...draft, hours: Number(e.target.value) })} data-testid="booking-hours" /></Field>
              <Field label="For how many weeks"><Input type="number" min={1} max={12} value={draft.weeks} onChange={(e) => setDraft({ ...draft, weeks: Number(e.target.value) })} /></Field>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button onClick={book} data-testid="booking-save">{draft.userId ? "Book" : "Post request"}</Button>
              <Button variant="secondary" onClick={() => findPeople(draft.weekStart, draft.specialty, draft.hours)} data-testid="booking-suggest">Who is free?</Button>
            </div>
            {suggest && (
              <ul className="mt-3 divide-y divide-border border border-border text-sm" data-testid="suggestions">
                {suggest.candidates.length === 0 && <li className="px-3 py-2 text-ink-muted">Nobody{suggest.specialty ? " with that skill" : ""} has that many free hours that week.</li>}
                {suggest.candidates.map((c) => (
                  <li key={c.userId} className="flex items-center justify-between gap-2 px-3 py-2">
                    <span>{c.name}<span className="block text-xs text-ink-muted">{c.reason}</span></span>
                    <Button variant="secondary" onClick={() => setDraft({ ...draft, userId: c.userId })}>Pick</Button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        )}
        <div className="overflow-x-auto border border-border bg-surface-raised">
          <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2">
            <Input placeholder="Find a person or skill" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-xs" />
            <p className="text-xs text-ink-muted">Hours booked + task estimates / free hours. Amber over 100%, red over 120%.</p>
          </div>
          <table className="w-full min-w-[760px] text-sm" data-testid="heatmap">
            <thead>
              <tr className="border-b border-border text-xs text-ink-muted">
                <th className="px-4 py-2 text-left font-normal">Person</th>
                {v.weeks.map((w) => <th key={w} className="px-2 py-2 text-center font-normal">{day(w)}</th>)}
              </tr>
            </thead>
            <tbody>
              {people.map((p) => (
                <tr key={p.userId} className="border-b border-border" data-testid="heatmap-row">
                  <td className="px-4 py-2">
                    <span className="font-medium">{p.name}</span>
                    <span className="block text-xs text-ink-muted">
                      {(p.specialty ?? p.role).replaceAll("_", " ")} ·{" "}
                      {v.canBook ? <button className="underline" onClick={() => setHours(p)}>{p.weeklyHours}h/week</button> : `${p.weeklyHours}h/week`}
                    </span>
                  </td>
                  {p.cells.map((c) => (
                    <td key={c.weekStart} className="p-1">
                      <button onClick={() => open(p, c.weekStart)} disabled={!v.canBook} className={`block w-full px-2 py-2 text-center ${cellTone(c)}`} title={`${c.bookedHours}h booked + ${c.taskHours}h tasks of ${c.availableHours}h free${c.leaveDays ? `; ${c.leaveDays} day(s) leave` : ""}${c.holidayDays ? `; ${c.holidayDays} holiday(s)` : ""}`} data-testid="heatmap-cell">
                        {c.availableHours <= 0 ? (c.leaveDays ? "Leave" : "Off") : `${c.loadPct ?? 0}%`}
                        <span className="block text-[10px] opacity-70">{c.leaveDays ? `${c.leaveDays}d leave` : `${Math.round(c.bookedHours + c.taskHours)}/${Math.round(c.availableHours)}h`}</span>
                      </button>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {v.holidays.length > 0 && <p className="px-4 py-2 text-xs text-ink-muted">Holidays: {v.holidays.map((h) => `${day(h.date)} ${h.name}`).join(", ")}</p>}
        </div>
        {v.requests.length > 0 && (
          <Panel title="Skill requests" subtitle="Projects asking for someone with a skill. The Producer agent suggests the best free person each morning." flush>
            <DataTable<BookingRow>
              rows={v.requests}
              rowKey={(r) => r.id}
              columns={[
                { key: "w", header: "Week", cell: (r) => day(r.weekStart) },
                { key: "p", header: "Project", cell: (r) => <span>{r.client} · {r.project}{r.note && <span className="block text-xs text-ink-muted">{r.note}</span>}</span> },
                { key: "s", header: "Skill", cell: (r) => <Badge>{(r.specialty ?? "any").replaceAll("_", " ")}</Badge> },
                { key: "h", header: "Hours", align: "right", cell: (r) => r.hours },
                {
                  key: "a",
                  header: "",
                  align: "right",
                  cell: (r) =>
                    v.canBook ? (
                      <RequestFill r={r} onFill={fill} />
                    ) : null,
                },
              ]}
            />
          </Panel>
        )}
        <Panel title="Bookings" subtitle="Hours reserved per person and week." flush>
          <DataTable<BookingRow>
            rows={v.bookings}
            rowKey={(r) => r.id}
            empty="No bookings in these weeks."
            columns={[
              { key: "w", header: "Week", cell: (r) => day(r.weekStart) },
              { key: "who", header: "Person", cell: (r) => r.person },
              { key: "p", header: "Project", cell: (r) => `${r.client} · ${r.project}` },
              { key: "h", header: "Hours", align: "right", cell: (r) => r.hours },
              { key: "a", header: "", align: "right", cell: (r) => (v.canBook ? <Button variant="ghost" onClick={() => window.confirm("Remove this booking?") && api.capacity.deleteBooking(r.id).then(view.reload)}>Remove</Button> : null) },
            ]}
          />
        </Panel>
      </div>
    </>
  );
}

function RequestFill({ r, onFill }: { r: BookingRow; onFill: (r: BookingRow, userId: string) => void }) {
  const [s, setS] = useState<BookingSuggestions | null>(null);
  const [err, setErr] = useState<string>();
  if (!s)
    return (
      <Button variant="secondary" onClick={() => api.capacity.suggest({ weekStart: r.weekStart, specialty: r.specialty ?? undefined, hours: String(r.hours) }).then(setS).catch((e: Error) => setErr(e.message))} data-testid="request-find">
        Find someone
      </Button>
    );
  return (
    <div className="flex flex-wrap justify-end gap-1">
      {s.candidates.length === 0 && <span className="text-xs text-ink-muted">Nobody free that week</span>}
      {s.candidates.slice(0, 3).map((c) => (
        <Fragment key={c.userId}>
          <Button variant="secondary" onClick={() => onFill(r, c.userId)} title={c.reason}>{c.name.split(" ")[0]}</Button>
        </Fragment>
      ))}
      {err && <span className="text-xs text-[#b4432c]">{err}</span>}
    </div>
  );
}

export type { MoneyOptions };
