"use client";

// v20 anomaly alerts: watch a metric (for the company, every client, or one client) and notify people when it moves.
import { useState } from "react";
import { ALERT_CONDITIONS, METRICS, alertConditionLabels, describeAlert, metricAlertSchema, roleLabel, type MetricAlertInput, type MetricAlertView } from "@bmu/shared";
import { Panel } from "@/components/dash";
import { Badge, Button, Input, LoadState, PageTitle, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

const when = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
const ROLE_CHOICES = ["founder", "admin", "finance", "am_lead", "account_manager", "department_head", "sales_manager", "producer"];
const blank: MetricAlertInput = { name: "", metricKey: "client_activity", scope: "org", clientOrgId: null, condition: "drop_pct", threshold: 30, windowDays: 7, roles: ["founder"], userIds: [], active: true };

export default function AlertsPage() {
  const data = useLoad(() => api.intelligence.alerts());
  const clients = useLoad(() => api.clients.list().catch(() => []), { live: false });
  const [editing, setEditing] = useState<{ id?: string; form: MetricAlertInput }>();
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();
  const [checking, setChecking] = useState(false);

  async function check() {
    setChecking(true);
    setMsg(undefined);
    try {
      const r = await api.intelligence.checkAlerts();
      setMsg({ ok: true, text: r.fired.length ? `${r.fired.length} alert${r.fired.length === 1 ? "" : "s"} fired: ${r.fired.map((f) => f.message).join("; ")}` : "Checked. Nothing to alert on right now." });
      data.reload();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setChecking(false);
    }
  }

  const d = data.data;
  return (
    <>
      <PageTitle
        title="Alerts"
        subtitle="BMU Hub checks these every morning and tells the right people when a number moves. Small numbers are ignored so one quiet day doesn't page anyone."
        action={
          d?.canEdit ? (
            <div className="flex gap-2">
              <Button variant="secondary" disabled={checking} onClick={check}>
                {checking ? "Checking…" : "Check now"}
              </Button>
              <Button onClick={() => setEditing({ form: { ...blank } })}>New alert</Button>
            </div>
          ) : undefined
        }
      />
      {msg && <p className={`mb-4 border px-3 py-2 text-sm ${msg.ok ? "border-border bg-surface-raised" : "border-red bg-red/10"}`}>{msg.text}</p>}
      <LoadState loading={data.loading && !d} error={data.error} />
      {editing && (
        <AlertForm
          initial={editing.form}
          id={editing.id}
          clients={(clients.data ?? []).map((c) => ({ id: c.id, name: c.name }))}
          onClose={() => setEditing(undefined)}
          onSaved={() => (setEditing(undefined), data.reload())}
        />
      )}
      {d && (
        <div className="grid gap-6">
          <Panel title="Watching" flush>
            <ul className="divide-y divide-border">
              {d.alerts.map((a) => (
                <AlertRow key={a.id} a={a} canEdit={d.canEdit} onEdit={() => setEditing({ id: a.id, form: toInput(a) })} onChange={data.reload} />
              ))}
              {!d.alerts.length && <li className="px-4 py-6 text-center text-sm text-ink-muted">No alerts yet.</li>}
            </ul>
          </Panel>
          <Panel title="Recently fired" flush>
            <ul className="divide-y divide-border text-sm">
              {d.events.map((e) => (
                <li key={e.id} className="px-4 py-2.5">
                  {e.message}
                  <span className="block text-xs text-ink-muted">
                    {e.alertName} · {when.format(new Date(e.createdAt))}
                  </span>
                </li>
              ))}
              {!d.events.length && <li className="px-4 py-6 text-center text-ink-muted">Nothing has fired yet.</li>}
            </ul>
          </Panel>
        </div>
      )}
    </>
  );
}

const toInput = (a: MetricAlertView): MetricAlertInput => ({ name: a.name, metricKey: a.metricKey, scope: a.scope, clientOrgId: a.clientOrgId, condition: a.condition, threshold: a.threshold, windowDays: a.windowDays, roles: a.roles, userIds: a.userIds, active: a.active });

function AlertRow({ a, canEdit, onEdit, onChange }: { a: MetricAlertView; canEdit: boolean; onEdit: () => void; onChange: () => void }) {
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 px-4 py-3 text-sm">
      <div className="min-w-0">
        <span className="font-medium">{a.name}</span> {a.builtIn && <Badge>Built in</Badge>} {!a.active && <Badge>Off</Badge>}
        <p className="text-ink-muted">{a.summary}</p>
        <p className="text-xs text-ink-muted">
          Tells {a.roles.map(roleLabel).join(", ") || "chosen people"}
          {a.lastCheckedAt ? ` · last checked ${when.format(new Date(a.lastCheckedAt))}` : ""}
          {a.lastFiredAt ? ` · last fired ${when.format(new Date(a.lastFiredAt))}` : ""}
        </p>
      </div>
      {canEdit && (
        <div className="flex gap-2">
          <Button variant="ghost" className="px-3 py-1.5" onClick={() => void api.intelligence.updateAlert(a.id, { active: !a.active }).then(onChange)}>
            {a.active ? "Turn off" : "Turn on"}
          </Button>
          <Button variant="secondary" className="px-3 py-1.5" onClick={onEdit}>
            Edit
          </Button>
          {!a.builtIn && (
            <Button
              variant="ghost"
              className="px-3 py-1.5"
              onClick={() => {
                if (confirm(`Delete the alert "${a.name}"?`)) void api.intelligence.removeAlert(a.id).then(onChange);
              }}
            >
              Delete
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

function AlertForm({ initial, id, clients, onClose, onSaved }: { initial: MetricAlertInput; id?: string; clients: { id: string; name: string }[]; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState<MetricAlertInput>(initial);
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const def = METRICS.find((m) => m.key === f.metricKey);
  const pct = f.condition === "drop_pct" || f.condition === "rise_pct";
  const client = clients.find((c) => c.id === f.clientOrgId)?.name;

  async function save() {
    const parsed = metricAlertSchema.safeParse(f);
    if (!parsed.success) return setErr(parsed.error.issues[0]?.message);
    setBusy(true);
    setErr(undefined);
    try {
      if (id) await api.intelligence.updateAlert(id, f);
      else await api.intelligence.createAlert(f);
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title={id ? "Edit alert" : "New alert"} className="mb-6">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-sm">
          Name
          <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Sunrise goes quiet" />
        </label>
        <label className="grid gap-1 text-sm">
          Number to watch
          <Select value={f.metricKey} onChange={(e) => setF({ ...f, metricKey: e.target.value, scope: METRICS.find((m) => m.key === e.target.value)?.clientScoped ? f.scope : "org" })}>
            {METRICS.map((m) => (
              <option key={m.key} value={m.key}>
                {m.label}
              </option>
            ))}
          </Select>
        </label>
        <label className="grid gap-1 text-sm">
          For
          <Select value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value as MetricAlertInput["scope"] })}>
            <option value="org">The whole company</option>
            {def?.clientScoped && <option value="each_client">Each client separately</option>}
            {def?.clientScoped && <option value="client">One client</option>}
          </Select>
        </label>
        {f.scope === "client" && (
          <label className="grid gap-1 text-sm">
            Client
            <Select value={f.clientOrgId ?? ""} onChange={(e) => setF({ ...f, clientOrgId: e.target.value || null })}>
              <option value="">Choose…</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </label>
        )}
        <label className="grid gap-1 text-sm">
          When it
          <Select value={f.condition} onChange={(e) => setF({ ...f, condition: e.target.value as MetricAlertInput["condition"] })}>
            {ALERT_CONDITIONS.map((c) => (
              <option key={c} value={c}>
                {alertConditionLabels[c]}
              </option>
            ))}
          </Select>
        </label>
        <label className="grid gap-1 text-sm">
          {pct ? "Percent" : def?.unit === "paise" ? "Amount in ₹" : "Value"}
          <Input
            type="number"
            min={0}
            value={def?.unit === "paise" && !pct ? f.threshold / 100 : f.threshold}
            onChange={(e) => setF({ ...f, threshold: def?.unit === "paise" && !pct ? Math.round(Number(e.target.value) * 100) : Number(e.target.value) })}
          />
        </label>
        {pct && (
          <label className="grid gap-1 text-sm">
            Compare the last … days with the days before
            <Input type="number" min={1} max={90} value={f.windowDays} onChange={(e) => setF({ ...f, windowDays: Number(e.target.value) })} />
          </label>
        )}
        <fieldset className="grid gap-1 text-sm sm:col-span-2">
          <legend className="mb-1">Tell</legend>
          <div className="grid gap-1 sm:grid-cols-4">
            {ROLE_CHOICES.map((r) => (
              <label key={r} className="flex items-center gap-2">
                <input type="checkbox" className="size-4 accent-[#8BB72C]" checked={(f.roles ?? []).includes(r)} onChange={() => setF({ ...f, roles: (f.roles ?? []).includes(r) ? (f.roles ?? []).filter((x) => x !== r) : [...(f.roles ?? []), r] })} />
                {r.replaceAll("_", " ")}
              </label>
            ))}
          </div>
        </fieldset>
      </div>
      <p className="mt-3 text-sm text-ink-muted">{describeAlert({ metricKey: f.metricKey, scope: f.scope ?? "org", condition: f.condition, threshold: f.threshold, windowDays: f.windowDays ?? 7 }, client)}</p>
      {err && <p className="mt-2 text-sm text-red">{err}</p>}
      <div className="mt-4 flex gap-2">
        <Button disabled={busy} onClick={save}>
          {busy ? "Saving…" : "Save alert"}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </Panel>
  );
}
