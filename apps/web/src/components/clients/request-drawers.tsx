"use client";

/**
 * Request actions for the team (spec requests_approvals):
 * - RaiseRequestDrawer: "+ New → Request" and Client 360 "+ Add request": the AM raises a request on the client's behalf.
 * - ConvertToTasksDrawer: an approved (and paid) request → tasks, from a matching template when there is one.
 * - CustomQuoteDialog: a custom-priced add-on quote; above the limit it goes to a Branch Manager first.
 * - InternalApprovalDrawer: ask any colleague to approve something by a date ("+ New → Approval request").
 */
import { useEffect, useMemo, useState } from "react";
import { CLIENTS_ADDON_CUSTOM_LIMIT_PAISE, formatINR, REQUEST_TYPES, requestTypeLabels, rupeesToPaise, type ClientsConvertPreview, type CoreTaskFormOptions, type RequestType } from "@bmu/shared";
import { api } from "@/lib/api";
import { ActionDialog, ActionDrawer, Field, inputCls, TextArea } from "@/components/actions/action-drawer";
import type { NewDrawerProps } from "@/components/actions/new-registry";

const today = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);

export function RaiseRequestDrawer({ open, onClose, prefill, onSaved }: NewDrawerProps) {
  const [opts, setOpts] = useState<CoreTaskFormOptions>();
  const [clientId, setClientId] = useState(prefill?.clientId ?? "");
  const [pickedEngagement, setEngagementId] = useState(prefill?.engagementId ?? "");
  const [type, setType] = useState<RequestType>("change");
  const [description, setDescription] = useState("");
  const [neededBy, setNeededBy] = useState("");
  const [links, setLinks] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (open) api.coreTasks.formOptions().then(setOpts, (e: Error) => setError(e.message));
  }, [open]);
  const clients = useMemo(() => [...new Map((opts?.engagements ?? []).map((e) => [e.clientId, e.client])).entries()].sort((a, b) => a[1].localeCompare(b[1])), [opts]);
  const services = (opts?.engagements ?? []).filter((e) => e.clientId === clientId);
  // One service for the client: pick it for them.
  const engagementId = pickedEngagement || (services.length === 1 ? services[0].id : "");

  async function save() {
    setError(undefined);
    if (!engagementId) return setError("Pick the client and the service");
    if (description.trim().length < 5) return setError("Describe the request");
    setSaving(true);
    try {
      const r = await api.clientsActions.raiseRequest({ engagementId, type, description: description.trim(), neededBy: neededBy || undefined, links: links.split(/\s+/).filter(Boolean) });
      onSaved(r.id, r.message);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <ActionDrawer open={open} title="Raise a request" subtitle="For a client, on their behalf. They see it in their app and get a notification." onClose={onClose} onSubmit={save} saving={saving} error={error} saveLabel="Raise request" testId="raise-request-drawer">
      <Field label="Client" required htmlFor="rr-client">
        <select id="rr-client" className={inputCls} value={clientId} onChange={(e) => { setClientId(e.target.value); setEngagementId(""); }}>
          <option value="">{opts ? "Pick a client…" : "Loading…"}</option>
          {clients.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Service" required htmlFor="rr-service">
        <select id="rr-service" className={inputCls} value={engagementId} onChange={(e) => setEngagementId(e.target.value)} disabled={!clientId}>
          <option value="">Pick…</option>
          {services.map((s) => (
            <option key={s.id} value={s.id}>
              {s.service} · {s.gate}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Type" required htmlFor="rr-type" hint={requestTypeLabels[type].hint}>
        <select id="rr-type" className={inputCls} value={type} onChange={(e) => setType(e.target.value as RequestType)}>
          {REQUEST_TYPES.map((t) => (
            <option key={t} value={t}>
              {requestTypeLabels[t].team}
            </option>
          ))}
        </select>
      </Field>
      <Field label="What do they need?" required htmlFor="rr-desc">
        <TextArea id="rr-desc" value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Needed by" htmlFor="rr-needed">
          <input id="rr-needed" type="date" className={inputCls} min={today()} value={neededBy} onChange={(e) => setNeededBy(e.target.value)} />
        </Field>
        <Field label="Links (references, files)" htmlFor="rr-links" hint="Paste links separated by spaces">
          <input id="rr-links" className={inputCls} value={links} onChange={(e) => setLinks(e.target.value)} />
        </Field>
      </div>
    </ActionDrawer>
  );
}

export function ConvertToTasksDrawer({ requestId, open, onClose, onDone }: { requestId: string; open: boolean; onClose: () => void; onDone: (message: string) => void }) {
  const [p, setP] = useState<ClientsConvertPreview>();
  const [lines, setLines] = useState<ClientsConvertPreview["lines"]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!open) return;
    api.clientsActions.convertPreview(requestId).then(
      (r) => {
        setP(r);
        setLines(r.lines);
      },
      (e: Error) => setError(e.message),
    );
  }, [open, requestId]);
  async function save() {
    setError(undefined);
    const bad = lines.findIndex((l) => l.title.trim().length < 3 || !l.departmentId || !l.ownerId || !l.deadline);
    if (bad >= 0) return setError(`Task ${bad + 1}: add a title, department, owner and deadline`);
    setSaving(true);
    try {
      const r = await api.clientsActions.convert(requestId, { lines: lines.map((l) => ({ title: l.title.trim(), departmentId: l.departmentId!, ownerId: l.ownerId!, deadline: l.deadline })) });
      onDone(r.message);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  const upd = (i: number, patch: Partial<ClientsConvertPreview["lines"][number]>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  return (
    <ActionDrawer open={open} title="Convert to tasks" subtitle={p ? `${p.request.client}: ${p.request.description.slice(0, 90)}` : undefined} onClose={onClose} onSubmit={p?.blocked ? undefined : save} saving={saving} error={error ?? p?.blocked} saveLabel="Create tasks" wide testId="convert-drawer">
      {p?.template && <p className="border border-border bg-canvas/60 px-3 py-2 text-xs">Using the “{p.template.name}” template. Change anything before creating.</p>}
      {lines.map((l, i) => (
        <div key={i} className="grid gap-2 border border-border p-3" data-testid="convert-line">
          <input className={inputCls} aria-label={`Task ${i + 1} title`} value={l.title} onChange={(e) => upd(i, { title: e.target.value })} />
          <div className="grid gap-2 sm:grid-cols-3">
            <select className={inputCls} aria-label="Department" value={l.departmentId ?? ""} onChange={(e) => upd(i, { departmentId: e.target.value })}>
              <option value="">Department…</option>
              {(p?.departments ?? []).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
            <select className={inputCls} aria-label="Owner" value={l.ownerId ?? ""} onChange={(e) => upd(i, { ownerId: e.target.value })}>
              <option value="">Who does it…</option>
              {(p?.people ?? []).filter((x) => !l.departmentId || x.departmentId === l.departmentId || x.id === l.ownerId).map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
            <input type="date" className={inputCls} aria-label="Deadline" value={l.deadline} onChange={(e) => upd(i, { deadline: e.target.value })} />
          </div>
          {lines.length > 1 && (
            <button type="button" className="justify-self-start text-xs text-ink-muted underline" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
              Remove
            </button>
          )}
        </div>
      ))}
      {!p?.blocked && (
        <button type="button" className="border border-dashed border-border px-3 py-2 text-sm hover:border-ink" onClick={() => setLines((ls) => [...ls, { title: "", departmentId: ls[0]?.departmentId ?? null, ownerId: null, deadline: ls[0]?.deadline ?? today() }])}>
          + Add another task
        </button>
      )}
    </ActionDrawer>
  );
}

export function CustomQuoteDialog({ requestId, open, onClose, onDone }: { requestId: string; open: boolean; onClose: () => void; onDone: (message: string) => void }) {
  const [item, setItem] = useState("");
  const [amount, setAmount] = useState("");
  const [timeline, setTimeline] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const paise = rupeesToPaise(Number(amount) || 0);
  async function send() {
    setError(undefined);
    setBusy(true);
    try {
      const r = await api.clientsActions.customQuote(requestId, { item: item.trim(), amountPaise: paise, timeline: timeline.trim(), message: message.trim() || undefined });
      onDone(r.message);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <ActionDialog
      open={open}
      title="Custom quote"
      onClose={onClose}
      testId="custom-quote-dialog"
      footer={
        <>
          <button type="button" disabled={busy || !item.trim() || !paise || !timeline.trim()} onClick={send} className="bg-charcoal px-4 py-2 text-sm font-medium text-ivory disabled:opacity-40">
            {paise > CLIENTS_ADDON_CUSTOM_LIMIT_PAISE ? "Send to a Branch Manager for approval" : "Send quote"}
          </button>
          <button type="button" onClick={onClose} className="ml-auto px-3 py-2 text-sm text-ink-muted">
            Cancel
          </button>
        </>
      }
    >
      <Field label="Item" required htmlFor="cq-item">
        <input id="cq-item" className={inputCls} value={item} onChange={(e) => setItem(e.target.value)} placeholder="e.g. Festive landing page" />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Price (₹, before GST)" required htmlFor="cq-amount">
          <input id="cq-amount" className={inputCls} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="Timeline" required htmlFor="cq-time">
          <input id="cq-time" className={inputCls} value={timeline} onChange={(e) => setTimeline(e.target.value)} placeholder="e.g. 5 working days" />
        </Field>
      </div>
      <Field label="Message to the client" htmlFor="cq-msg">
        <TextArea id="cq-msg" className="min-h-16" value={message} onChange={(e) => setMessage(e.target.value)} />
      </Field>
      <p className="text-xs text-ink-muted">Custom prices above {formatINR(CLIENTS_ADDON_CUSTOM_LIMIT_PAISE)} need a Branch Manager&apos;s approval before the client sees them.</p>
      {error && <p className="border border-red bg-red/10 px-3 py-2 text-sm" role="alert">{error}</p>}
    </ActionDialog>
  );
}

export function InternalApprovalDrawer({ open, onClose, prefill, onSaved }: NewDrawerProps) {
  const [people, setPeople] = useState<{ id: string; name: string; roles: string[] }[]>();
  const [what, setWhat] = useState("");
  const [approverId, setApproverId] = useState("");
  const [byWhen, setByWhen] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (open) api.coreTasks.formOptions().then((o) => setPeople(o.people), (e: Error) => setError(e.message));
  }, [open]);
  async function save() {
    setError(undefined);
    if (what.trim().length < 5) return setError("Say what needs approving");
    if (!approverId) return setError("Pick who should approve");
    if (!byWhen) return setError("Pick by when");
    setSaving(true);
    try {
      const target = prefill?.requestId ? { targetType: "request" as const, targetId: prefill.requestId } : prefill?.clientId ? { targetType: "client" as const, targetId: prefill.clientId } : { targetType: "none" as const };
      const r = await api.clientsActions.internalApproval({ what: what.trim(), approverId, byWhen, ...target });
      onSaved(r.approval?.id, r.message);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <ActionDrawer open={open} title="Ask for approval" subtitle="Any colleague. It shows in their “Needs you” list; you see the answer in “What I asked for”." onClose={onClose} onSubmit={save} saving={saving} error={error} saveLabel="Send" testId="internal-approval-drawer">
      <Field label="What needs approving?" required htmlFor="ia-what">
        <TextArea id="ia-what" value={what} onChange={(e) => setWhat(e.target.value)} />
      </Field>
      <Field label="Approver" required htmlFor="ia-who">
        <select id="ia-who" className={inputCls} value={approverId} onChange={(e) => setApproverId(e.target.value)}>
          <option value="">{people ? "Pick…" : "Loading…"}</option>
          {(people ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="By when" required htmlFor="ia-when">
        <input id="ia-when" type="date" className={inputCls} min={today()} value={byWhen} onChange={(e) => setByWhen(e.target.value)} />
      </Field>
    </ActionDrawer>
  );
}
