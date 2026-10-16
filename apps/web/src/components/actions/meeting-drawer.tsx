"use client";

/**
 * "+ New → Meeting": a real meeting (the same one the Meetings page adds), with a Google Meet link when the host's
 * Google Calendar is connected, team members invited and the client's people invited. It shows on Meetings with its
 * details and link. Without Google Calendar the host can paste a link, which is sent to everyone in the meeting.
 * v24: for a client meeting the Client Manager can bring in one or more departments and/or a Founder; they confirm
 * the time first (accept or ask for another time the same day) and the meeting is fixed once they all accept.
 */
import Link from "next/link";
import { useState } from "react";
import { canOpenCraftManager, opsCanAddLead } from "@bmu/shared";
import { PeoplePicker } from "@/components/comms/meetings";
import { ApproverPicker } from "@/components/comms/meeting-requests";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { ActionDrawer, Field, TextArea, inputCls } from "./action-drawer";
import { useActionsMaybe } from "./actions-provider";
import type { NewDrawerProps } from "./new-registry";

const LENGTHS = [15, 30, 45, 60, 90, 120];
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());

export function MeetingDrawer({ open, onClose, prefill, onSaved }: NewDrawerProps) {
  const me = useActionsMaybe()?.me;
  const forClients = !me || canOpenCraftManager(me);
  const forLeads = !!me && opsCanAddLead(me);
  const clients = useLoad(() => (forClients ? api.clients.list().catch(() => []) : Promise.resolve([])), { live: false });
  const leads = useLoad(() => (forLeads ? api.leads.list() : Promise.resolve([])), { live: false });
  const google = useLoad(() => api.meetings.google().catch(() => undefined), { live: false });
  const approvers = useLoad(() => api.meetings.arrangeOptions().catch(() => undefined), { live: false });
  const [departmentIds, setDepartmentIds] = useState<string[]>([]);
  const [founderId, setFounderId] = useState("");
  const [about, setAbout] = useState<"client" | "lead" | "internal">(prefill?.leadId ? "lead" : forClients ? "client" : forLeads ? "lead" : "internal");
  const [clientId, setClientId] = useState(prefill?.clientId ?? "");
  const [leadId, setLeadId] = useState(prefill?.leadId ?? "");
  const [title, setTitle] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("11:00");
  const [duration, setDuration] = useState(30);
  const [agenda, setAgenda] = useState("");
  const [attendeeIds, setAttendeeIds] = useState<string[]>([]);
  const [meet, setMeet] = useState(true);
  const [link, setLink] = useState("");
  const [location, setLocation] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [connecting, setConnecting] = useState(false);

  const g = google.data;
  const canMeet = !!g?.connected;
  const useMeet = canMeet && meet;
  const clientName = clients.data?.find((c) => c.id === clientId)?.name;

  async function save() {
    setError(undefined);
    if (about === "client" && !clientId) return setError("Pick the client");
    if (about === "lead" && !leadId) return setError("Pick the lead");
    if (!date) return setError("Pick the date");
    const startAt = new Date(`${date}T${time}:00+05:30`);
    if (startAt.getTime() < Date.now()) return setError("Pick a time in the future");
    const pasted = link.trim();
    if (!useMeet && pasted && !/^https:\/\/\S+$/i.test(pasted)) return setError("Paste the full meeting link, starting with https://");
    const name = title.trim() || (about === "client" && clientName ? `${clientName} meeting` : "");
    const confirmFirst = about === "client" && (departmentIds.length > 0 || !!founderId);
    if (name.length < 2) return setError("Give the meeting a title");
    setSaving(true);
    try {
      let m = await api.meetings.create({
        title: name,
        startAt: startAt.toISOString(),
        durationMin: duration,
        clientOrgId: about === "client" ? clientId : null,
        leadId: about === "lead" ? leadId : null,
        agenda: agenda.trim() || undefined,
        location: location.trim() || undefined,
        attendeeIds,
        addMeet: useMeet,
        departmentIds: about === "client" ? departmentIds : undefined,
        founderId: about === "client" ? founderId || null : undefined,
      });
      if (confirmFirst) {
        const asked = m.participants.filter((p) => p.status === "pending").map((p) => p.name);
        onSaved(m.id, `Meeting proposed. Waiting for ${asked.join(" and ") || "their answer"} to confirm the time; it is fixed (with the link) once they accept.`);
        onClose();
        return;
      }
      // No Google Meet: the pasted link becomes the meeting link and goes to everyone invited.
      if (!m.joinUrl && pasted) m = await api.meetings.shareLink(m.id, pasted);
      const invited = m.participants.length + m.attendees.length;
      const linkNote = m.joinUrl ? (m.google?.synced ? "with a Google Meet link" : "with your meeting link") : m.google?.error && useMeet ? `without a Meet link (${m.google.error})` : "without a link yet: send one from Meetings";
      onSaved(m.id, `Meeting added to Meetings ${linkNote}.${invited ? ` ${invited} ${invited === 1 ? "person" : "people"} invited.` : ""}`);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const connect = () => {
    setConnecting(true);
    api.meetings
      .googleConnect()
      .then((r) => window.location.assign(r.url))
      .catch((e: Error) => {
        setError(e.message);
        setConnecting(false);
      });
  };

  return (
    <ActionDrawer
      open={open}
      title="New meeting"
      subtitle={
        <>
          Shows on{" "}
          <Link href="/team/meetings" className="underline">
            Meetings
          </Link>{" "}
          with its details and link. Everyone invited is told.
        </>
      }
      onClose={onClose}
      onSubmit={save}
      saving={saving}
      error={error ?? clients.error ?? leads.error}
      testId="meeting-drawer"
    >
      <Field label="With" required>
        <select className={inputCls} value={about} onChange={(e) => setAbout(e.target.value as typeof about)} aria-label="Meeting with">
          {forClients && <option value="client">A client</option>}
          {forLeads && <option value="lead">A lead</option>}
          <option value="internal">Team only (internal)</option>
        </select>
      </Field>
      {about === "client" && (
        <Field label="Client" required hint="The client's people with a portal login are invited too.">
          <select className={inputCls} value={clientId} onChange={(e) => setClientId(e.target.value)} aria-label="Client">
            <option value="">{clients.loading ? "Loading…" : "Pick a client…"}</option>
            {(clients.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      {about === "lead" && (
        <Field label="Lead" required hint="The lead is invited by email and the meeting is logged on the lead.">
          <select className={inputCls} value={leadId} onChange={(e) => setLeadId(e.target.value)} aria-label="Lead">
            <option value="">{leads.loading ? "Loading…" : "Pick a lead…"}</option>
            {(leads.data ?? []).filter((l) => !["won", "lost"].includes(l.stage) || l.id === leadId).map((l) => (
              <option key={l.id} value={l.id}>
                {l.contact.company ? `${l.contact.company} · ${l.contact.name}` : l.contact.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label="Title" required={about !== "client"} hint={about === "client" ? `Leave empty for "${clientName ? `${clientName} meeting` : "<client> meeting"}".` : undefined}>
        <input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={160} placeholder="e.g. Website checkout review" aria-label="Meeting title" />
      </Field>
      <Field label="When (India time, IST)" required>
        <div className="flex flex-wrap gap-2">
          <input className={inputCls} type="date" min={today()} value={date} onChange={(e) => setDate(e.target.value)} aria-label="Date" />
          <input className={inputCls} type="time" value={time} onChange={(e) => setTime(e.target.value)} aria-label="Time" />
          <select className={inputCls} value={duration} onChange={(e) => setDuration(Number(e.target.value))} aria-label="Length">
            {LENGTHS.map((d) => (
              <option key={d} value={d}>
                {d < 60 ? `${d} min` : `${d / 60} hour${d > 60 ? "s" : ""}`}
              </option>
            ))}
          </select>
        </div>
      </Field>
      <Field label="Agenda">
        <TextArea value={agenda} onChange={(e) => setAgenda(e.target.value)} maxLength={1000} placeholder="What the meeting is about" aria-label="Agenda" />
      </Field>
      {about === "client" && approvers.data && (
        <Field label="Who confirms the time" hint="Optional. Department Heads and the Founder accept or ask for another time the same day; the meeting is fixed once they all accept. Each Department Head then adds their team members working on this client's projects.">
          <ApproverPicker options={approvers.data} departmentIds={departmentIds} onDepartments={setDepartmentIds} founderId={founderId} onFounder={setFounderId} />
        </Field>
      )}
      <Field label="Invite team members">
        <PeoplePicker value={attendeeIds} onChange={setAttendeeIds} />
      </Field>
      <Field label="Meeting link">
        {google.loading ? (
          <p className="text-xs text-ink-muted">Checking Google Calendar…</p>
        ) : canMeet ? (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={meet} onChange={(e) => setMeet(e.target.checked)} data-testid="drawer-add-meet" />
            Create a Google Meet link <span className="text-xs text-ink-muted">(in {g?.email}; Google sends the invitations)</span>
          </label>
        ) : (
          <div className="space-y-2 text-xs text-ink-muted">
            {g?.available ? (
              <p>
                Connect your Google Calendar to create Google Meet links automatically.{" "}
                <button type="button" className="underline" disabled={connecting} onClick={connect} data-testid="drawer-google-connect">
                  {connecting ? "Opening Google…" : "Connect Google Calendar"}
                </button>{" "}
                (this leaves the form)
              </p>
            ) : (
              <p>Google Calendar is not set up on the server yet. Paste a link instead.</p>
            )}
          </div>
        )}
        {!useMeet && <input className={`${inputCls} mt-2`} value={link} onChange={(e) => setLink(e.target.value)} placeholder="Paste a link (optional), e.g. https://meet.google.com/abc-defg-hij" aria-label="Meeting link" />}
      </Field>
      <Field label="Where (optional)">
        <input className={inputCls} value={location} onChange={(e) => setLocation(e.target.value)} maxLength={300} placeholder="Office address, if in person" aria-label="Location" />
      </Field>
    </ActionDrawer>
  );
}
