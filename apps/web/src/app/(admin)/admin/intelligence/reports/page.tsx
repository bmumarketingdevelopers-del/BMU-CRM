"use client";

// v20 scheduled reports: chosen numbers or a dashboard, sent as a PDF by email on a schedule.
import { useState } from "react";
import { REPORT_CADENCES, describeSchedule, scheduledReportSchema, type ScheduledReportInput, type ScheduledReportView } from "@bmu/shared";
import { Panel } from "@/components/dash";
import { Badge, Button, Input, LoadState, PageTitle, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

const when = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const blank: ScheduledReportInput = { name: "Monday numbers", kind: "metrics", dashboardId: null, metricKeys: ["mrr", "win_rate", "on_time_pct", "overdue_tasks"], cadence: "weekly", dayOfWeek: 1, dayOfMonth: 1, hourIst: 9, recipients: [], active: true };

export default function ReportsPage() {
  const data = useLoad(() => api.intelligence.reports());
  const [editing, setEditing] = useState<{ id?: string; form: ScheduledReportInput }>();
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();
  const d = data.data;
  return (
    <>
      <PageTitle title="Scheduled Reports" subtitle="A PDF of the numbers you choose, emailed on a schedule. Each person only gets numbers the report's creator is allowed to see." action={<Button onClick={() => setEditing({ form: { ...blank } })}>New report</Button>} />
      {msg && <p className={`mb-4 border px-3 py-2 text-sm ${msg.ok ? "border-border bg-surface-raised" : "border-red bg-red/10"}`}>{msg.text}</p>}
      <LoadState loading={data.loading && !d} error={data.error} />
      {editing && d && <ReportForm id={editing.id} initial={editing.form} metrics={d.metrics} dashboards={d.dashboards} onClose={() => setEditing(undefined)} onSaved={() => (setEditing(undefined), data.reload())} />}
      {d && (
        <Panel flush>
          <ul className="divide-y divide-border">
            {d.reports.map((r) => (
              <Row key={r.id} r={r} onEdit={() => setEditing({ id: r.id, form: toInput(r) })} onChange={data.reload} setMsg={setMsg} />
            ))}
            {!d.reports.length && <li className="px-4 py-6 text-center text-sm text-ink-muted">No scheduled reports yet.</li>}
          </ul>
        </Panel>
      )}
    </>
  );
}

const toInput = (r: ScheduledReportView): ScheduledReportInput => ({ name: r.name, kind: r.kind, dashboardId: r.dashboardId, metricKeys: r.metricKeys, cadence: r.cadence, dayOfWeek: r.dayOfWeek, dayOfMonth: r.dayOfMonth, hourIst: r.hourIst, recipients: r.recipients, active: r.active });

function Row({ r, onEdit, onChange, setMsg }: { r: ScheduledReportView; onEdit: () => void; onChange: () => void; setMsg: (m: { ok: boolean; text: string }) => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 px-4 py-3 text-sm">
      <div className="min-w-0">
        <span className="font-medium">{r.name}</span> {!r.active && <Badge>Paused</Badge>}
        <p className="text-ink-muted">
          {r.schedule} · {r.kind === "dashboard" ? `Dashboard: ${r.dashboardName ?? "—"}` : `${r.metricKeys.length} numbers`} · to {r.recipients.join(", ")}
        </p>
        <p className="text-xs text-ink-muted">
          Next {when.format(new Date(r.nextRunAt))}
          {r.lastSentAt ? ` · last sent ${when.format(new Date(r.lastSentAt))}` : ""}
        </p>
        {r.lastError && <p className="text-xs text-red">Last send failed: {r.lastError}</p>}
      </div>
      <div className="flex flex-wrap gap-2">
        <a href={`/api/intelligence/reports/${r.id}/pdf`} target="_blank" rel="noreferrer" className="border border-border px-3 py-1.5 hover:border-ink">
          Preview PDF
        </a>
        <Button
          variant="secondary"
          className="px-3 py-1.5"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void api.intelligence
              .sendReport(r.id)
              .then((x) => setMsg(x.error ? { ok: false, text: x.error } : { ok: true, text: `Sent to ${x.sent} recipient${x.sent === 1 ? "" : "s"}.` }), (e: Error) => setMsg({ ok: false, text: e.message }))
              .finally(() => (setBusy(false), onChange()));
          }}
        >
          {busy ? "Sending…" : "Send now"}
        </Button>
        <Button variant="secondary" className="px-3 py-1.5" onClick={onEdit}>
          Edit
        </Button>
        <Button
          variant="ghost"
          className="px-3 py-1.5"
          onClick={() => {
            if (confirm(`Delete "${r.name}"?`)) void api.intelligence.removeReport(r.id).then(onChange);
          }}
        >
          Delete
        </Button>
      </div>
    </li>
  );
}

function ReportForm({ id, initial, metrics, dashboards, onClose, onSaved }: { id?: string; initial: ScheduledReportInput; metrics: { key: string; label: string }[]; dashboards: { id: string; name: string }[]; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState<ScheduledReportInput>({ ...initial, metricKeys: (initial.metricKeys ?? []).filter((k) => metrics.some((m) => m.key === k)) });
  const [to, setTo] = useState((initial.recipients ?? []).join(", "));
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const keys = f.metricKeys ?? [];

  async function save() {
    const body = { ...f, recipients: to.split(/[,\s]+/).filter(Boolean) };
    const parsed = scheduledReportSchema.safeParse(body);
    if (!parsed.success) return setErr(parsed.error.issues[0]?.message);
    setBusy(true);
    setErr(undefined);
    try {
      if (id) await api.intelligence.updateReport(id, body);
      else await api.intelligence.createReport(body);
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title={id ? "Edit report" : "New report"} className="mb-6">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-sm">
          Name
          <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </label>
        <label className="grid gap-1 text-sm">
          What to send
          <Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as "metrics" | "dashboard" })}>
            <option value="metrics">Chosen numbers</option>
            <option value="dashboard">A dashboard&apos;s numbers</option>
          </Select>
        </label>
        {f.kind === "dashboard" ? (
          <label className="grid gap-1 text-sm sm:col-span-2">
            Dashboard
            <Select value={f.dashboardId ?? ""} onChange={(e) => setF({ ...f, dashboardId: e.target.value || null })}>
              <option value="">Choose…</option>
              {dashboards.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </Select>
          </label>
        ) : (
          <fieldset className="grid gap-1 text-sm sm:col-span-2">
            <legend className="mb-1">Numbers</legend>
            <div className="grid gap-1 sm:grid-cols-3">
              {metrics.map((m) => (
                <label key={m.key} className="flex items-center gap-2">
                  <input type="checkbox" className="size-4 accent-[#8BB72C]" checked={keys.includes(m.key)} onChange={() => setF({ ...f, metricKeys: keys.includes(m.key) ? keys.filter((k) => k !== m.key) : [...keys, m.key] })} />
                  {m.label}
                </label>
              ))}
            </div>
          </fieldset>
        )}
        <label className="grid gap-1 text-sm">
          How often
          <Select value={f.cadence} onChange={(e) => setF({ ...f, cadence: e.target.value as ScheduledReportInput["cadence"] })}>
            {REPORT_CADENCES.map((c) => (
              <option key={c} value={c}>
                {c[0].toUpperCase() + c.slice(1)}
              </option>
            ))}
          </Select>
        </label>
        {f.cadence === "weekly" && (
          <label className="grid gap-1 text-sm">
            Day
            <Select value={f.dayOfWeek ?? 1} onChange={(e) => setF({ ...f, dayOfWeek: Number(e.target.value) })}>
              {DAYS.map((d, i) => (
                <option key={d} value={i}>
                  {d}
                </option>
              ))}
            </Select>
          </label>
        )}
        {f.cadence === "monthly" && (
          <label className="grid gap-1 text-sm">
            Day of the month
            <Input type="number" min={1} max={28} value={f.dayOfMonth ?? 1} onChange={(e) => setF({ ...f, dayOfMonth: Number(e.target.value) })} />
          </label>
        )}
        <label className="grid gap-1 text-sm">
          Time (IST)
          <Select value={f.hourIst ?? 9} onChange={(e) => setF({ ...f, hourIst: Number(e.target.value) })}>
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={h}>
                {String(h).padStart(2, "0")}:00
              </option>
            ))}
          </Select>
        </label>
        <label className="grid gap-1 text-sm sm:col-span-2">
          Email to (separate with commas)
          <Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="founder@yourcompany.in, partner@yourcompany.in" />
        </label>
      </div>
      <p className="mt-3 text-sm text-ink-muted">{describeSchedule({ cadence: f.cadence, dayOfWeek: f.dayOfWeek, dayOfMonth: f.dayOfMonth, hourIst: f.hourIst ?? 9 })}</p>
      {err && <p className="mt-2 text-sm text-red">{err}</p>}
      <div className="mt-4 flex gap-2">
        <Button disabled={busy} onClick={save}>
          {busy ? "Saving…" : "Save report"}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </Panel>
  );
}
