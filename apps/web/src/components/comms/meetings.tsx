"use client";

// v17 meetings: free-slot picker (client portal and public link), the team's meetings with notes, summary and
// action items that become tasks, and booking page settings.
import Link from "next/link";
import { useState } from "react";
import type { BookingPageView, BookingSlots, MeetingList, MeetingView } from "@bmu/shared";
import { Badge, Button, Card, Input, LoadState, PageTitle, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { ClientMeetingRow, ClientRequestForm, FixedMeetingActions, FounderMeetingRequest, TeamRequestCard, teamTime } from "./meeting-requests";

const IST = { timeZone: "Asia/Kolkata" } as const;
export const dayLabel = new Intl.DateTimeFormat("en-IN", { ...IST, weekday: "short", day: "numeric", month: "short" });
export const timeLabel = new Intl.DateTimeFormat("en-IN", { ...IST, hour: "numeric", minute: "2-digit", hour12: true });
export const whenLabel = (iso: string) => `${dayLabel.format(new Date(iso))}, ${timeLabel.format(new Date(iso))}`;
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Pick a day, then a time. */
export function SlotPicker({ slots, value, onChange }: { slots: BookingSlots; value: string | null; onChange: (iso: string) => void }) {
  const [day, setDay] = useState(slots.days[0]?.day ?? "");
  const current = slots.days.find((d) => d.day === day) ?? slots.days[0];
  if (!slots.days.length) return <p className="text-sm text-ink-muted">No free times in the next two weeks. Please message us instead.</p>;
  return (
    <div data-testid="slot-picker">
      <div className="mb-3 flex gap-1 overflow-x-auto pb-1">
        {slots.days.map((d) => (
          <button key={d.day} onClick={() => setDay(d.day)} className={`shrink-0 px-3 py-2 text-sm ${current?.day === d.day ? "bg-charcoal text-ivory" : "border border-border"}`}>
            {dayLabel.format(new Date(`${d.day}T12:00:00+05:30`))}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
        {current?.slots.map((s) => (
          <button key={s} onClick={() => onChange(s)} className={`px-2 py-2 text-sm ${value === s ? "bg-green font-semibold text-charcoal" : "border border-border hover:border-ink"}`} data-testid="slot">
            {timeLabel.format(new Date(s))}
          </button>
        ))}
      </div>
      <p className="mt-2 text-xs text-ink-muted">Times are India time (IST). {slots.durationMin} minutes.</p>
    </div>
  );
}

function MeetingRow({ m, team, onOpen, onCancel }: { m: MeetingView; team: boolean; onOpen?: () => void; onCancel?: () => void }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-3 text-sm" data-testid="meeting-row">
      <div className="min-w-0">
        <p className="font-medium">{m.title}</p>
        <p className="text-xs text-ink-muted">
          {team && m.timeZone !== "Asia/Kolkata" ? teamTime(m.startAt, m.timeZone) : whenLabel(m.startAt)} · {team ? (m.client?.name ?? (m.lead ? `Lead: ${m.lead.name}` : (m.guest.name ?? "Internal"))) : `with ${m.host.name}`}
          {m.agenda ? ` · ${m.agenda}` : ""}
        </p>
      </div>
      <div className="flex items-center gap-2">
        {m.status !== "booked" && <Badge tone={m.status === "done" ? "green" : "neutral"}>{m.status === "done" ? "Held" : "Cancelled"}</Badge>}
        {m.bookedVia !== "team" && team && <Badge>{m.bookedVia === "client" ? "Asked by client" : m.bookedVia === "founder" ? "Asked by Founder" : "Booking link"}</Badge>}
        {onOpen && (
          <Button variant="secondary" onClick={onOpen}>
            Notes
          </Button>
        )}
        {m.can.cancel && onCancel && (
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ team

export function TeamMeetings({ isFounder = false }: { isFounder?: boolean }) {
  const list = useLoad(() => api.meetings.list(), { live: ["Meeting", "MeetingParticipant"] });
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  if (!list.data) return <LoadState loading={list.loading} error={list.error} />;
  const d = list.data;
  const cancel = (id: string) => window.confirm("Cancel this meeting? The guest is told by email.") && api.meetings.cancel(id).then(list.reload).catch((e: Error) => setError(e.message));
  return (
    <>
      <PageTitle title="Meetings" subtitle="Meeting requests from clients to arrange or confirm, meetings you are in, and calls from your booking link. Write notes after the call and turn action items into tasks." />
      {error && <p className="mb-4 border border-red bg-red/10 px-3 py-2 text-sm">{error}</p>}
      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <div>
          {!!d.requests.length && (
            <>
              <h2 className="mb-2 font-semibold">Requests</h2>
              <div className="mb-8 border-t border-border" data-testid="meeting-requests">
                {d.requests.map((m) => (
                  <div key={m.id}>
                    <TeamRequestCard m={m} onChanged={list.reload} />
                    {m.can.cancel && (
                      <button className="mb-2 text-xs underline" onClick={() => cancel(m.id)}>
                        Cancel this request
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
          <h2 className="mb-2 font-semibold">Upcoming</h2>
          <div className="mb-8 border-t border-border">
            {d.upcoming.map((m) => (
              <div key={m.id}>
                <MeetingRow m={m} team onOpen={() => setOpen(open === m.id ? null : m.id)} onCancel={() => cancel(m.id)} />
                {(m.participants.length > 0 || m.joinUrl || m.can.shareLink) && <FixedMeetingActions m={m} onChanged={list.reload} />}
                {open === m.id && <MeetingNotes key={m.id} m={m} onSaved={list.reload} />}
              </div>
            ))}
            {!d.upcoming.length && <p className="py-6 text-center text-sm text-ink-muted">No meetings booked.</p>}
          </div>
          <h2 className="mb-2 font-semibold">Past</h2>
          <div className="border-t border-border">
            {d.past.map((m) => (
              <div key={m.id}>
                <MeetingRow m={m} team onOpen={m.status === "cancelled" ? undefined : () => setOpen(open === m.id ? null : m.id)} />
                {open === m.id && <MeetingNotes key={m.id} m={m} onSaved={list.reload} />}
              </div>
            ))}
            {!d.past.length && <p className="py-6 text-center text-sm text-ink-muted">Nothing yet.</p>}
          </div>
        </div>
        <div className="space-y-6">
          {isFounder && <FounderMeetingRequest onSaved={list.reload} />}
          <AddMeeting onSaved={list.reload} />
          {d.booking && <BookingSettings initial={d.booking} />}
        </div>
      </div>
    </>
  );
}

function MeetingNotes({ m, onSaved }: { m: MeetingView; onSaved: () => void }) {
  const [notes, setNotes] = useState(m.notes ?? "");
  const [summary, setSummary] = useState(m.summary ?? "");
  const [items, setItems] = useState(m.actionItems);
  const [picked, setPicked] = useState<number[]>([]);
  const [msg, setMsg] = useState<string>();
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try {
      await fn();
      setMsg(ok);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const save = (done?: boolean) => run(async () => {
    const v = await api.meetings.saveNotes(m.id, { notes, summary: summary || null, actionItems: items.map((a) => ({ text: a.text, taskId: a.taskId })), status: done ? "done" : undefined });
    setItems(v.actionItems);
    onSaved();
  }, done ? "Saved and marked as held." : "Saved.");
  return (
    <div className="mb-4 space-y-3 border border-border bg-canvas/30 p-4 text-sm" data-testid="meeting-notes">
      {!m.can.edit && <p className="text-xs text-ink-muted">Only the host can edit these notes.</p>}
      <label className="block">
        <span className="text-xs font-medium">Notes</span>
        <textarea className="mt-1 h-32 w-full border border-border bg-surface-raised p-2" value={notes} onChange={(e) => setNotes(e.target.value)} readOnly={!m.can.edit} placeholder={"What was discussed.\n- [ ] Action items as checkboxes, or lines starting with Action:"} aria-label="Meeting notes" />
      </label>
      {m.can.edit && (
        <Button
          variant="secondary"
          disabled={busy || notes.trim().length < 20}
          data-testid="meeting-summarise"
          onClick={() =>
            run(async () => {
              await api.meetings.saveNotes(m.id, { notes });
              const r = await api.meetings.summarise(m.id);
              setSummary(r.summary);
              setItems(r.actionItems.map((text) => ({ text, taskId: null })));
              setMsg(r.basic ? "Summary from simple rules (AI is off). Check it before saving." : "AI summary. Check it before saving.");
            })
          }
        >
          Summarise and find action items
        </Button>
      )}
      <label className="block">
        <span className="text-xs font-medium">Summary (the client sees this)</span>
        <textarea className="mt-1 h-20 w-full border border-border bg-surface-raised p-2" value={summary} onChange={(e) => setSummary(e.target.value)} readOnly={!m.can.edit} aria-label="Summary" />
      </label>
      <div>
        <p className="text-xs font-medium">Action items</p>
        {items.map((a, i) => (
          <label key={i} className="mt-1 flex items-center gap-2">
            {a.taskId ? (
              <Link href={`/team/tasks/${a.taskId}`} className="text-xs underline">
                Task
              </Link>
            ) : (
              <input type="checkbox" checked={picked.includes(i)} onChange={(e) => setPicked(e.target.checked ? [...picked, i] : picked.filter((x) => x !== i))} disabled={!m.can.edit} />
            )}
            <Input value={a.text} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} readOnly={!m.can.edit || !!a.taskId} aria-label={`Action item ${i + 1}`} />
          </label>
        ))}
        {m.can.edit && (
          <button className="mt-1 text-xs underline" onClick={() => setItems([...items, { text: "", taskId: null }])}>
            Add action item
          </button>
        )}
      </div>
      {m.can.edit && (
        <div className="flex flex-wrap gap-2">
          <Button disabled={busy} onClick={() => save()}>
            Save
          </Button>
          {m.status === "booked" && (
            <Button variant="secondary" disabled={busy} onClick={() => save(true)}>
              Save and mark held
            </Button>
          )}
          <Button
            variant="secondary"
            disabled={busy || !picked.length}
            data-testid="meeting-tasks"
            onClick={() =>
              run(async () => {
                await api.meetings.saveNotes(m.id, { notes, summary: summary || null, actionItems: items.filter((a) => a.text.trim()).map((a) => ({ text: a.text, taskId: a.taskId })) });
                const v = await api.meetings.createTasks(m.id, picked);
                setItems(v.actionItems);
                setPicked([]);
                onSaved();
              }, "Tasks created. They are on your task list.")
            }
          >
            Make tasks ({picked.length})
          </Button>
        </div>
      )}
      {msg && <p className="text-xs text-ink-muted">{msg}</p>}
    </div>
  );
}

function AddMeeting({ onSaved }: { onSaved: () => void }) {
  const clients = useLoad(() => api.clients.list().catch(() => []), { live: false });
  const [title, setTitle] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("11:00");
  const [duration, setDuration] = useState(30);
  const [clientOrgId, setClientOrgId] = useState("");
  const [location, setLocation] = useState("");
  const [error, setError] = useState<string>();
  return (
    <Card>
      <h2 className="mb-3 font-semibold">Add a meeting</h2>
      <div className="space-y-2 text-sm">
        <Input placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Meeting title" />
        <div className="flex gap-2">
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Date" />
          <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} aria-label="Time" />
          <Select value={duration} onChange={(e) => setDuration(Number(e.target.value))} aria-label="Length">
            {[15, 30, 45, 60, 90].map((m) => (
              <option key={m} value={m}>
                {m} min
              </option>
            ))}
          </Select>
        </div>
        <Select className="w-full" value={clientOrgId} onChange={(e) => setClientOrgId(e.target.value)} aria-label="Client">
          <option value="">No client</option>
          {clients.data?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        <Input placeholder="Where (Google Meet link, office…)" value={location} onChange={(e) => setLocation(e.target.value)} aria-label="Location" />
        {error && <p className="text-xs text-red">{error}</p>}
        <Button
          disabled={title.trim().length < 2 || !date}
          onClick={() =>
            api.meetings
              .create({ title: title.trim(), startAt: new Date(`${date}T${time}:00+05:30`).toISOString(), durationMin: duration, clientOrgId: clientOrgId || null, location: location || undefined })
              .then(() => {
                setTitle("");
                setError(undefined);
                onSaved();
              })
              .catch((e: Error) => setError(e.message))
          }
        >
          Add meeting
        </Button>
      </div>
    </Card>
  );
}

function BookingSettings({ initial }: { initial: BookingPageView }) {
  const [b, setB] = useState(initial);
  const [msg, setMsg] = useState<string>();
  return (
    <Card>
      <h2 className="mb-1 font-semibold">Your booking page</h2>
      <p className="mb-3 text-xs text-ink-muted">
        Clients book you from their portal; anyone else can use{" "}
        <a className="break-all underline" href={b.url} target="_blank" rel="noreferrer" data-testid="booking-url">
          {b.url}
        </a>
      </p>
      <div className="space-y-2 text-sm">
        <Input value={b.title} onChange={(e) => setB({ ...b, title: e.target.value })} aria-label="Booking title" />
        <div className="flex flex-wrap gap-1">
          {DAYS.map((label, i) => (
            <button key={label} onClick={() => setB({ ...b, days: b.days.includes(i + 1) ? b.days.filter((x) => x !== i + 1) : [...b.days, i + 1].sort() })} className={`px-2 py-1 text-xs ${b.days.includes(i + 1) ? "bg-charcoal text-ivory" : "border border-border"}`}>
              {label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input className="w-28" type="time" value={b.startTime} onChange={(e) => setB({ ...b, startTime: e.target.value })} aria-label="From" />
          <span>to</span>
          <Input className="w-28" type="time" value={b.endTime} onChange={(e) => setB({ ...b, endTime: e.target.value })} aria-label="Until" />
          <Select value={b.durationMin} onChange={(e) => setB({ ...b, durationMin: Number(e.target.value) })} aria-label="Call length">
            {[15, 30, 45, 60].map((m) => (
              <option key={m} value={m}>
                {m} min calls
              </option>
            ))}
          </Select>
        </div>
        <label className="flex items-center gap-2">
          Notice
          <Input className="w-20" type="number" min={0} max={72} value={b.noticeHours} onChange={(e) => setB({ ...b, noticeHours: Number(e.target.value) })} aria-label="Notice hours" />
          hours
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={b.active} onChange={(e) => setB({ ...b, active: e.target.checked })} /> Booking link is on
        </label>
        <Button
          onClick={() =>
            api.meetings
              .saveBookingPage({ title: b.title, durationMin: b.durationMin as 15 | 30 | 45 | 60, days: b.days, startTime: b.startTime, endTime: b.endTime, noticeHours: b.noticeHours, active: b.active })
              .then((x) => {
                setB(x);
                setMsg("Saved.");
              })
              .catch((e: Error) => setMsg(e.message))
          }
        >
          Save booking page
        </Button>
        {msg && <p className="text-xs text-ink-muted">{msg}</p>}
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------------------------------------ client portal

export function ClientMeetings() {
  const list = useLoad(() => api.meetings.clientList(), { live: ["Meeting", "MeetingParticipant"] });
  const [booking, setBooking] = useState(false);
  const [error, setError] = useState<string>();
  if (!list.data) return <LoadState loading={list.loading} error={list.error} />;
  const d = list.data;
  return (
    <>
      <PageTitle
        title="Meetings"
        subtitle={d.am ? `Request a meeting with BMU. ${d.am.name}, your Client Manager, arranges it with the right people and confirms the time.` : "Your Client Manager will set up meetings with you."}
        action={d.am && !booking ? <Button onClick={() => setBooking(true)} data-testid="book-call">Request a meeting</Button> : undefined}
      />
      {error && <p className="mb-4 border border-red bg-red/10 px-3 py-2 text-sm">{error}</p>}
      {booking && <ClientRequestForm onDone={() => { setBooking(false); list.reload(); }} />}
      {!!d.requests.length && (
        <>
          <h2 className="mb-2 mt-6 font-semibold">Requested</h2>
          <div className="mb-8 border-t border-border">
            {d.requests.map((m) => (
              <ClientMeetingRow key={m.id} m={m} onCancel={() => window.confirm("Cancel this request?") && api.meetings.clientCancel(m.id).then(list.reload).catch((e: Error) => setError(e.message))} />
            ))}
          </div>
        </>
      )}
      <h2 className="mb-2 mt-6 font-semibold">Upcoming</h2>
      <div className="mb-8 border-t border-border">
        {d.upcoming.map((m) => (
          <ClientMeetingRow key={m.id} m={m} onCancel={() => window.confirm("Cancel this meeting?") && api.meetings.clientCancel(m.id).then(list.reload).catch((e: Error) => setError(e.message))} />
        ))}
        {!d.upcoming.length && <p className="py-6 text-center text-sm text-ink-muted">No meetings scheduled.</p>}
      </div>
      <h2 className="mb-2 font-semibold">Past calls</h2>
      <div className="border-t border-border">
        {d.past.map((m) => (
          <div key={m.id} className="border-b border-border py-3 text-sm">
            <p className="font-medium">
              {m.title} <span className="text-xs font-normal text-ink-muted">· {whenLabel(m.startAt)}</span>
            </p>
            {m.summary && <p className="mt-1 text-ink-muted">{m.summary}</p>}
            {!!m.actionItems.length && (
              <ul className="mt-1 list-disc pl-5 text-xs text-ink-muted">
                {m.actionItems.map((a, i) => (
                  <li key={i}>{a.text}</li>
                ))}
              </ul>
            )}
          </div>
        ))}
        {!d.past.length && <p className="py-6 text-center text-sm text-ink-muted">Nothing yet.</p>}
      </div>
    </>
  );
}

/** Next call card for the client home page. */
export function NextMeetingCard({ list }: { list: MeetingList & { am: { name: string } | null } }) {
  const next = list.upcoming[0];
  return (
    <div className="border border-border p-4 text-sm" data-testid="next-meeting">
      <p className="text-xs uppercase tracking-wide text-ink-muted">Next call</p>
      {next ? (
        <p className="mt-1 font-medium">
          {whenLabel(next.startAt)} with {next.host.name}
        </p>
      ) : (
        <p className="mt-1">No call booked.</p>
      )}
      <Link href="/client/meetings" className="mt-2 inline-block underline">
        {next ? "See meetings" : list.am ? `Request a meeting with ${list.am.name}` : "Meetings"}
      </Link>
    </div>
  );
}
