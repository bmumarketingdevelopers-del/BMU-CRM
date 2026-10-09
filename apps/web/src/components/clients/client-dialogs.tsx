"use client";

/**
 * Client 360 actions: Add service (also "+ New → Engagement"), Change tier, Edit client (field-level), Invite user,
 * Add brand/location, Set health, Pause service, Set gate (migrated services), Offboard client.
 * Each calls the API and reports back with onDone(message); the API re-checks every rule.
 */
import { useEffect, useMemo, useState } from "react";
import {
  CLIENT_TEAM_ROLES,
  CLIENTS_GATES,
  clientRoleLabels,
  clientsFieldLabels,
  clientsGateLabels,
  formatINR,
  TIERS,
  type ClientsDetail,
  type ClientsEdit,
  type ClientsFormOptions,
  type ClientsListRow,
  type ClientTeamRole,
} from "@bmu/shared";
import { api } from "@/lib/api";
import { ActionDialog, ActionDrawer, Field, inputCls, TextArea } from "@/components/actions/action-drawer";
import type { NewDrawerProps } from "@/components/actions/new-registry";

const thisMonth = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 7);
const today = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
const primary = "bg-charcoal px-4 py-2 text-sm font-medium text-ivory disabled:opacity-40";
const cancel = "ml-auto px-3 py-2 text-sm text-ink-muted hover:text-ink";

function Err({ error }: { error?: string }) {
  return error ? (
    <p role="alert" className="border border-red bg-red/10 px-3 py-2 text-sm">
      {error}
    </p>
  ) : null;
}

/** "+ New → Engagement" / Client 360 → Services → "+ Add service": sends a quote the client Owner approves and pays. */
export function AddServiceDrawer({ open, onClose, prefill, onSaved }: NewDrawerProps) {
  const [opts, setOpts] = useState<ClientsFormOptions>();
  const [clients, setClients] = useState<ClientsListRow[]>();
  const [clientId, setClientId] = useState(prefill?.clientId ?? "");
  const [serviceId, setServiceId] = useState("");
  const [tier, setTier] = useState<string>("starter");
  const [startMonth, setStartMonth] = useState(thisMonth());
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!open) return;
    api.clientsActions.formOptions().then(setOpts, (e: Error) => setError(e.message));
    if (!prefill?.clientId) api.clientsActions.list({}).then(setClients, () => setClients([]));
  }, [open, prefill?.clientId]);
  const service = opts?.services.find((s) => s.id === serviceId);
  const price = service?.tiers.find((t) => t.tier === tier)?.pricePaise ?? 0;
  const dueNow = service ? (service.billingType === "monthly" ? price : Math.round(price / 2)) : 0;
  async function save() {
    setError(undefined);
    if (!clientId) return setError("Pick the client");
    if (!serviceId) return setError("Pick a service");
    setSaving(true);
    try {
      const r = await api.clientsActions.quote(clientId, { kind: "add_service", serviceId, tier: tier as "starter", startMonth, note: note.trim() || undefined });
      onSaved(clientId, r.message);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <ActionDrawer open={open} title="Add a service" subtitle="The client's Owner approves the quote in their app and pays; the service then starts at Gate 1 with its own onboarding checklist." onClose={onClose} onSubmit={save} saving={saving} error={error} saveLabel="Send quote" testId="add-service-drawer">
      {!prefill?.clientId && (
        <Field label="Client" required htmlFor="as-client">
          <select id="as-client" className={inputCls} value={clientId} onChange={(e) => setClientId(e.target.value)}>
            <option value="">{clients ? "Pick a client…" : "Loading…"}</option>
            {(clients ?? []).filter((c) => !c.archivedAt && !c.offboarding).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label="Service" required htmlFor="as-service">
        <select id="as-service" className={inputCls} value={serviceId} onChange={(e) => { setServiceId(e.target.value); setTier(opts?.services.find((s) => s.id === e.target.value)?.tiers[0]?.tier ?? "starter"); }}>
          <option value="">{opts ? "Pick…" : "Loading…"}</option>
          {(opts?.services ?? []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Tier" required htmlFor="as-tier">
          <select id="as-tier" className={inputCls} value={tier} onChange={(e) => setTier(e.target.value)}>
            {(service?.tiers ?? []).map((t) => (
              <option key={t.tier} value={t.tier}>
                {t.tier} · {formatINR(t.pricePaise)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Start month" required htmlFor="as-month">
          <input id="as-month" type="month" className={inputCls} min={thisMonth()} value={startMonth} onChange={(e) => setStartMonth(e.target.value)} />
        </Field>
      </div>
      {service && (
        <p className="border border-border bg-canvas/60 px-3 py-2 text-sm">
          Billing: {service.billingType === "monthly" ? "monthly retainer, first month in advance" : "project, 50% now and 50% before handover"}. To pay now: <strong>{formatINR(dueNow)}</strong> + GST.
        </p>
      )}
      <Field label="Note for the client" htmlFor="as-note">
        <TextArea id="as-note" className="min-h-16" value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
    </ActionDrawer>
  );
}

export function ChangeTierDialog({ client, engagementId, open, onClose, onDone }: { client: ClientsDetail; engagementId: string; open: boolean; onClose: () => void; onDone: (m: string) => void }) {
  const e = client.services.find((s) => s.id === engagementId);
  const [tier, setTier] = useState<string>("");
  const [effective, setEffective] = useState<"next_cycle" | "now_prorata">("next_cycle");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const rank = (t: string) => TIERS.indexOf(t as (typeof TIERS)[number]);
  const upgrade = !!e && !!tier && rank(tier) > rank(e.tier);
  async function send() {
    setBusy(true);
    setError(undefined);
    try {
      const r = await api.clientsActions.quote(client.id, { kind: "change_tier", engagementId, tier: tier as "starter", effective: upgrade ? effective : "next_cycle" });
      onDone(r.message);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <ActionDialog open={open} title={`Change tier${e ? `: ${e.serviceName}` : ""}`} onClose={onClose} testId="change-tier-dialog" footer={<><button type="button" className={primary} disabled={busy || !tier} onClick={send}>Send quote</button><button type="button" className={cancel} onClick={onClose}>Cancel</button></>}>
      <p>Now on <strong className="capitalize">{e?.tier}</strong>. The client Owner approves the difference in their app.</p>
      <Field label="New tier" required htmlFor="ct-tier">
        <select id="ct-tier" className={inputCls} value={tier} onChange={(ev) => setTier(ev.target.value)}>
          <option value="">Pick…</option>
          {TIERS.filter((t) => t !== e?.tier).map((t) => (
            <option key={t} value={t}>
              {t} {rank(t) > rank(e?.tier ?? "starter") ? "(upgrade)" : "(downgrade)"}
            </option>
          ))}
        </select>
      </Field>
      {upgrade && e?.billingType === "monthly" && (
        <Field label="When">
          <select className={inputCls} aria-label="When" value={effective} onChange={(ev) => setEffective(ev.target.value as typeof effective)}>
            <option value="next_cycle">From the next cycle</option>
            <option value="now_prorata">Now, with a pro-rata charge for this month</option>
          </select>
        </Field>
      )}
      {!!tier && !upgrade && <p className="text-xs text-ink-muted">Downgrades apply from the next cycle. The AM Lead is told.</p>}
      <Err error={error} />
    </ActionDialog>
  );
}

export function EditClientDrawer({ client, open, onClose, onDone }: { client: ClientsDetail; open: boolean; onClose: () => void; onDone: (m: string, undo?: { token: string; label: string; expiresAt: string } | null) => void }) {
  const initial: Record<keyof ClientsEdit, string> = {
    businessName: client.name,
    industry: client.industry ?? "",
    branchId: client.branch?.id ?? "",
    contactName: client.contact.name ?? "",
    contactPhone: client.contact.phone ?? "",
    contactEmail: client.contact.email ?? "",
    billingName: client.billing.billingName ?? "",
    gstin: client.billing.gstin ?? "",
    billingAddress: client.billing.billingAddress ?? "",
    billingEmail: client.billing.billingEmail ?? "",
    placeOfSupply: client.billing.placeOfSupply ?? "",
  };
  const [v, setV] = useState(initial);
  const [branches, setBranches] = useState<{ id: string; name: string }[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const can = new Set(client.can.editFields);
  useEffect(() => {
    if (open && can.has("branchId")) api.clientsActions.formOptions().then((o) => setBranches(o.branches), () => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  async function save() {
    setError(undefined);
    const changed = (Object.keys(v) as (keyof ClientsEdit)[]).filter((k) => can.has(k) && v[k] !== initial[k]);
    if (!changed.length) return setError("Nothing changed");
    setSaving(true);
    try {
      const body = Object.fromEntries(changed.map((k) => [k, v[k].trim()])) as ClientsEdit;
      const r = await api.clientsActions.edit(client.id, body);
      onDone(`Saved: ${changed.map((k) => clientsFieldLabels[k].toLowerCase()).join(", ")}`, r.undo);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  const field = (k: keyof ClientsEdit, extra?: { type?: string; upper?: boolean }) => (
    <Field key={k} label={clientsFieldLabels[k]} htmlFor={`ec-${k}`} hint={can.has(k) ? undefined : "You can't change this"}>
      {k === "branchId" ? (
        <select id={`ec-${k}`} className={inputCls} value={v[k]} disabled={!can.has(k)} onChange={(e) => setV({ ...v, [k]: e.target.value })}>
          <option value="">{client.branch?.name ?? "Pick…"}</option>
          {branches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      ) : (
        <input id={`ec-${k}`} type={extra?.type ?? "text"} className={`${inputCls} ${extra?.upper ? "uppercase" : ""} disabled:bg-canvas disabled:text-ink-muted`} value={v[k]} disabled={!can.has(k)} onChange={(e) => setV({ ...v, [k]: extra?.upper ? e.target.value.toUpperCase() : e.target.value })} />
      )}
    </Field>
  );
  return (
    <ActionDrawer open={open} title={`Edit ${client.name}`} subtitle="You see the fields you are allowed to change. The account manager is told about changes." onClose={onClose} onSubmit={save} saving={saving} error={error} testId="edit-client-drawer">
      <h3 className="text-sm font-semibold">Business</h3>
      {field("businessName")}
      <div className="grid gap-4 sm:grid-cols-2">
        {field("industry")}
        {field("branchId")}
      </div>
      <h3 className="border-t border-border pt-3 text-sm font-semibold">Primary contact</h3>
      {field("contactName")}
      <div className="grid gap-4 sm:grid-cols-2">
        {field("contactPhone", { type: "tel" })}
        {field("contactEmail", { type: "email" })}
      </div>
      <h3 className="border-t border-border pt-3 text-sm font-semibold">Billing</h3>
      {field("billingName")}
      <div className="grid gap-4 sm:grid-cols-2">
        {field("gstin", { upper: true })}
        {field("placeOfSupply")}
      </div>
      {field("billingAddress")}
      {field("billingEmail", { type: "email" })}
    </ActionDrawer>
  );
}

export function InviteUserDrawer({ client, open, onClose, onDone }: { client: ClientsDetail; open: boolean; onClose: () => void; onDone: (m: string) => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [role, setRole] = useState<ClientTeamRole>("client_approver");
  const [scope, setScope] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  async function save() {
    setError(undefined);
    if (name.trim().length < 2) return setError("Enter their name");
    if (!email.trim() && !phone.trim()) return setError("Enter an email or a phone number");
    setSaving(true);
    try {
      const r = await api.clientsActions.invite(client.id, { name: name.trim(), email: email.trim(), phone: phone.trim(), role, brandScope: scope });
      onDone(r.message);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <ActionDrawer open={open} title="Invite a client user" subtitle={`Someone from ${client.name}. They get a welcome message and sign in with their email or mobile.`} onClose={onClose} onSubmit={save} saving={saving} error={error} saveLabel="Invite" testId="invite-user-drawer">
      <Field label="Name" required htmlFor="iu-name">
        <input id="iu-name" className={inputCls} value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Email" htmlFor="iu-email">
          <input id="iu-email" type="email" className={inputCls} value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Phone" htmlFor="iu-phone">
          <input id="iu-phone" type="tel" className={inputCls} value={phone} onChange={(e) => setPhone(e.target.value)} />
        </Field>
      </div>
      <Field label="Client role" required htmlFor="iu-role" hint={role === "client_owner" && client.users.some((u) => u.role === "client_owner") ? "A new Owner needs the existing Owner (or an Admin) to confirm." : clientRoleLabels[role].can}>
        <select id="iu-role" className={inputCls} value={role} onChange={(e) => setRole(e.target.value as ClientTeamRole)}>
          {CLIENT_TEAM_ROLES.map((r) => (
            <option key={r} value={r}>
              {clientRoleLabels[r].name}
            </option>
          ))}
        </select>
      </Field>
      {client.brands.length > 0 && (
        <Field label="Brands / locations they can see" hint="Leave all unticked for every brand">
          <div className="grid gap-1">
            {client.brands.map((b) => (
              <label key={b.id} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={scope.includes(b.id)} onChange={() => setScope((s) => (s.includes(b.id) ? s.filter((x) => x !== b.id) : [...s, b.id]))} />
                {b.name}
              </label>
            ))}
          </div>
        </Field>
      )}
    </ActionDrawer>
  );
}

export function BrandDialog({ open, onClose, onSave }: { open: boolean; onClose: () => void; onSave: (input: { name: string; address: string }) => Promise<string> }) {
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function save() {
    setBusy(true);
    setError(undefined);
    try {
      await onSave({ name: name.trim(), address: address.trim() });
      setName("");
      setAddress("");
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <ActionDialog open={open} title="Add a brand or location" onClose={onClose} testId="brand-dialog" footer={<><button type="button" className={primary} disabled={busy || name.trim().length < 2 || address.trim().length < 3} onClick={save}>Add</button><button type="button" className={cancel} onClick={onClose}>Cancel</button></>}>
      <Field label="Name" required htmlFor="bd-name">
        <input id="bd-name" className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Koramangala outlet" />
      </Field>
      <Field label="Address" required htmlFor="bd-addr">
        <TextArea id="bd-addr" className="min-h-16" value={address} onChange={(e) => setAddress(e.target.value)} />
      </Field>
      <Err error={error} />
    </ActionDialog>
  );
}

export function HealthDialog({ client, open, onClose, onDone }: { client: ClientsDetail; open: boolean; onClose: () => void; onDone: (m: string) => void }) {
  const [status, setStatus] = useState(client.health);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function save() {
    setBusy(true);
    setError(undefined);
    try {
      await api.clientsActions.health(client.id, { status, reason: reason.trim() });
      onDone("Client health updated");
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <ActionDialog open={open} title="Set client health" onClose={onClose} testId="health-dialog" footer={<><button type="button" className={primary} disabled={busy || reason.trim().length < 3} onClick={save}>Save</button><button type="button" className={cancel} onClick={onClose}>Cancel</button></>}>
      <div className="flex gap-2" role="radiogroup" aria-label="Health">
        {[["green", "Healthy"], ["amber", "Watch"], ["red", "At risk"]].map(([k, l]) => (
          <button key={k} type="button" role="radio" aria-checked={status === k} onClick={() => setStatus(k)} className={`flex-1 border px-3 py-2 text-sm ${status === k ? "border-charcoal bg-charcoal text-ivory" : "border-border"}`}>
            {l}
          </button>
        ))}
      </div>
      <Field label="Reason" required htmlFor="hd-reason">
        <TextArea id="hd-reason" className="min-h-16" value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <Err error={error} />
    </ActionDialog>
  );
}

export function PauseDialog({ service, open, onClose, onDone }: { service: ClientsDetail["services"][number]; open: boolean; onClose: () => void; onDone: (m: string) => void }) {
  const [reason, setReason] = useState("");
  const [until, setUntil] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function save() {
    setBusy(true);
    setError(undefined);
    try {
      const r = await api.clientsActions.pause(service.id, { reason: reason.trim(), until });
      onDone(r.message);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <ActionDialog open={open} title={`Pause ${service.serviceName}`} onClose={onClose} testId="pause-dialog" footer={<><button type="button" className={primary} disabled={busy || reason.trim().length < 3 || !until} onClick={save}>Pause</button><button type="button" className={cancel} onClick={onClose}>Cancel</button></>}>
      <p>Tasks go on hold, deadlines and the delivery clock stop, and no retainer invoice is raised for the paused months. Account Managers need the AM Lead&apos;s approval.</p>
      <Field label="Reason" required htmlFor="pd-reason">
        <TextArea id="pd-reason" className="min-h-16" value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <Field label="Pause until" required htmlFor="pd-until">
        <input id="pd-until" type="date" className={inputCls} min={today()} value={until} onChange={(e) => setUntil(e.target.value)} />
      </Field>
      <Err error={error} />
    </ActionDialog>
  );
}

export function SetGateDialog({ service, open, onClose, onDone }: { service: ClientsDetail["services"][number]; open: boolean; onClose: () => void; onDone: (m: string) => void }) {
  const [gate, setGate] = useState(service.currentGate);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function save() {
    setBusy(true);
    setError(undefined);
    try {
      const r = await api.clientsActions.setGate(service.id, { gate, reason: reason.trim() });
      onDone(r.message);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <ActionDialog open={open} title={`Set the gate: ${service.serviceName}`} onClose={onClose} testId="gate-dialog" footer={<><button type="button" className={primary} disabled={busy || reason.trim().length < 3 || gate === service.currentGate} onClick={save}>Save</button><button type="button" className={cancel} onClick={onClose}>Cancel</button></>}>
      <p>For migrated services only. Earlier gates are recorded as “migrated” approvals.</p>
      <Field label="Current gate" required htmlFor="sg-gate">
        <select id="sg-gate" className={inputCls} value={gate} onChange={(e) => setGate(e.target.value)}>
          {CLIENTS_GATES.map((g) => (
            <option key={g} value={g}>
              {clientsGateLabels[g]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Reason" required htmlFor="sg-reason">
        <input id="sg-reason" className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <Err error={error} />
    </ActionDialog>
  );
}

export function OffboardDialog({ client, open, onClose, onDone }: { client: ClientsDetail; open: boolean; onClose: () => void; onDone: (m: string) => void }) {
  const [reason, setReason] = useState("");
  const [lastCycle, setLastCycle] = useState(thisMonth());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const months = useMemo(() => {
    const out: string[] = [];
    const d = new Date();
    for (let i = 0; i < 4; i++) out.push(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + i, 1)).toISOString().slice(0, 7));
    return out;
  }, []);
  async function save() {
    setBusy(true);
    setError(undefined);
    try {
      const r = await api.clientsActions.offboard(client.id, { reason: reason.trim(), lastCycle });
      onDone(r.message);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <ActionDialog open={open} title={`Offboard ${client.name}`} onClose={onClose} testId="offboard-dialog" footer={<><button type="button" className={`${primary} bg-red`} disabled={busy || reason.trim().length < 3} onClick={save}>Start offboarding</button><button type="button" className={cancel} onClick={onClose}>Cancel</button></>}>
      <p>An Admin approves first. Then you work through the checklist (dues, final files, access, permissions, final report, pending work, contract) and the client confirms receipt. Their users keep read-only access for 90 days.</p>
      <Field label="Reason" required htmlFor="ob-reason">
        <TextArea id="ob-reason" className="min-h-16" value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <Field label="Last cycle" required htmlFor="ob-cycle">
        <select id="ob-cycle" className={inputCls} value={lastCycle} onChange={(e) => setLastCycle(e.target.value)}>
          {months.map((m) => (
            <option key={m} value={m}>
              {new Date(`${m}-01T12:00:00Z`).toLocaleString("en-IN", { month: "long", year: "numeric" })}
            </option>
          ))}
        </select>
      </Field>
      <Err error={error} />
    </ActionDialog>
  );
}
