"use client";

// v20 DPDP Act 2023: data-principal requests with 30-day deadlines, consent records, retention rules and the
// breach runbook.
import { useState } from "react";
import { DATA_REQUEST_KINDS, consentPurposeLabels, dataRequestKindLabels, type DataRequestView, type DpdpOverview, type RetentionRuleView } from "@bmu/shared";
import { Panel, StatRow, StatTile, Tabs } from "@/components/dash";
import { Badge, Button, Input, LoadState, PageTitle, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { useActions } from "@/components/actions/actions-provider";

type Msg = { ok: boolean; text: string } | undefined;
const Note = ({ msg }: { msg: Msg }) => (msg ? <p className={`mt-3 text-sm ${msg.ok ? "text-ink" : "text-red"}`}>{msg.text}</p> : null);
const day = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
const statusTone = { open: "amber", in_progress: "dark", done: "green", rejected: "neutral" } as const;
const statusLabel = { open: "Open", in_progress: "In progress", done: "Done", rejected: "Refused" } as const;

function download(name: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export default function PrivacyAdminPage() {
  const roles = useActions().me.roles;
  // Client Managers see the people at their own clients; the Founder and the Client Manager Lead see everyone.
  const scoped = !roles.includes("founder") && !roles.includes("am_lead");
  const data = useLoad(() => api.securityAdmin.privacy());
  const [tab, setTab] = useState<"requests" | "consents" | "retention" | "breach">("requests");
  const d = data.data;
  return (
    <>
      <PageTitle title="Privacy (DPDP)" subtitle={`Requests from people about their data, consent records, how long data is kept, and what to do after a breach. The public form is at /privacy.${scoped ? " You see the people at the clients you manage." : ""}`} />
      <LoadState loading={data.loading && !d} error={data.error} />
      {d && (
        <>
          <StatRow cols={4}>
            <StatTile label="Open requests" value={d.requests.filter((r) => r.status === "open" || r.status === "in_progress").length} />
            <StatTile label="Overdue" value={d.requests.filter((r) => r.overdue).length} tone={d.requests.some((r) => r.overdue) ? "bad" : "default"} hint="Past the 30-day deadline" />
            <StatTile label="Marketing consents" value={d.consents.marketing} hint={`${d.consents.withdrawn} withdrawn`} />
            <StatTile label="Notice version" value={d.noticeVersion} />
          </StatRow>
          <div className="mt-6">
            <Tabs
              value={tab}
              onChange={setTab}
              options={[
                { value: "requests", label: "Requests" },
                { value: "consents", label: "Consents" },
                { value: "retention", label: "Retention" },
                { value: "breach", label: "Breach runbook" },
              ]}
            />
          </div>
          <div className="mt-6">
            {tab === "requests" ? <Requests d={d} onChange={data.reload} /> : tab === "consents" ? <Consents d={d} onChange={data.reload} /> : tab === "retention" ? <Retention rules={d.retention} onChange={data.reload} /> : <Breach d={d} />}
          </div>
        </>
      )}
    </>
  );
}

function Requests({ d, onChange }: { d: DpdpOverview; onChange: () => void }) {
  const [msg, setMsg] = useState<Msg>();
  const [adding, setAdding] = useState(false);
  async function act(fn: () => Promise<unknown>, ok: string) {
    setMsg(undefined);
    try {
      await fn();
      setMsg({ ok: true, text: ok });
      onChange();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  }
  return (
    <Panel
      title="Data requests"
      subtitle="Copy, correction or deletion requests. Answer each within 30 days; every step is in the audit log."
      action={
        <Button variant="secondary" onClick={() => setAdding((a) => !a)}>
          {adding ? "Close" : "Log a request"}
        </Button>
      }
      flush
    >
      {adding && <NewRequest onDone={() => (setAdding(false), onChange())} />}
      <ul className="divide-y divide-border">
        {d.requests.map((r) => (
          <RequestRow key={r.id} r={r} act={act} />
        ))}
        {!d.requests.length && <li className="px-4 py-6 text-center text-sm text-ink-muted">No requests yet.</li>}
      </ul>
      <div className="px-4 pb-3">
        <Note msg={msg} />
      </div>
    </Panel>
  );
}

function RequestRow({ r, act }: { r: DataRequestView; act: (fn: () => Promise<unknown>, ok: string) => Promise<void> }) {
  // v43: leads are the Founder's (Client Managers handle the people at their own clients).
  const founder = useActions().me.roles.includes("founder");
  const [resolution, setResolution] = useState(r.resolution ?? "");
  const lead = r.matches.find((m) => m.type === "lead");
  const subject = r.subjectId ? r.matches.find((m) => m.id === r.subjectId) ?? lead ?? r.matches[0] : lead ?? r.matches[0];
  const open = r.status === "open" || r.status === "in_progress";
  return (
    <li className="grid gap-2 px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>
          <span className="font-medium">{dataRequestKindLabels[r.kind]}</span> · {r.requesterName} · {r.requesterEmail}
        </span>
        <span className="flex items-center gap-2">
          {r.overdue && <Badge tone="red">Overdue</Badge>}
          <Badge tone={statusTone[r.status]}>{statusLabel[r.status]}</Badge>
          <span className="text-xs text-ink-muted">Due {day.format(new Date(r.dueAt))}</span>
        </span>
      </div>
      {r.details && <p className="text-ink-muted">{r.details}</p>}
      <p className="text-xs text-ink-muted">
        {r.matches.length ? `Found: ${r.matches.map((m) => `${m.name} (${m.type})`).join(", ")}` : "No matching record found by email."}
        {r.assignee ? ` · With ${r.assignee.name}` : ""}
      </p>
      {open && (
        <div className="flex flex-wrap gap-2">
          {r.status === "open" && (
            <Button variant="secondary" className="px-3 py-1.5" onClick={() => act(() => api.securityAdmin.updateRequest(r.id, { status: "in_progress" }), "Marked in progress.")}>
              Start
            </Button>
          )}
          {subject && (subject.type === "user" || (subject.type === "lead" && founder)) && r.kind === "export" && (
            <Button
              variant="secondary"
              className="px-3 py-1.5"
              onClick={() =>
                act(async () => download(`data-${subject.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.json`, await api.securityAdmin.exportSubject(subject.type as "lead" | "user", subject.id)), "Downloaded. Send it to the person, then mark the request done.")
              }
            >
              Download their data
            </Button>
          )}
          {subject?.type === "lead" && founder && r.kind === "deletion" && (
            <Button
              variant="ghost"
              className="px-3 py-1.5 text-[#b4432c]"
              onClick={() => {
                if (confirm(`Delete ${subject.name}'s personal details from this lead? This cannot be undone.`)) void act(() => api.securityAdmin.eraseLead(subject.id), "Personal details removed from the lead.");
              }}
            >
              Delete lead details
            </Button>
          )}
          <Input className="min-w-0 flex-1" value={resolution} onChange={(e) => setResolution(e.target.value)} placeholder="What you did (sent to the record)" aria-label="Resolution" />
          <Button className="px-3 py-1.5" disabled={!resolution.trim()} onClick={() => act(() => api.securityAdmin.updateRequest(r.id, { status: "done", resolution }), "Request closed.")}>
            Mark done
          </Button>
          <Button variant="ghost" className="px-3 py-1.5" disabled={!resolution.trim()} onClick={() => act(() => api.securityAdmin.updateRequest(r.id, { status: "rejected", resolution }), "Request refused with your reason.")}>
            Refuse
          </Button>
        </div>
      )}
      {!open && r.resolution && <p className="text-xs">Outcome: {r.resolution}</p>}
    </li>
  );
}

function NewRequest({ onDone }: { onDone: () => void }) {
  const [f, setF] = useState({ kind: "export", requesterName: "", requesterEmail: "", details: "" });
  const [err, setErr] = useState<string>();
  return (
    <form
      className="grid gap-2 border-b border-border p-4 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        api.securityAdmin.createRequest({ ...f, details: f.details || undefined }).then(onDone, (x: Error) => setErr(x.message));
      }}
    >
      <Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })} aria-label="Kind">
        {DATA_REQUEST_KINDS.map((k) => (
          <option key={k} value={k}>
            {dataRequestKindLabels[k]}
          </option>
        ))}
      </Select>
      <Input value={f.requesterName} onChange={(e) => setF({ ...f, requesterName: e.target.value })} placeholder="Their name" aria-label="Their name" required />
      <Input value={f.requesterEmail} onChange={(e) => setF({ ...f, requesterEmail: e.target.value })} placeholder="Their email" aria-label="Their email" type="email" required />
      <Input value={f.details} onChange={(e) => setF({ ...f, details: e.target.value })} placeholder="Details (optional)" aria-label="Details" />
      <div className="sm:col-span-2">
        <Button type="submit">Log request</Button>
        {err && <span className="ml-3 text-sm text-red">{err}</span>}
      </div>
    </form>
  );
}

function Consents({ d, onChange }: { d: DpdpOverview; onChange: () => void }) {
  const [msg, setMsg] = useState<Msg>();
  return (
    <Panel title="Consent records" subtitle={`${d.consents.total} recorded. Each shows what was agreed, when, where and under which notice version.`} flush>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            <tr className="border-b border-border text-left text-[11px] uppercase tracking-[0.12em] text-ink-muted">
              <th className="px-3 py-2">Who</th>
              <th className="px-3 py-2">Purpose</th>
              <th className="px-3 py-2">From</th>
              <th className="px-3 py-2">When</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {d.consents.recent.map((c) => (
              <tr key={c.id} className="border-b border-border">
                <td className="px-3 py-2">{c.email ?? c.phone ?? `${c.subjectType} ${c.subjectId.slice(0, 8)}`}</td>
                <td className="px-3 py-2">{consentPurposeLabels[c.purpose] ?? c.purpose}</td>
                <td className="px-3 py-2">
                  {c.source.replaceAll("_", " ")} · v{c.noticeVersion}
                </td>
                <td className="px-3 py-2 whitespace-nowrap">{day.format(new Date(c.createdAt))}</td>
                <td className="px-3 py-2 text-right">
                  {c.withdrawnAt ? (
                    <Badge>Withdrawn {day.format(new Date(c.withdrawnAt))}</Badge>
                  ) : c.granted ? (
                    <Button variant="ghost" className="px-3 py-1" onClick={() => void api.securityAdmin.withdrawConsent(c.id).then(() => (setMsg({ ok: true, text: "Consent withdrawn." }), onChange()), (e: Error) => setMsg({ ok: false, text: e.message }))}>
                      Withdraw
                    </Button>
                  ) : (
                    <Badge>Not given</Badge>
                  )}
                </td>
              </tr>
            ))}
            {!d.consents.recent.length && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-ink-muted">
                  No consents recorded yet. They are saved from the enquiry form and public forms.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="px-4 pb-3">
        <Note msg={msg} />
      </div>
    </Panel>
  );
}

function Retention({ rules, onChange }: { rules: RetentionRuleView[]; onChange: () => void }) {
  // v43: these rules delete data across the whole organisation, so only the Founder changes or runs them.
  const founder = useActions().me.roles.includes("founder");
  const [edit, setEdit] = useState(rules);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>();
  const set = (i: number, patch: Partial<RetentionRuleView>) => setEdit((r) => r.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  async function run(fn: () => Promise<string>) {
    setBusy(true);
    setMsg(undefined);
    try {
      setMsg({ ok: true, text: await fn() });
      onChange();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Panel
      title="How long data is kept"
      subtitle={`Turned-on rules run every night and anonymise or delete records older than the limit. Invoices are always kept for 8 years (GST).${founder ? "" : " They apply to the whole organisation, so only the Founder changes them."}`}
      action={
        founder && <div className="flex gap-2">
          <Button variant="secondary" disabled={busy} onClick={() => run(async () => `Ran now: ${Object.entries((await api.securityAdmin.runRetention()).ran).map(([k, n]) => `${k.replaceAll("_", " ")} ${n}`).join(", ") || "nothing due"}.`)}>
            Run now
          </Button>
          <Button disabled={busy} onClick={() => run(async () => (await api.securityAdmin.saveRetention(edit.map(({ recordType, keepDays, action, enabled }) => ({ recordType, keepDays, action, enabled }))), "Saved."))}>
            Save
          </Button>
        </div>
      }
      flush
    >
      <ul className="divide-y divide-border">
        {edit.map((r, i) => (
          <li key={r.recordType} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
            <label className="flex min-w-[240px] flex-1 items-center gap-2">
              <input type="checkbox" className="size-4 accent-[#8BB72C]" checked={r.enabled} onChange={(e) => set(i, { enabled: e.target.checked })} />
              <span>
                {r.label}
                <span className="block text-xs text-ink-muted">{r.lastRunAt ? `Last run ${day.format(new Date(r.lastRunAt))}: ${r.lastCount ?? 0} records` : "Not run yet"}</span>
              </span>
            </label>
            <span className="flex items-center gap-2">
              Keep
              <Input type="number" min={1} max={3650} value={r.keepDays} onChange={(e) => set(i, { keepDays: Number(e.target.value) })} className="w-24" aria-label={`Days to keep ${r.label}`} />
              days, then
            </span>
            <Select value={r.action} onChange={(e) => set(i, { action: e.target.value as "anonymise" | "delete" })} aria-label={`Action for ${r.label}`} className="w-36">
              {r.actions.map((a) => (
                <option key={a} value={a}>
                  {a === "anonymise" ? "anonymise" : "delete"}
                </option>
              ))}
            </Select>
          </li>
        ))}
      </ul>
      <div className="px-4 pb-3">
        <Note msg={msg} />
      </div>
    </Panel>
  );
}

function Breach({ d }: { d: DpdpOverview }) {
  return (
    <Panel title="If personal data leaks" subtitle="Follow these steps in order. Keep notes of times and decisions.">
      <ol className="grid gap-3">
        {d.breachRunbook.map((s, i) => (
          <li key={s.step} className="flex gap-3 text-sm">
            <span className="flex size-6 shrink-0 items-center justify-center bg-charcoal text-xs text-ivory">{i + 1}</span>
            <span>
              <span className="font-semibold">{s.step}.</span> {s.detail}
            </span>
          </li>
        ))}
      </ol>
    </Panel>
  );
}
