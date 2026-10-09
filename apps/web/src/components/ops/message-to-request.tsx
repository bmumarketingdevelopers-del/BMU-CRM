"use client";

/** Message ⋯ → "Create request": turns a client message into a request on one of the client's services (SLA from settings). */
import { useState } from "react";
import { OPS_REQUEST_TYPES, requestTypeLabels } from "@bmu/shared";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { ActionDrawer, Field, inputCls, TextArea } from "@/components/actions/action-drawer";
import { errMsg } from "./kit";

type ReqType = (typeof OPS_REQUEST_TYPES)[number];

export function MessageToRequestDrawer({ message, clientId, onClose, onDone }: { message: { id: string; body: string }; clientId: string; onClose: () => void; onDone: (message: string, href: string) => void }) {
  const opts = useLoad(() => api.ops.threads.options());
  const engagements = opts.data?.clients.find((c) => c.id === clientId)?.engagements ?? [];
  const [engagementId, setEngagement] = useState("");
  const [type, setType] = useState<ReqType>("change");
  const [description, setDescription] = useState(message.body);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const eng = engagementId || (engagements.length === 1 ? engagements[0].id : "");

  async function save() {
    const e: Record<string, string> = {};
    if (!eng) e.engagement = "Pick the service the request is for";
    if (description.trim().length < 5) e.description = "Describe the request";
    setErrors(e);
    if (Object.keys(e).length) return;
    setSaving(true);
    setError(undefined);
    try {
      const r = await api.ops.threads.toRequest({ messageId: message.id, engagementId: eng, type, description: description.trim() });
      onDone(r.message, r.href);
      onClose();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <ActionDrawer open title="Create request from message" subtitle="Logged as the client's request with the usual response time. The client sees it in Requests." onClose={onClose} onSubmit={save} saving={saving} error={error ?? opts.error} saveLabel="Create request" testId="message-request-drawer">
      <Field label="Service" required error={errors.engagement}>
        <select className={inputCls} value={eng} onChange={(e) => setEngagement(e.target.value)} aria-label="Service">
          <option value="">{opts.loading ? "Loading…" : engagements.length ? "Pick a service…" : "This client has no active service"}</option>
          {engagements.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Type" required hint={requestTypeLabels[type].hint}>
        <select className={inputCls} value={type} onChange={(e) => setType(e.target.value as ReqType)} aria-label="Request type">
          {OPS_REQUEST_TYPES.map((t) => (
            <option key={t} value={t}>
              {requestTypeLabels[t].team}
            </option>
          ))}
        </select>
      </Field>
      <Field label="What they need" required error={errors.description}>
        <TextArea value={description} onChange={(e) => setDescription(e.target.value)} aria-label="What they need" rows={5} maxLength={4000} />
      </Field>
    </ActionDrawer>
  );
}
