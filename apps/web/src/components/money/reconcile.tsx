"use client";
// v18: money that came in without an invoice (Razorpay or a bank credit typed in), with suggested matches.
import { useState } from "react";
import type { UnmatchedPaymentRow } from "@bmu/shared";
import { Badge, Button, Input, LoadState, PageTitle } from "@/components/ui";
import { DataTable, Panel, StatRow, StatTile } from "@/components/dash";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { day, Field, inr, Note, toPaise, todayIst } from "./kit";

export function Reconcile() {
  const list = useLoad(() => api.money.unmatched(), { live: ["UnmatchedPayment", "Payment"] });
  const [msg, setMsg] = useState<{ error?: string; ok?: string }>({});
  const [form, setForm] = useState({ amount: "", ref: "", payerName: "", receivedOn: todayIst() });
  const [pick, setPick] = useState<Record<string, string>>({});
  const run = (p: Promise<unknown>, ok: string) =>
    p.then(() => {
      setMsg({ ok });
      list.reload();
    }).catch((e: Error) => setMsg({ error: e.message }));
  if (!list.data) return <LoadState loading={list.loading} error={list.error} />;
  const d = list.data;
  return (
    <>
      <PageTitle title="Payments to match" subtitle="Money received that could not be tied to an invoice on its own. Pick the invoice and it is marked paid." />
      <div className="space-y-6">
        <StatRow cols={3}>
          <StatTile label="Waiting to match" value={String(d.open.length)} tone={d.open.length ? "warn" : "good"} />
          <StatTile label="Amount waiting" value={inr(d.open.reduce((s, r) => s + r.amountPaise, 0))} />
          <StatTile label="Matched or ignored" value={String(d.done.length)} />
        </StatRow>
        <Note {...msg} />
        <Panel title="Waiting" flush>
          <DataTable<UnmatchedPaymentRow>
            rows={d.open}
            rowKey={(r) => r.id}
            empty="Nothing to match. Every payment found its invoice."
            columns={[
              { key: "when", header: "Received", cell: (r) => day(r.receivedAt) },
              { key: "amt", header: "Amount", cell: (r) => <span className="font-medium">{inr(r.amountPaise)}</span> },
              { key: "ref", header: "Reference", cell: (r) => <span className="break-all">{r.ref}<span className="block text-xs text-ink-muted">{[r.provider === "razorpay" ? "Razorpay" : "Bank", r.payerName, r.payerEmail, r.payerPhone].filter(Boolean).join(" · ")}</span></span> },
              {
                key: "match",
                header: "Belongs to",
                cell: (r) =>
                  r.suggestions.length ? (
                    <select className="w-full border border-border bg-surface-raised px-2 py-1.5 text-sm" value={pick[r.id] ?? r.suggestions[0].invoiceId} onChange={(e) => setPick({ ...pick, [r.id]: e.target.value })} data-testid="match-pick">
                      {r.suggestions.map((s) => (
                        <option key={s.invoiceId} value={s.invoiceId}>
                          {s.number} · {s.client} · {inr(s.balancePaise)} due ({s.reason})
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="text-ink-muted">No likely invoice. Record it on the invoice page instead.</span>
                  ),
              },
              {
                key: "act",
                header: "",
                align: "right",
                cell: (r) => (
                  <div className="flex justify-end gap-2">
                    {r.suggestions.length > 0 && (
                      <Button onClick={() => run(api.money.match(r.id, { invoiceId: pick[r.id] ?? r.suggestions[0].invoiceId }), "Matched. The invoice is updated.")} data-testid="match-btn">
                        Match
                      </Button>
                    )}
                    <Button variant="ghost" onClick={() => window.confirm("Ignore this payment? (e.g. a refund or not ours)") && run(api.money.ignore(r.id), "Ignored.")}>
                      Ignore
                    </Button>
                  </div>
                ),
              },
            ]}
          />
        </Panel>
        <Panel title="Add a bank or UPI credit" subtitle="From the bank statement, when you don't know which invoice it is for yet.">
          <form
            className="grid gap-3 sm:grid-cols-5"
            onSubmit={(e) => {
              e.preventDefault();
              run(api.money.addUnmatched({ amountPaise: toPaise(form.amount), ref: form.ref, payerName: form.payerName || null, receivedOn: form.receivedOn }), "Added to the list.").then(() => setForm({ ...form, amount: "", ref: "", payerName: "" }));
            }}
          >
            <Field label="Amount (₹)"><Input value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} inputMode="decimal" required /></Field>
            <Field label="Reference"><Input value={form.ref} onChange={(e) => setForm({ ...form, ref: e.target.value })} required /></Field>
            <Field label="Payer (optional)"><Input value={form.payerName} onChange={(e) => setForm({ ...form, payerName: e.target.value })} /></Field>
            <Field label="Received on"><Input type="date" value={form.receivedOn} onChange={(e) => setForm({ ...form, receivedOn: e.target.value })} /></Field>
            <div className="flex items-end"><Button type="submit">Add</Button></div>
          </form>
        </Panel>
        {d.done.length > 0 && (
          <Panel title="Done" flush>
            <DataTable<UnmatchedPaymentRow>
              rows={d.done.slice(0, 50)}
              rowKey={(r) => r.id}
              columns={[
                { key: "when", header: "Received", cell: (r) => day(r.receivedAt) },
                { key: "amt", header: "Amount", cell: (r) => inr(r.amountPaise) },
                { key: "ref", header: "Reference", cell: (r) => r.ref },
                { key: "st", header: "", align: "right", cell: (r) => (r.status === "matched" ? <Badge tone="green">Matched to {r.invoiceNumber}</Badge> : <Badge>Ignored</Badge>) },
              ]}
            />
          </Panel>
        )}
      </div>
    </>
  );
}
