"use client";

/** Start a discussion: a project thread (the client's team can see it), an internal one (only the people you add), or v53 a chat
 * with the client (they see it in Messages), on the clients you work on. */
import { useState } from "react";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { ActionDrawer, Field, inputCls } from "@/components/actions/action-drawer";
import { Chips, errMsg } from "./kit";

export function DiscussionDrawer({ open, onClose, onSaved, prefill }: { open: boolean; onClose: () => void; onSaved: (id: string, message: string) => void; prefill?: { clientId?: string; engagementId?: string } }) {
  const opts = useLoad(() => api.ops.threads.options());
  const [kind, setKind] = useState<"project" | "internal" | "client_staff">("project");
  const [clientOrgId, setClient] = useState(prefill?.clientId ?? "");
  const [engagementId, setEngagement] = useState(prefill?.engagementId ?? "");
  const [title, setTitle] = useState("");
  const [people, setPeople] = useState<string[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const client = opts.data?.clients.find((c) => c.id === clientOrgId);

  async function save() {
    const e: Record<string, string> = {};
    if (!clientOrgId) e.client = "Pick the client";
    if (kind !== "client_staff" && title.trim().length < 3) e.title = "Give the discussion a title";
    if (kind === "internal" && !people.length) e.people = "Add at least one person";
    setErrors(e);
    if (Object.keys(e).length) return;
    setSaving(true);
    setError(undefined);
    try {
      const r = await api.ops.threads.create({ kind, clientOrgId, engagementId: engagementId || undefined, title: kind === "client_staff" ? `Chat with ${client?.name ?? "the client"}` : title.trim(), participantIds: people });
      onSaved(r.id, r.message);
      setTitle("");
      setPeople([]);
      onClose();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <ActionDrawer open={open} title="Start a discussion" subtitle={kind === "project" ? "Team only: everyone at BMU working on this client can read and reply. The client does not see it." : kind === "client_staff" ? "The client sees your messages in their Messages and can reply. Their Client Manager can read it too." : "Only the people you add (and leadership) can see it."} onClose={onClose} onSubmit={save} saving={saving} error={error ?? opts.error} saveLabel="Start discussion" testId="discussion-drawer">
      <Field label="Type" required>
        <div className="flex gap-1" role="radiogroup" aria-label="Discussion type">
          {(["project", "internal", "client_staff"] as const).map((k) => (
            <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => setKind(k)} className={`border px-3 py-1.5 text-sm ${kind === k ? "border-charcoal bg-charcoal text-ivory" : "border-border"}`}>
              {k === "project" ? "Project (team)" : k === "internal" ? "Internal (people you add)" : "Talk to the client"}
            </button>
          ))}
        </div>
      </Field>
      <Field label="Client" required error={errors.client}>
        <select className={inputCls} value={clientOrgId} onChange={(e) => (setClient(e.target.value), setEngagement(""))} aria-label="Client">
          <option value="">{opts.loading ? "Loading…" : "Pick a client…"}</option>
          {opts.data?.clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </Field>
      {client && client.engagements.length > 0 && (
        <Field label="Project">
          <select className={inputCls} value={engagementId} onChange={(e) => setEngagement(e.target.value)} aria-label="Project">
            <option value="">The whole account</option>
            {client.engagements.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      {kind === "client_staff" ? (
        <p className="text-xs text-ink-muted">Only clients you work on are listed. If you already have a chat with this client, it opens.</p>
      ) : (
        <Field label="Title" required error={errors.title}>
          <input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Title" maxLength={160} />
        </Field>
      )}
      {kind === "internal" && (
        <Field label="People" required error={errors.people}>
          <Chips label="People" options={(opts.data?.people ?? []).map((p) => ({ id: p.id, label: p.name }))} value={people} onChange={setPeople} />
        </Field>
      )}
    </ActionDrawer>
  );
}
