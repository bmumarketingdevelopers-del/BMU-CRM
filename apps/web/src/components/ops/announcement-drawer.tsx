"use client";

/** "+ New → Announcement" (Founder / Admin): to all clients, a client segment, all team or one department; in-app and/or email. */
import { useState } from "react";
import { OPS_AUDIENCES, opsAudienceLabels, type OpsAnnouncementInput } from "@bmu/shared";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { ActionDrawer, Field, inputCls, TextArea } from "@/components/actions/action-drawer";
import type { NewDrawerProps } from "@/components/actions/new-registry";
import { errMsg } from "./kit";

type Audience = OpsAnnouncementInput["audience"];

export function AnnouncementDrawer({ open, onClose, onSaved }: NewDrawerProps) {
  const opts = useLoad(() => api.ops.announcements.options());
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [audience, setAudience] = useState<Audience>("all_team");
  const [segment, setSegment] = useState("");
  const [channels, setChannels] = useState<("in_app" | "email")[]>(["in_app"]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const o = opts.data;
  const countKey = audience === "department" ? `department:${segment}` : audience === "segment" ? segment : audience;
  const count = o?.counts[countKey];

  async function save() {
    setError(undefined);
    const e: Record<string, string> = {};
    if (title.trim().length < 3) e.title = "Give it a title";
    if (body.trim().length < 5) e.body = "Write the message";
    if ((audience === "segment" || audience === "department") && !segment) e.segment = audience === "segment" ? "Pick the client segment" : "Pick the department";
    if (!channels.length) e.channels = "Pick at least one channel";
    setErrors(e);
    if (Object.keys(e).length) return;
    if (!window.confirm(`Send "${title.trim()}" to ${count ?? "everyone in this audience"} ${count === 1 ? "person" : "people"}? This can't be undone.`)) return;
    setSaving(true);
    try {
      const r = await api.ops.announcements.send({ title: title.trim(), body: body.trim(), audience, segment: segment || undefined, channels });
      onSaved(r.id, r.message);
      setTitle("");
      setBody("");
      onClose();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <ActionDrawer open={open} title="New announcement" subtitle="Shows as a notice in the app; email goes through the outbox." onClose={onClose} onSubmit={save} saving={saving} error={error ?? opts.error} saveLabel="Send announcement" testId="announcement-drawer">
      <Field label="Audience" required>
        <select className={inputCls} value={audience} onChange={(e) => (setAudience(e.target.value as Audience), setSegment(""))} aria-label="Audience">
          {OPS_AUDIENCES.map((a) => (
            <option key={a} value={a}>
              {opsAudienceLabels[a]}
            </option>
          ))}
        </select>
      </Field>
      {audience === "segment" && (
        <Field label="Segment" required error={errors.segment}>
          <select className={inputCls} value={segment} onChange={(e) => setSegment(e.target.value)} aria-label="Segment">
            <option value="">Pick a segment…</option>
            <optgroup label="Clients with this service">
              {o?.services.map((s) => (
                <option key={s.key} value={`service:${s.key}`}>
                  {s.name} ({o.counts[`service:${s.key}`] ?? 0})
                </option>
              ))}
            </optgroup>
            <optgroup label="Client health">
              {["green", "amber", "red"].map((h) => (
                <option key={h} value={`health:${h}`}>
                  Health {h} ({o?.counts[`health:${h}`] ?? 0})
                </option>
              ))}
            </optgroup>
          </select>
        </Field>
      )}
      {audience === "department" && (
        <Field label="Department" required error={errors.segment}>
          <select className={inputCls} value={segment} onChange={(e) => setSegment(e.target.value)} aria-label="Department">
            <option value="">Pick a department…</option>
            {o?.departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} ({o.counts[`department:${d.id}`] ?? 0})
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label="Title" required error={errors.title}>
        <input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Title" maxLength={160} />
      </Field>
      <Field label="Message" required error={errors.body}>
        <TextArea value={body} onChange={(e) => setBody(e.target.value)} aria-label="Message" maxLength={4000} rows={6} />
      </Field>
      <Field label="Channels" required error={errors.channels}>
        <div className="flex gap-4 text-sm">
          {(["in_app", "email"] as const).map((c) => (
            <label key={c} className="inline-flex items-center gap-2">
              <input type="checkbox" className="accent-[#8BB72C]" checked={channels.includes(c)} onChange={(e) => setChannels((cs) => (e.target.checked ? [...cs, c] : cs.filter((x) => x !== c)))} />
              {c === "in_app" ? "In-app notice" : "Email"}
            </label>
          ))}
        </div>
      </Field>
      {count !== undefined && <p className="text-sm">Goes to <strong>{count}</strong> {count === 1 ? "person" : "people"}.</p>}
    </ActionDrawer>
  );
}
