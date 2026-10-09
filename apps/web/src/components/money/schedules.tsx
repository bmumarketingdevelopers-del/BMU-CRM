"use client";
// v18 invoice plans: instalments issued automatically on their date (Finance desk and the project page).
import { useState } from "react";
import { scheduleKindLabels, type InvoiceScheduleRow, type MoneyOptions } from "@bmu/shared";
import Link from "next/link";
import { Badge, Button, Input, LoadState, PageTitle, Select } from "@/components/ui";
import { DataTable, Panel, StatRow, StatTile, Tabs } from "@/components/dash";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { addDays, day, Field, inr, Note, toPaise, todayIst } from "./kit";

const tone = { planned: "dark", issued: "green", skipped: "neutral" } as const;

export function ScheduleTable({ rows, canWrite, onChange, showClient = true }: { rows: InvoiceScheduleRow[]; canWrite: boolean; onChange: () => void; showClient?: boolean }) {
  const [msg, setMsg] = useState<{ error?: string; ok?: string }>({});
  const act = (p: Promise<unknown>, ok: string) => p.then(() => { setMsg({ ok }); onChange(); }).catch((e: Error) => setMsg({ error: e.message }));
  return (
    <>
      <div className="px-5 pt-3"><Note {...msg} /></div>
      <DataTable<InvoiceScheduleRow>
        rows={rows}
        rowKey={(r) => r.id}
        empty="No instalments planned."
        columns={[
          { key: "due", header: "Invoice on", cell: (r) => <span className="whitespace-nowrap">{day(r.dueOn)}</span> },
          { key: "what", header: "Instalment", cell: (r) => <span>{r.label}<span className="block text-xs text-ink-muted">{[showClient ? r.client : null, r.project, scheduleKindLabels[r.kind]].filter(Boolean).join(" · ")}</span>{r.error && <span className="block text-xs text-[#b4432c]">Could not issue: {r.error}</span>}</span> },
          { key: "amt", header: "Before GST", align: "right", cell: (r) => <span className="font-medium">{inr(r.amountPaise)}</span> },
          { key: "st", header: "", cell: (r) => (r.invoiceId ? <Link href={`/admin/finance/invoices/${r.invoiceId}`} className="underline">{r.invoiceNumber}</Link> : <Badge tone={tone[r.status]}>{r.status === "planned" ? "Planned" : "Skipped"}</Badge>) },
          {
            key: "act",
            header: "",
            align: "right",
            cell: (r) =>
              canWrite && r.status === "planned" ? (
                <div className="flex justify-end gap-2">
                  <Button variant="secondary" onClick={() => window.confirm(`Issue "${r.label}" now? The client gets the invoice.`) && act(api.money.issueSchedule(r.id), "Invoice issued.")} data-testid="issue-now">Issue now</Button>
                  <Button variant="ghost" onClick={() => act(api.money.updateSchedule(r.id, { status: "skipped" }), "Skipped.")}>Skip</Button>
                </div>
              ) : canWrite && r.status === "skipped" ? (
                <Button variant="ghost" onClick={() => act(api.money.updateSchedule(r.id, { status: "planned" }), "Planned again.")}>Plan again</Button>
              ) : null,
          },
        ]}
      />
    </>
  );
}

function PlanForm({ options, onDone, clientId, engagementId }: { options: MoneyOptions; onDone: () => void; clientId?: string; engagementId?: string }) {
  const [f, setF] = useState({ clientOrgId: clientId ?? "", engagementId: engagementId ?? "", total: "" });
  const [parts, setParts] = useState([
    { label: "Advance (50%)", pct: 50, dueOn: todayIst() },
    { label: "Midway (30%)", pct: 30, dueOn: addDays(todayIst(), 30) },
    { label: "On delivery (20%)", pct: 20, dueOn: addDays(todayIst(), 60) },
  ]);
  const [msg, setMsg] = useState<{ error?: string; ok?: string }>({});
  const client = options.clients.find((c) => c.id === f.clientOrgId);
  const sum = parts.reduce((s, p) => s + p.pct, 0);
  const total = toPaise(f.total);
  return (
    <form
      className="space-y-3"
      data-testid="plan-form"
      onSubmit={(e) => {
        e.preventDefault();
        setMsg({});
        api.money
          .planSchedule({ clientOrgId: f.clientOrgId, engagementId: f.engagementId || null, totalPaise: total, parts })
          .then(() => { setMsg({ ok: "Instalments planned. Each is invoiced on its date." }); onDone(); })
          .catch((err: Error) => setMsg({ error: err.message }));
      }}
    >
      <div className="grid gap-3 sm:grid-cols-3">
        {!clientId && (
          <Field label="Client">
            <Select value={f.clientOrgId} onChange={(e) => setF({ ...f, clientOrgId: e.target.value, engagementId: "" })} required>
              <option value="">Pick a client</option>
              {options.clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </Field>
        )}
        {!engagementId && (
          <Field label="Project">
            <Select value={f.engagementId} onChange={(e) => setF({ ...f, engagementId: e.target.value })} disabled={!client}>
              <option value="">No project</option>
              {client?.projects.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </Select>
          </Field>
        )}
        <Field label="Total fee before GST (₹)"><Input value={f.total} onChange={(e) => setF({ ...f, total: e.target.value })} inputMode="decimal" required data-testid="plan-total" /></Field>
      </div>
      <div className="space-y-2">
        {parts.map((p, i) => (
          <div key={i} className="grid grid-cols-[1fr_80px_150px_auto] items-center gap-2 text-sm">
            <Input value={p.label} onChange={(e) => setParts(parts.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
            <Input type="number" min={1} max={100} value={p.pct} onChange={(e) => setParts(parts.map((x, j) => (j === i ? { ...x, pct: Number(e.target.value) } : x)))} aria-label="Percent" />
            <Input type="date" value={p.dueOn} onChange={(e) => setParts(parts.map((x, j) => (j === i ? { ...x, dueOn: e.target.value } : x)))} />
            <span className="w-24 text-right text-ink-muted">{total ? inr(Math.round((total * p.pct) / 100)) : ""}</span>
          </div>
        ))}
        <div className="flex gap-2">
          <Button type="button" variant="ghost" onClick={() => setParts([...parts, { label: "Instalment", pct: Math.max(1, 100 - sum), dueOn: addDays(parts[parts.length - 1]?.dueOn ?? todayIst(), 30) }])} disabled={parts.length >= 12}>Add instalment</Button>
          {parts.length > 1 && <Button type="button" variant="ghost" onClick={() => setParts(parts.slice(0, -1))}>Remove last</Button>}
        </div>
        <p className={`text-xs ${sum === 100 ? "text-ink-muted" : "text-[#b4432c]"}`}>Adds up to {sum}%{sum === 100 ? "" : " (must be 100%)"}.</p>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={sum !== 100}>Plan instalments</Button>
        <Note {...msg} />
      </div>
    </form>
  );
}

export function SchedulesDesk() {
  const [tab, setTab] = useState<"planned" | "issued" | "all">("planned");
  const list = useLoad(() => api.money.schedules(), { live: ["InvoiceSchedule", "Invoice"] });
  const options = useLoad(() => api.money.options(), { live: false });
  const [adding, setAdding] = useState(false);
  const [done, setDone] = useState("");
  if (!list.data) return <LoadState loading={list.loading} error={list.error} />;
  const rows = list.data.filter((r) => tab === "all" || (tab === "planned" ? r.status !== "issued" : r.status === "issued"));
  const planned = list.data.filter((r) => r.status === "planned");
  const in30 = planned.filter((r) => r.dueOn <= addDays(todayIst(), 30));
  return (
    <>
      <PageTitle title="Invoice plans" subtitle="Milestones and instalments planned up front. Each one is invoiced and emailed on its date, without anyone remembering." action={<Button onClick={() => { setAdding(!adding); setDone(""); }} data-testid="new-plan">Plan instalments</Button>} />
      <div className="space-y-6">
        <StatRow cols={3}>
          <StatTile label="Planned" value={inr(planned.reduce((s, r) => s + r.amountPaise, 0))} hint={`${planned.length} instalments`} />
          <StatTile label="Next 30 days" value={inr(in30.reduce((s, r) => s + r.amountPaise, 0))} hint="before GST" />
          <StatTile label="Could not issue" value={String(planned.filter((r) => r.error).length)} tone={planned.some((r) => r.error) ? "bad" : "default"} />
        </StatRow>
        {done && <Note ok={done} />}
        {adding && options.data && <Panel title="Split a fee into instalments"><PlanForm options={options.data} onDone={() => { setAdding(false); setDone("Instalments planned. Each is invoiced on its date."); list.reload(); }} /></Panel>}
        <Panel flush title="Instalments" action={<Tabs value={tab} onChange={setTab} options={[{ value: "planned", label: "Coming up" }, { value: "issued", label: "Invoiced" }, { value: "all", label: "All" }]} />}>
          <ScheduleTable rows={rows} canWrite onChange={list.reload} />
        </Panel>
      </div>
    </>
  );
}

/** Project page: its instalments and a quick plan form for Finance. */
export function ProjectSchedules({ clientId, engagementId, canWrite }: { clientId: string; engagementId: string; canWrite: boolean }) {
  const list = useLoad(() => api.money.schedules({ engagementId }), { live: ["InvoiceSchedule", "Invoice"] });
  const options = useLoad(() => (canWrite ? api.money.options() : Promise.resolve(null)), { live: false });
  const [adding, setAdding] = useState(false);
  const [done, setDone] = useState("");
  if (list.error && !list.data) return null;
  return (
    <Panel title="Invoice plan" subtitle="Instalments for this project, invoiced on their dates." flush action={canWrite ? <Button variant="secondary" onClick={() => { setAdding(!adding); setDone(""); }}>Plan instalments</Button> : undefined}>
      {done && <div className="border-b border-border px-5 py-3"><Note ok={done} /></div>}
      {adding && options.data && <div className="border-b border-border p-5"><PlanForm options={options.data} clientId={clientId} engagementId={engagementId} onDone={() => { setAdding(false); setDone("Instalments planned. Each is invoiced on its date."); list.reload(); }} /></div>}
      {list.data ? <ScheduleTable rows={list.data} canWrite={canWrite} onChange={list.reload} showClient={false} /> : <div className="p-5"><LoadState loading /></div>}
    </Panel>
  );
}
