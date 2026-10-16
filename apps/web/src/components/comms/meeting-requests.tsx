"use client";

// v23 meeting requests: the client asks for a meeting (date, time in any time zone, length, what it is about), the
// Client Manager brings in a department and/or the Founder, they accept or ask for another time the same day, the
// Client Manager fixes it, and the Department Head adds team members while the Branch Manager joins or ignores.
// v23 Google Meet: when the Client Manager has connected Google Calendar, fixing the meeting creates the Meet link and
// Google sends the invitations; pasting a link by hand stays as the fallback.
import { useState } from "react";
import {
  MEETING_PARTICIPANT_ROLE_LABELS,
  meetingResponseLabels,
  timeZoneList,
  zonedDay,
  zonedLabel,
  zonedTimeToUtc,
  type MeetingArrangeOptions,
  type MeetingParticipantView,
  type MeetingView,
} from "@bmu/shared";
import { Badge, Button, Card, Input, LoadState, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

const IST_ZONE = "Asia/Kolkata";
const DURATIONS = [15, 30, 45, 60, 90, 120];
const browserZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || IST_ZONE;
  } catch {
    return IST_ZONE;
  }
};
/** "Mon, 20 Oct, 3:30 pm IST" plus the client's own time when they are elsewhere. */
export const teamTime = (iso: string, zone: string) => `${zonedLabel(iso, IST_ZONE)} IST${zone !== IST_ZONE ? ` · client: ${zonedLabel(iso, zone)} (${zone})` : ""}`;
const hhmm = (iso: string, zone: string) => new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));

const STATUS_LABEL: Record<MeetingParticipantView["status"], string> = {
  pending: "Waiting for answer",
  accepted: "Accepted",
  reschedule: "Asked for another time",
  invited: "Invited",
  joined: "Joining",
  ignored: "Not joining",
};
const STATUS_TONE: Record<MeetingParticipantView["status"], "neutral" | "green" | "amber" | "red"> = {
  pending: "amber",
  accepted: "green",
  reschedule: "amber",
  invited: "neutral",
  joined: "green",
  ignored: "neutral",
};

function useRun() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; error: boolean }>();
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    setMsg(undefined);
    try {
      await fn();
      if (ok) setMsg({ text: ok, error: false });
    } catch (e) {
      setMsg({ text: (e as Error).message, error: true });
    } finally {
      setBusy(false);
    }
  };
  const note = msg && <p className={`text-xs ${msg.error ? "text-red" : "text-ink-muted"}`}>{msg.text}</p>;
  return { busy, run, note };
}

export function ParticipantList({ m, team }: { m: MeetingView; team: boolean }) {
  if (!m.participants.length) return null;
  return (
    <ul className="mt-2 space-y-1 text-xs" data-testid="meeting-participants">
      {m.participants.map((p) => (
        <li key={p.userId} className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{p.name}</span>
          <span className="text-ink-muted">
            {MEETING_PARTICIPANT_ROLE_LABELS[p.role]}
            {p.department ? `, ${p.department.name}` : ""}
            {team && p.addedBy && p.role !== "department_head" && p.role !== "founder" ? ` · added by ${p.addedBy}` : ""}
          </span>
          {team && <Badge tone={STATUS_TONE[p.status]}>{STATUS_LABEL[p.status]}</Badge>}
          {team && p.proposedStartAt && <span className="text-ink-muted">suggests {zonedLabel(p.proposedStartAt, IST_ZONE)} IST</span>}
          {team && p.note && <span className="text-ink-muted">“{p.note}”</span>}
          {p.googleResponse && p.googleResponse !== "needsAction" && <span className={`text-ink-muted ${p.googleResponse === "accepted" ? "text-green" : p.googleResponse === "declined" ? "text-red" : ""}`}>Google Calendar: {meetingResponseLabels[p.googleResponse]}</span>}
        </li>
      ))}
    </ul>
  );
}

/**
 * Opens the call in a new tab (Google Meet works in any browser, no Google account needed). The host joins through
 * Google's account chooser with the organiser account picked, so Google opens the call as the Meet host.
 */
export function JoinButton({ url, as }: { url: string; as?: string | null }) {
  const href = as ? `https://accounts.google.com/AccountChooser?${new URLSearchParams({ Email: as, continue: `${url}${url.includes("?") ? "&" : "?"}authuser=${encodeURIComponent(as)}` })}` : url;
  return (
    <span className="inline-flex flex-col items-start">
      <a href={href} target="_blank" rel="noopener noreferrer" className="inline-block bg-green px-3 py-1.5 text-sm font-semibold text-charcoal hover:opacity-90" data-testid="join-link">
        {/^https:\/\/meet\.google\.com\//i.test(url) ? "Join Google Meet" : "Join meeting"}
      </a>
      {as && <span className="mt-0.5 text-[11px] text-ink-muted" data-testid="join-as">as {as} (host)</span>}
    </span>
  );
}

function JoinLine({ m }: { m: MeetingView }) {
  if (m.status !== "booked") return null;
  return m.joinUrl ? (
    <JoinButton url={m.joinUrl} as={m.joinAs} />
  ) : (
    <span className="text-xs text-ink-muted">Your meeting is scheduled. The link will be shared before the call.</span>
  );
}

// ------------------------------------------------------------------------------------------------ client

/** The client asks for a meeting: date, time in their time zone, length and what it is about. */
export function ClientRequestForm({ onDone }: { onDone: () => void }) {
  const [zone, setZone] = useState(browserZone);
  const [date, setDate] = useState("");
  const [time, setTime] = useState("11:00");
  const [duration, setDuration] = useState(30);
  const [requirements, setRequirements] = useState("");
  const { busy, run, note } = useRun();
  const zones = timeZoneList();
  let iso: string | null = null;
  try {
    iso = date && time ? zonedTimeToUtc(date, time, zone) : null;
  } catch {
    iso = null;
  }
  return (
    <Card className="mb-6">
      <h2 className="mb-1 font-semibold">Request a meeting</h2>
      <p className="mb-3 text-xs text-ink-muted">Pick a time in your own time zone. Your Client Manager arranges it with the right people at BMU and confirms.</p>
      <div className="space-y-3 text-sm">
        <div className="flex flex-wrap gap-2">
          <label className="block">
            <span className="text-xs font-medium">Date</span>
            <Input type="date" value={date} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setDate(e.target.value)} aria-label="Meeting date" />
          </label>
          <label className="block">
            <span className="text-xs font-medium">Time</span>
            <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} aria-label="Meeting time" />
          </label>
          <label className="block">
            <span className="text-xs font-medium">Length</span>
            <Select value={duration} onChange={(e) => setDuration(Number(e.target.value))} aria-label="Meeting length">
              {DURATIONS.map((d) => (
                <option key={d} value={d}>
                  {d < 60 ? `${d} min` : `${d / 60} hour${d > 60 ? "s" : ""}`}
                </option>
              ))}
            </Select>
          </label>
        </div>
        <label className="block">
          <span className="text-xs font-medium">Your time zone</span>
          <Select className="w-full" value={zone} onChange={(e) => setZone(e.target.value)} aria-label="Time zone">
            {zones.map((z) => (
              <option key={z} value={z}>
                {z.replace(/_/g, " ")}
              </option>
            ))}
          </Select>
        </label>
        {iso && zone !== IST_ZONE && <p className="text-xs text-ink-muted">That is {zonedLabel(iso, IST_ZONE)} in India (IST).</p>}
        <label className="block">
          <span className="text-xs font-medium">What do you need from this meeting?</span>
          <textarea
            className="mt-1 h-28 w-full border border-border bg-surface-raised p-2"
            value={requirements}
            onChange={(e) => setRequirements(e.target.value)}
            placeholder="e.g. We want to discuss changes to the website checkout and a new landing page for Diwali."
            aria-label="Meeting requirements"
          />
        </label>
        {note}
        <div className="flex gap-2">
          <Button
            disabled={busy || !iso || requirements.trim().length < 10}
            data-testid="send-meeting-request"
            onClick={() =>
              iso &&
              run(async () => {
                await api.meetings.clientRequest({ startAt: iso, timeZone: zone, durationMin: duration, requirements: requirements.trim() });
                onDone();
              })
            }
          >
            Send request
          </Button>
          <Button variant="ghost" onClick={onDone}>
            Close
          </Button>
        </div>
      </div>
    </Card>
  );
}

/** One of the client's meetings, in their own time zone. */
export function ClientMeetingRow({ m, onCancel }: { m: MeetingView; onCancel?: () => void }) {
  const open = m.status === "requested" || m.status === "awaiting";
  return (
    <div className="border-b border-border py-3 text-sm" data-testid="client-meeting-row">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium">
            {zonedLabel(m.startAt, m.timeZone)} <span className="text-xs font-normal text-ink-muted">({m.timeZone.replace(/_/g, " ")}) · {m.durationMin} min · with {m.host.name}</span>
          </p>
          {m.agenda && <p className="mt-1 text-ink-muted">{m.agenda}</p>}
          {open && <p className="mt-1 text-xs text-ink-muted">{m.status === "requested" ? "Your Client Manager is arranging this meeting." : "Your Client Manager is confirming the time with the team."}</p>}
          {m.status === "booked" && m.rescheduledAt && <p className="mt-1 text-xs">We are sorry: this meeting had to move to the time above.</p>}
          <div className="mt-1">
            <JoinLine m={m} />
          </div>
          <ParticipantList m={m} team={false} />
        </div>
        <div className="flex items-center gap-2">
          {open ? <Badge tone="amber">Requested</Badge> : m.status === "booked" ? <Badge tone="green">Scheduled</Badge> : null}
          {m.can.cancel && onCancel && (
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ team

/** A request on the team's Meetings page with the actions this person can take. */
export function TeamRequestCard({ m, onChanged }: { m: MeetingView; onChanged: () => void }) {
  return (
    <div className="border-b border-border py-3 text-sm" data-testid="meeting-request">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium">
            {m.client?.name ?? m.title}
            {m.bookedVia === "founder" && <span className="ml-2 text-xs font-normal text-ink-muted">asked by a Founder</span>}
          </p>
          <p className="text-xs text-ink-muted">
            {teamTime(m.startAt, m.timeZone)} · {m.durationMin} min · Client Manager: {m.host.name}
            {m.departments.length ? ` · ${m.departments.map((d) => d.name).join(", ")}` : ""}
          </p>
          {m.agenda && <p className="mt-1">{m.agenda}</p>}
          <ParticipantList m={m} team />
        </div>
        <Badge tone="amber">{m.status === "requested" ? "To arrange" : "Waiting for answers"}</Badge>
      </div>
      {m.can.respond && <RespondPanel m={m} onChanged={onChanged} />}
      {m.can.arrange && <ArrangePanel m={m} onChanged={onChanged} />}
    </div>
  );
}

/** Department Head / Founder: accept, or ask for another time the same day. */
function RespondPanel({ m, onChanged }: { m: MeetingView; onChanged: () => void }) {
  const [time, setTime] = useState(hhmm(m.startAt, IST_ZONE));
  const [noteText, setNoteText] = useState("");
  const { busy, run, note } = useRun();
  const day = zonedDay(m.startAt, IST_ZONE);
  return (
    <div className="mt-3 space-y-2 border border-border bg-canvas/30 p-3" data-testid="respond-panel">
      <p className="text-xs font-medium">Can you (and your team) make {zonedLabel(m.startAt, IST_ZONE)} IST?</p>
      <Input value={noteText} onChange={(e) => setNoteText(e.target.value)} placeholder="Note for the Client Manager (optional)" aria-label="Note" />
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={busy} data-testid="accept-meeting" onClick={() => run(() => api.meetings.respond(m.id, { decision: "accept", note: noteText || undefined }).then(onChanged))}>
          Accept
        </Button>
        <span className="text-xs text-ink-muted">or another time that day (IST):</span>
        <Input className="w-28" type="time" value={time} onChange={(e) => setTime(e.target.value)} aria-label="New time" />
        <Button
          variant="secondary"
          disabled={busy}
          data-testid="ask-reschedule"
          onClick={() => run(() => api.meetings.respond(m.id, { decision: "reschedule", proposedStartAt: zonedTimeToUtc(day, time, IST_ZONE), note: noteText || undefined }).then(onChanged))}
        >
          Ask to reschedule
        </Button>
      </div>
      {note}
    </div>
  );
}

/**
 * v24: who confirms a meeting's time: one or more departments (each Department Head confirms, then adds their team
 * members working on the client's projects) and/or a Founder.
 */
export function ApproverPicker({ options, departmentIds, onDepartments, founderId, onFounder }: { options: MeetingArrangeOptions; departmentIds: string[]; onDepartments: (ids: string[]) => void; founderId: string; onFounder: (id: string) => void }) {
  return (
    <div className="space-y-2" data-testid="approver-picker">
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {options.departments.map((d) => (
          <label key={d.id} className={`flex items-center gap-1.5 text-sm ${d.head ? "" : "text-ink-muted"}`}>
            <input
              type="checkbox"
              disabled={!d.head}
              checked={departmentIds.includes(d.id)}
              onChange={(e) => onDepartments(e.target.checked ? [...departmentIds, d.id] : departmentIds.filter((x) => x !== d.id))}
              aria-label={`Department ${d.name}`}
            />
            {d.name} <span className="text-xs text-ink-muted">{d.head ? `(head: ${d.head.name})` : "(no head yet)"}</span>
          </label>
        ))}
      </div>
      <Select value={founderId} onChange={(e) => onFounder(e.target.value)} aria-label="Founder">
        <option value="">No Founder</option>
        {options.founders.map((f) => (
          <option key={f.id} value={f.id}>
            Founder: {f.name}
          </option>
        ))}
      </Select>
    </div>
  );
}

/** Client Manager: bring in one or more departments and/or the Founder, then fix the meeting. */
function ArrangePanel({ m, onChanged }: { m: MeetingView; onChanged: () => void }) {
  const opts = useLoad<MeetingArrangeOptions>(() => api.meetings.arrangeOptions(), { live: false });
  const [departmentIds, setDepartmentIds] = useState<string[]>(m.departments.map((d) => d.id));
  const [founderId, setFounderId] = useState(m.participants.find((p) => p.role === "founder")?.userId ?? "");
  const proposed = m.participants.find((p) => p.status === "reschedule" && p.proposedStartAt)?.proposedStartAt ?? null;
  const [date, setDate] = useState(zonedDay(proposed ?? m.startAt, IST_ZONE));
  const [time, setTime] = useState(hhmm(proposed ?? m.startAt, IST_ZONE));
  const { busy, run, note } = useRun();
  if (!opts.data) return <LoadState loading={opts.loading} error={opts.error} />;
  const newStart = zonedTimeToUtc(date, time, IST_ZONE);
  const moved = newStart !== new Date(m.startAt).toISOString();
  const waiting = m.participants.filter((p) => (p.role === "founder" || p.role === "department_head") && p.status === "pending");
  return (
    <div className="mt-3 space-y-3 border border-border bg-canvas/30 p-3" data-testid="arrange-panel">
      <div>
        <p className="mb-1 text-xs font-medium">1. Who else needs to be in it? Pick one or more departments (each Department Head confirms the time) and/or the Founder.</p>
        <ApproverPicker options={opts.data} departmentIds={departmentIds} onDepartments={setDepartmentIds} founderId={founderId} onFounder={setFounderId} />
        <Button
          className="mt-2"
          variant="secondary"
          disabled={busy || (!departmentIds.length && !founderId)}
          data-testid="send-for-confirmation"
          onClick={() => run(() => api.meetings.arrange(m.id, { departmentIds, founderId: founderId || null }).then(onChanged), "Sent. They are asked to accept or suggest another time the same day.")}
        >
          Send for confirmation
        </Button>
      </div>
      <div>
        <p className="mb-1 text-xs font-medium">2. Fix the meeting{waiting.length ? ` (waiting for ${waiting.map((w) => w.name).join(" and ")})` : ""}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Fixed date (IST)" />
          <Input className="w-28" type="time" value={time} onChange={(e) => setTime(e.target.value)} aria-label="Fixed time (IST)" />
          <span className="text-xs text-ink-muted">IST</span>
          <Button disabled={busy || waiting.length > 0} data-testid="fix-meeting" onClick={() => run(() => api.meetings.fix(m.id, { startAt: moved ? newStart : undefined }).then(onChanged))}>
            {moved ? "Fix at new time" : "Fix meeting"}
          </Button>
        </div>
        {moved && <p className="mt-1 text-xs text-ink-muted">The client gets an apology with the new time ({zonedLabel(newStart, m.timeZone)} their time).</p>}
        <p className="mt-1 text-xs text-ink-muted">Once it is fixed, the Google Meet link is created and Google sends the invitations (when your Google Calendar is connected). Otherwise you send a meeting link to everyone in one click.</p>
      </div>
      {note}
    </div>
  );
}

/**
 * Actions on a fixed meeting: the Branch Manager joins or ignores; the Department Head adds team members; the Client
 * Manager or the client's Branch Manager adds another branch's Branch Manager.
 */
export function FixedMeetingActions({ m, onChanged }: { m: MeetingView; onChanged: () => void }) {
  const [adding, setAdding] = useState(false);
  const [addingBm, setAddingBm] = useState(false);
  const { busy, run, note } = useRun();
  const mine = m.participants.find((p) => p.role === "branch_manager" && m.can.join);
  return (
    <div className="mb-3 space-y-2">
      {m.can.shareLink && <ShareLink m={m} onChanged={onChanged} />}
      {!m.joinUrl && <JoinLine m={m} />}
      <ParticipantList m={m} team />
      {m.can.join && mine && (
        <div className="flex flex-wrap items-center gap-2" data-testid="branch-join">
          <span className="text-xs">Meeting with client {m.client?.name ?? ""}: join now?</span>
          <Button disabled={busy || mine.status === "joined"} onClick={() => run(() => api.meetings.joinOrIgnore(m.id, "join").then(onChanged))}>
            {mine.status === "joined" ? "Joining" : "Accept and join"}
          </Button>
          <Button variant="ghost" disabled={busy || mine.status === "ignored"} onClick={() => run(() => api.meetings.joinOrIgnore(m.id, "ignore").then(onChanged))}>
            {mine.status === "ignored" ? "Ignored" : "Ignore"}
          </Button>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {m.can.addMembers && !adding && (
          <Button variant="secondary" onClick={() => setAdding(true)} data-testid="add-members">
            Add team members
          </Button>
        )}
        {m.can.addBranchManagers && !addingBm && (
          <Button variant="secondary" onClick={() => setAddingBm(true)} data-testid="add-branch-managers">
            Add Branch Manager
          </Button>
        )}
      </div>
      {m.can.addMembers && adding && <AddMembers m={m} onDone={() => { setAdding(false); onChanged(); }} />}
      {m.can.addBranchManagers && addingBm && <AddBranchManagers m={m} onDone={() => { setAddingBm(false); onChanged(); }} />}
      {note}
    </div>
  );
}

/** Client Manager: paste the Google Meet link once and send it to the client and everyone in the meeting. */
function ShareLink({ m, onChanged }: { m: MeetingView; onChanged: () => void }) {
  const [url, setUrl] = useState(m.joinUrl ?? "");
  const { busy, run, note } = useRun();
  const who = [
    m.client?.name ?? "the client",
    ...m.participants.filter((p) => p.status !== "ignored").map((p) => `${p.name} (${MEETING_PARTICIPANT_ROLE_LABELS[p.role]})`),
  ];
  return (
    <div className="space-y-2 border border-border bg-canvas/30 p-3" data-testid="share-link">
      <p className="text-xs font-medium">
        {m.google?.synced ? "Google Meet link created and invitations sent by Google Calendar. Paste a different link only to replace it." : m.joinUrl ? "Meeting link sent. Change it and send again if needed." : "Everyone has accepted. Send the meeting link."}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Input className="min-w-64 flex-1" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://meet.google.com/abc-defg-hij" aria-label="Meeting link" />
        <Button
          disabled={busy || !url.trim() || url.trim() === m.joinUrl}
          data-testid="send-link"
          onClick={() => run(() => api.meetings.shareLink(m.id, url.trim()).then(onChanged), "Link sent to everyone.")}
        >
          {m.joinUrl ? "Send updated link" : "Send link to everyone"}
        </Button>
      </div>
      <p className="text-xs text-ink-muted">Goes to: {who.join(", ")}.</p>
      {note}
    </div>
  );
}

function AddMembers({ m, onDone }: { m: MeetingView; onDone: () => void }) {
  const people = useLoad(() => api.meetings.memberOptions(m.id), { live: false });
  const [picked, setPicked] = useState<string[]>([]);
  const { busy, run, note } = useRun();
  if (!people.data) return <LoadState loading={people.loading} error={people.error} />;
  return (
    <div className="space-y-2 border border-border p-3 text-sm">
      <p className="text-xs text-ink-muted">{m.client ? `People in your department working on ${m.client.name}'s projects.` : "People in your department."}</p>
      {!people.data.length && <p className="text-xs text-ink-muted">{m.client ? `Nobody else in your department has work on ${m.client.name}'s projects, or they are already in this meeting.` : "Everyone in your department is already in this meeting."}</p>}
      {people.data.map((p) => (
        <label key={p.id} className="flex items-center gap-2">
          <input type="checkbox" checked={picked.includes(p.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, p.id] : picked.filter((x) => x !== p.id))} /> {p.name}
          <span className="text-xs text-ink-muted">{[p.department, p.why].filter(Boolean).join(" · ")}</span>
        </label>
      ))}
      <div className="flex gap-2">
        <Button disabled={busy || !picked.length} onClick={() => run(() => api.meetings.addMembers(m.id, picked).then(onDone))}>
          Add {picked.length || ""}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Close
        </Button>
      </div>
      {note}
    </div>
  );
}

/** v24: the Client Manager or the client's Branch Manager adds another branch's Branch Manager (they join or ignore). */
function AddBranchManagers({ m, onDone }: { m: MeetingView; onDone: () => void }) {
  const people = useLoad(() => api.meetings.branchManagerOptions(m.id), { live: false });
  const [picked, setPicked] = useState<string[]>([]);
  const { busy, run, note } = useRun();
  if (!people.data) return <LoadState loading={people.loading} error={people.error} />;
  return (
    <div className="space-y-2 border border-border p-3 text-sm" data-testid="branch-manager-picker">
      <p className="text-xs text-ink-muted">Branch Managers of other branches. They are told and can join or ignore.</p>
      {!people.data.length && <p className="text-xs text-ink-muted">Every Branch Manager is already in this meeting.</p>}
      {people.data.map((p) => (
        <label key={p.id} className="flex items-center gap-2">
          <input type="checkbox" checked={picked.includes(p.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, p.id] : picked.filter((x) => x !== p.id))} /> {p.name}
          {p.branch && <span className="text-xs text-ink-muted">{p.branch}</span>}
        </label>
      ))}
      <div className="flex gap-2">
        <Button disabled={busy || !picked.length} onClick={() => run(() => api.meetings.addBranchManagers(m.id, picked).then(onDone))}>
          Add {picked.length || ""}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Close
        </Button>
      </div>
      {note}
    </div>
  );
}

/** Founder: ask a client's Client Manager to arrange a meeting (Founders meet clients through their Client Manager). */
export function FounderMeetingRequest({ onSaved }: { onSaved: () => void }) {
  const clients = useLoad(() => api.clients.list().catch(() => []), { live: false });
  const [clientOrgId, setClientOrgId] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("11:00");
  const [duration, setDuration] = useState(30);
  const [requirements, setRequirements] = useState("");
  const { busy, run, note } = useRun();
  return (
    <Card>
      <h2 className="mb-1 font-semibold">Meet a client</h2>
      <p className="mb-3 text-xs text-ink-muted">Goes to the client&apos;s Client Manager, who agrees the time with the client and fixes it.</p>
      <div className="space-y-2 text-sm">
        <Select className="w-full" value={clientOrgId} onChange={(e) => setClientOrgId(e.target.value)} aria-label="Client">
          <option value="">Pick a client</option>
          {clients.data?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        <div className="flex gap-2">
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Suggested date" />
          <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} aria-label="Suggested time (IST)" />
          <Select value={duration} onChange={(e) => setDuration(Number(e.target.value))} aria-label="Length">
            {DURATIONS.map((d) => (
              <option key={d} value={d}>
                {d} min
              </option>
            ))}
          </Select>
        </div>
        <textarea className="h-20 w-full border border-border bg-surface-raised p-2" value={requirements} onChange={(e) => setRequirements(e.target.value)} placeholder="What is the meeting about?" aria-label="What is the meeting about" />
        {note}
        <Button
          disabled={busy || !clientOrgId || !date || requirements.trim().length < 10}
          onClick={() =>
            run(async () => {
              await api.meetings.founderRequest({ clientOrgId, startAt: zonedTimeToUtc(date, time, IST_ZONE), durationMin: duration, requirements: requirements.trim() });
              setRequirements("");
              onSaved();
            }, "Sent to the Client Manager.")
          }
        >
          Ask the Client Manager
        </Button>
      </div>
    </Card>
  );
}
