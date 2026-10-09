"use client";

import Link from "next/link";
import { useState } from "react";
import { invoiceKindLabels, type ServiceCollectionsActions, type ServiceCollectionsInvoiceActions, type UnpaidInvoiceRow } from "@bmu/shared";
import { DataTable, Panel, StackBar, StatRow, StatTile, type Column } from "@/components/dash";
import { Badge, Button, Input, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { FormNote, WithData, fmtDate, fmtDateTime, inr, inrShort, todayIst } from "../_insights/kit";

const agingTone = ["grey", "amber", "amber", "red", "red"] as const;

export default function CollectionsPage() {
  const state = useLoad(() => api.insights.collections());
  const actions = useLoad(() => api.service.collectionsActions());
  const [fresh, setFresh] = useState<ServiceCollectionsActions>();
  const [sent, setSent] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [promiseFor, setPromiseFor] = useState<string | null>(null);
  const a = fresh ?? actions.data;
  const byInvoice = new Map((a?.rows ?? []).map((r) => [r.invoiceId, r]));

  async function remind(id: string) {
    setBusy(id);
    try {
      const r = await api.service.remindNow(id);
      setSent((s) => ({ ...s, [id]: `Reminder sent to ${r.notified}` }));
      setFresh(await api.service.collectionsActions());
    } catch (e) {
      setSent((s) => ({ ...s, [id]: (e as Error).message }));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <PageTitle title="Collections" subtitle="Money clients still owe us, how late it is, automatic reminders, and the dates clients promised to pay." />
      <WithData state={state}>
        {(c) => {
          const columns: Column<UnpaidInvoiceRow>[] = [
            { key: "client", header: "Client", cell: (r) => r.client },
            { key: "number", header: "Invoice", cell: (r) => <Link href={`/admin/finance/invoices/${r.id}`} className="hover:underline">{r.number}</Link> },
            { key: "kind", header: "For", cell: (r) => <span className="text-ink-muted">{invoiceKindLabels[r.kind] ?? r.kind}</span> },
            { key: "due", header: "Due", cell: (r) => <span className="whitespace-nowrap">{fmtDate(r.dueDate)}</span> },
            { key: "late", header: "Days late", align: "right", cell: (r) => (r.daysOverdue ? <Badge tone={r.daysOverdue > 30 ? "red" : "amber"}>{r.daysOverdue}</Badge> : <span className="text-ink-muted">Not due</span>) },
            { key: "balance", header: "Balance", align: "right", cell: (r) => <span className="font-medium">{inr(r.balancePaise)}</span> },
            { key: "reminders", header: "Reminders", cell: (r) => <Reminders row={byInvoice.get(r.id)} /> },
            { key: "promise", header: "Promise to pay", cell: (r) => <PromiseCell row={byInvoice.get(r.id)} /> },
          ];
          if (c.canAct)
            columns.push({
              key: "act",
              header: "",
              align: "right",
              cell: (r) => (
                <div className="flex flex-col items-end gap-1">
                  {sent[r.id] ? (
                    <span className="text-xs text-ink-muted">{sent[r.id]}</span>
                  ) : (
                    <Button variant="secondary" className="whitespace-nowrap !px-3 !py-1 text-xs" disabled={busy === r.id || !r.clientId} onClick={() => remind(r.id)}>
                      {busy === r.id ? "Sending…" : "Send reminder"}
                    </Button>
                  )}
                  <button className="text-xs underline" onClick={() => setPromiseFor(promiseFor === r.id ? null : r.id)}>
                    {promiseFor === r.id ? "Close" : "Log promise"}
                  </button>
                  {promiseFor === r.id && <PromiseForm invoiceId={r.id} onSaved={(v) => (setFresh(v), setPromiseFor(null))} />}
                </div>
              ),
            });
          return (
            <div className="space-y-8">
              <StatRow cols={4}>
                <StatTile label="Outstanding" value={inr(c.outstandingPaise)} hint={`${c.unpaid.length} unpaid invoice${c.unpaid.length === 1 ? "" : "s"}`} />
                <StatTile label="Overdue" value={inr(c.overduePaise)} tone={c.overduePaise ? "bad" : "default"} hint="past the due date" />
                <StatTile label="Collected this month" value={inr(c.collectedThisMonthPaise)} tone="good" href="/admin/finance/payments" />
                <StatTile label="Promises to pay" value={a ? a.promisesOpen : "—"} tone={a?.promisesBroken ? "bad" : "default"} hint={a ? `${a.promisesBroken} broken · ${a.sentLast30Days} reminders in 30 days` : undefined} />
              </StatRow>
              <Panel className="min-w-0" title="How late is the money" subtitle="Balance due, by days past the due date">
                <StackBar parts={c.aging.map((x, i) => ({ label: `${x.label} (${x.count})`, value: x.valuePaise, tone: agingTone[i] }))} format={inrShort} />
              </Panel>
              <Panel className="min-w-0" title="Unpaid invoices" subtitle="Most overdue first. Reminders go to the client's owner and finance people (in the app, by email and as a message from their AM)." flush>
                <DataTable rows={c.unpaid} columns={columns} rowKey={(r) => r.id} empty="Nothing is owed. Every invoice is paid." />
              </Panel>
              {a && <DunningSettings a={a} canEdit={c.canAct} onChange={setFresh} />}
            </div>
          );
        }}
      </WithData>
    </>
  );
}

function Reminders({ row }: { row?: ServiceCollectionsInvoiceActions }) {
  if (!row) return <span className="text-ink-muted">—</span>;
  const last = row.reminders.at(-1);
  return (
    <div className="text-xs">
      {last ? (
        <p title={row.reminders.map((r) => `${r.manual ? "Manual" : `Step ${r.step}`} · ${fmtDateTime(r.at)}`).join("\n")}>
          {row.reminders.length} sent · last {fmtDate(last.at)}
          {last.manual ? " (manual)" : ` (step ${last.step})`}
        </p>
      ) : (
        <p className="text-ink-muted">None yet</p>
      )}
      {row.nextReminder && <p className="text-ink-muted">Next: {fmtDate(row.nextReminder.on)}</p>}
    </div>
  );
}

function PromiseCell({ row }: { row?: ServiceCollectionsInvoiceActions }) {
  if (!row?.promise) return <span className="text-ink-muted">—</span>;
  const p = row.promise;
  return (
    <div className="text-xs" title={p.note ?? undefined}>
      <Badge tone={p.broken ? "red" : "neutral"}>{p.broken ? `Broken (${fmtDate(p.promisedFor)})` : `By ${fmtDate(p.promisedFor)}`}</Badge>
      <p className="mt-0.5 text-ink-muted">
        {p.by}
        {p.note ? `: ${p.note.slice(0, 40)}` : ""}
      </p>
    </div>
  );
}

function PromiseForm({ invoiceId, onSaved }: { invoiceId: string; onSaved: (v: ServiceCollectionsActions) => void }) {
  const [date, setDate] = useState(todayIst());
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="grid w-56 gap-1.5 border border-border bg-surface p-2 text-left"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          onSaved(await api.service.promise(invoiceId, { promisedFor: date, note: note || undefined }));
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="text-xs text-ink-muted">
        Client promised to pay by
        <Input type="date" value={date} min={todayIst()} onChange={(e) => setDate(e.target.value)} required className="mt-1 !py-1" />
      </label>
      <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (who said it, how)" className="!py-1 text-xs" maxLength={500} />
      <p className="text-[11px] text-ink-muted">Automatic reminders pause until this date.</p>
      <Button className="!py-1 text-xs" disabled={busy}>
        {busy ? "Saving…" : "Save promise"}
      </Button>
      <FormNote error={error} />
    </form>
  );
}

function DunningSettings({ a, canEdit, onChange }: { a: ServiceCollectionsActions; canEdit: boolean; onChange: (v: ServiceCollectionsActions) => void }) {
  const [s, setS] = useState(a.settings);
  const [steps, setSteps] = useState(a.settings.steps.join(", "));
  const [msg, setMsg] = useState<{ error?: string; ok?: string }>({});
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setMsg({});
    try {
      const list = steps
        .split(/[,\s]+/)
        .map((x) => Number(x))
        .filter((n) => Number.isInteger(n) && n > 0);
      if (!list.length) throw new Error("Enter at least one day, e.g. 1, 7, 14");
      await api.settings.save("dunning", { ...s, steps: [...new Set(list)].sort((x, y) => x - y) });
      onChange(await api.service.collectionsActions());
      setMsg({ ok: "Saved." });
    } catch (e) {
      setMsg({ error: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function runNow() {
    setBusy(true);
    setMsg({});
    try {
      const r = await api.service.runDunning();
      onChange(await api.service.collectionsActions());
      setMsg({ ok: r.sent ? `Sent ${r.sent} reminder${r.sent === 1 ? "" : "s"}. ${r.details.join(" · ")}` : r.details[0] ?? `Checked ${r.checked} overdue invoice${r.checked === 1 ? "" : "s"}: nothing new to send${r.paused ? ` (${r.paused} paused by a promise)` : ""}.` });
    } catch (e) {
      setMsg({ error: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const check = (k: "enabled" | "workingDays" | "emailClient" | "messageClient" | "alertFinance", label: string) => (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={s[k]} disabled={!canEdit} onChange={(e) => setS({ ...s, [k]: e.target.checked })} /> {label}
    </label>
  );

  return (
    <Panel title="Automatic payment reminders" subtitle="Friendly first, firmer later, final notice last. They stop as soon as the invoice is paid, and pause while a promise-to-pay date is ahead.">
      <div className="grid gap-4 md:grid-cols-2">
        <div className="grid content-start gap-2">
          {check("enabled", "Send reminders automatically")}
          <label className="grid gap-1 text-sm">
            <span className="text-ink-muted">Days after the due date</span>
            <Input value={steps} disabled={!canEdit} onChange={(e) => setSteps(e.target.value)} placeholder="1, 7, 14" />
          </label>
          {check("workingDays", "Count working days only (Mon–Sat, not holidays)")}
        </div>
        <div className="grid content-start gap-2">
          {check("messageClient", "Message the client in their app thread (from their AM)")}
          {check("emailClient", "Email the client's owner and finance people")}
          {check("alertFinance", "Alert Finance and the AM")}
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {canEdit && (
          <>
            <Button onClick={save} disabled={busy}>
              Save reminder settings
            </Button>
            <Button variant="secondary" onClick={runNow} disabled={busy}>
              Check and send now
            </Button>
          </>
        )}
        <span className="text-xs text-ink-muted">Runs on its own every 15 minutes while the app is running.</span>
      </div>
      <div className="mt-2">
        <FormNote error={msg.error} ok={msg.ok} />
      </div>
    </Panel>
  );
}
