"use client";

/** "+ New → Note / Meeting": a note, call or meeting (with reminder) on a client's record (Manager workspace notes), or on a lead (sales). */
import { useState } from "react";
import { canOpenCraftManager, opsCanAddLead } from "@bmu/shared";
import { api } from "@/lib/api";
import { useActionsMaybe } from "./actions-provider";
import { useLoad } from "@/lib/use-load";
import { ActionDrawer, Field, TextArea, inputCls } from "./action-drawer";
import type { NewDrawerProps } from "./new-registry";

export function ClientNoteDrawer({ open, onClose, prefill, onSaved, kind: initial }: NewDrawerProps & { kind: "note" | "meeting" | "call" }) {
  const me = useActionsMaybe()?.me;
  const forClients = !me || canOpenCraftManager(me);
  const forLeads = !!me && opsCanAddLead(me);
  const [about, setAbout] = useState<"client" | "lead">(prefill?.leadId || !forClients ? "lead" : "client");
  const opts = useLoad(() => (forClients ? api.coreTasks.formOptions() : Promise.resolve({ engagements: [] as { clientId: string; client: string }[] })));
  const leads = useLoad(() => (forLeads ? api.leads.list() : Promise.resolve([])));
  const [leadId, setLeadId] = useState(prefill?.leadId ?? "");
  const [kind, setKind] = useState(initial);
  const [clientId, setClientId] = useState(prefill?.clientId ?? "");
  const [body, setBody] = useState("");
  const [remindAt, setRemindAt] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const clients = [...new Map((opts.data?.engagements ?? []).map((e) => [e.clientId, e.client])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  async function save() {
    setError(undefined);
    if (about === "client" && !clientId) return setError("Pick the client");
    if (about === "lead" && !leadId) return setError("Pick the lead");
    if (body.trim().length < 2) return setError("Write a short note");
    if (kind === "meeting" && !remindAt) return setError("Pick when the meeting is");
    setSaving(true);
    try {
      if (about === "lead") {
        const r = await api.ops.leads.note(leadId, { kind: kind === "meeting" ? "meeting" : "note", body: kind === "call" ? `Call: ${body.trim()}` : body.trim(), at: remindAt ? new Date(remindAt).toISOString() : undefined });
        onSaved(leadId, r.message);
        onClose();
        return;
      }
      const n = await api.craftManager.addClientNote(clientId, { kind, body: body.trim(), remindAt: remindAt ? new Date(remindAt).toISOString() : null });
      onSaved(n.id, kind === "meeting" ? "Meeting saved with a reminder" : kind === "call" ? "Call logged" : "Note added");
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <ActionDrawer open={open} title={kind === "meeting" ? "New meeting" : kind === "call" ? "Log a call" : "New note"} subtitle={about === "lead" ? "Saved on the lead's history; meetings remind the lead owner." : "Saved on the client's record and shown in Client 360 and the Manager workspace."} onClose={onClose} onSubmit={save} saving={saving} error={error ?? opts.error ?? leads.error} testId="client-note-drawer">
      <Field label="Type" required>
        <select className={inputCls} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} aria-label="Type">
          <option value="note">Note</option>
          <option value="call">Call</option>
          <option value="meeting">Meeting</option>
        </select>
      </Field>
      {forClients && forLeads && (
        <Field label="About" required>
          <select className={inputCls} value={about} onChange={(e) => setAbout(e.target.value as "client" | "lead")} aria-label="About">
            <option value="client">A client</option>
            <option value="lead">A lead</option>
          </select>
        </Field>
      )}
      {about === "lead" ? (
        <Field label="Lead" required>
          <select className={inputCls} value={leadId} onChange={(e) => setLeadId(e.target.value)} aria-label="Lead">
            <option value="">{leads.loading ? "Loading…" : "Pick a lead…"}</option>
            {(leads.data ?? []).filter((l) => !["won", "lost"].includes(l.stage) || l.id === leadId).map((l) => (
              <option key={l.id} value={l.id}>
                {l.contact.company ? `${l.contact.company} · ${l.contact.name}` : l.contact.name}
              </option>
            ))}
          </select>
        </Field>
      ) : (
      <Field label="Client" required>
        <select className={inputCls} value={clientId} onChange={(e) => setClientId(e.target.value)} aria-label="Client">
          <option value="">{opts.loading ? "Loading…" : "Pick a client…"}</option>
          {clients.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
      </Field>
      )}
      <Field label={kind === "meeting" ? "Agenda" : "Note"} required>
        <TextArea value={body} onChange={(e) => setBody(e.target.value)} maxLength={2000} aria-label="Note" />
      </Field>
      {kind === "meeting" && (
        <Field label="When" required hint="You get a reminder in Today on the Manager workspace.">
          <input className={inputCls} type="datetime-local" value={remindAt} onChange={(e) => setRemindAt(e.target.value)} aria-label="Meeting time" />
        </Field>
      )}
    </ActionDrawer>
  );
}
