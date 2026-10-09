"use client";
// v18 expenses and vendor bills: claim an expense (anyone), add a vendor bill (Finance), approve, pay, re-bill.
import { useState } from "react";
import { EXPENSE_CATEGORIES, expenseCategoryLabels, expenseStatusLabels, type ExpenseCategory, type ExpenseKind, type ExpenseRow, type MoneyOptions } from "@bmu/shared";
import { Badge, Button, Input, LoadState, PageTitle, Select } from "@/components/ui";
import { DataTable, Panel, StatRow, StatTile, Tabs } from "@/components/dash";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { day, Field, inr, Note, toPaise, todayIst } from "./kit";

const statusTone = { submitted: "amber", approved: "dark", rejected: "red", paid: "green" } as const;

function ExpenseForm({ kind, options, onDone }: { kind: ExpenseKind; options: MoneyOptions; onDone: () => void }) {
  const blank = { category: (kind === "vendor_bill" ? "software" : "travel") as ExpenseCategory, vendorName: "", billNumber: "", description: "", date: todayIst(), dueDate: "", amount: "", gst: "", tds: "", clientOrgId: "", engagementId: "", billable: false };
  const [f, setF] = useState(blank);
  const [msg, setMsg] = useState<{ error?: string; ok?: string }>({});
  const client = options.clients.find((c) => c.id === f.clientOrgId);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg({});
    try {
      await api.money.addExpense({
        kind,
        category: f.category,
        vendorName: f.vendorName || null,
        billNumber: f.billNumber || null,
        description: f.description,
        date: f.date,
        dueDate: f.dueDate || null,
        amountPaise: toPaise(f.amount),
        gstPaise: toPaise(f.gst),
        tdsPaise: toPaise(f.tds),
        clientOrgId: f.clientOrgId || null,
        engagementId: f.engagementId || null,
        billable: f.billable,
      });
      setF(blank);
      setMsg({ ok: kind === "vendor_bill" ? "Bill added." : "Claim sent for approval." });
      onDone();
    } catch (err) {
      setMsg({ error: (err as Error).message });
    }
  };
  return (
    <form onSubmit={submit} className="space-y-3" data-testid={`${kind}-form`}>
      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="Category">
          <Select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value as ExpenseCategory })}>
            {EXPENSE_CATEGORIES.map((c) => (
              <option key={c} value={c}>{expenseCategoryLabels[c]}</option>
            ))}
          </Select>
        </Field>
        {kind === "vendor_bill" && (
          <>
            <Field label="Vendor"><Input value={f.vendorName} onChange={(e) => setF({ ...f, vendorName: e.target.value })} required /></Field>
            <Field label="Bill number"><Input value={f.billNumber} onChange={(e) => setF({ ...f, billNumber: e.target.value })} /></Field>
          </>
        )}
        <Field label="Date"><Input type="date" value={f.date} max={todayIst()} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
        {kind === "vendor_bill" && <Field label="Pay by"><Input type="date" value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} /></Field>}
      </div>
      <Field label="What was it for"><Input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} required data-testid="expense-description" /></Field>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Amount before GST (₹)"><Input value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} inputMode="decimal" required data-testid="expense-amount" /></Field>
        <Field label="GST (₹)" hint="Claimed back, so not a cost"><Input value={f.gst} onChange={(e) => setF({ ...f, gst: e.target.value })} inputMode="decimal" /></Field>
        {kind === "vendor_bill" && <Field label="TDS to deduct (₹)"><Input value={f.tds} onChange={(e) => setF({ ...f, tds: e.target.value })} inputMode="decimal" /></Field>}
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Client (optional)">
          <Select value={f.clientOrgId} onChange={(e) => setF({ ...f, clientOrgId: e.target.value, engagementId: "" })} data-testid="expense-client">
            <option value="">Not for a client</option>
            {options.clients.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </Select>
        </Field>
        <Field label="Project">
          <Select value={f.engagementId} onChange={(e) => setF({ ...f, engagementId: e.target.value })} disabled={!client}>
            <option value="">{client ? "Any project" : "Pick a client first"}</option>
            {client?.projects.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </Select>
        </Field>
        <label className="flex items-end gap-2 pb-2 text-sm">
          <input type="checkbox" checked={f.billable} disabled={!f.clientOrgId} onChange={(e) => setF({ ...f, billable: e.target.checked })} data-testid="expense-billable" />
          Bill this to the client
        </label>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit">{kind === "vendor_bill" ? "Add bill" : "Send claim"}</Button>
        <Note {...msg} />
      </div>
    </form>
  );
}

export function ExpensesDesk({ mode }: { mode: "mine" | "finance" }) {
  const [tab, setTab] = useState<"all" | "expense" | "vendor_bill" | "submitted">(mode === "finance" ? "submitted" : "all");
  const list = useLoad(() => api.money.expenses({ mine: mode === "mine" ? "1" : undefined }), { live: ["Expense"] });
  const options = useLoad(() => api.money.options(), { live: false });
  const [adding, setAdding] = useState<ExpenseKind | null>(null);
  const [msg, setMsg] = useState<{ error?: string; ok?: string }>({});
  const act = (p: Promise<unknown>, ok: string) =>
    p.then(() => {
      setMsg({ ok });
      list.reload();
    }).catch((e: Error) => setMsg({ error: e.message }));
  if (!list.data) return <LoadState loading={list.loading} error={list.error} />;
  const d = list.data;
  const fin = mode === "finance" && d.canDecide;
  const rows = d.rows.filter((r) => tab === "all" || (tab === "submitted" ? r.status === "submitted" : r.kind === tab));
  const rebillable = [...new Map(d.rows.filter((r) => r.billable && !r.invoiceId && (r.status === "approved" || r.status === "paid") && r.clientId).map((r) => [r.clientId!, r.client ?? ""])).entries()];
  return (
    <>
      <PageTitle
        title={mode === "finance" ? "Expenses and bills" : "My expenses"}
        subtitle={mode === "finance" ? "Expense claims to approve, vendor bills to pay, and costs to re-bill to clients." : "Claim money you spent for work. Finance approves and pays it back."}
        action={
          <div className="flex gap-2">
            <Button variant={adding === "expense" ? "secondary" : "primary"} onClick={() => setAdding(adding === "expense" ? null : "expense")} data-testid="new-expense">Claim an expense</Button>
            {fin && <Button variant="secondary" onClick={() => setAdding(adding === "vendor_bill" ? null : "vendor_bill")} data-testid="new-bill">Add vendor bill</Button>}
          </div>
        }
      />
      <div className="space-y-6">
        <StatRow cols={4}>
          <StatTile label="Waiting for approval" value={inr(d.totals.waitingPaise)} tone={d.totals.waitingPaise ? "warn" : "default"} />
          <StatTile label="Approved, not paid" value={inr(d.totals.approvedUnpaidPaise)} />
          <StatTile label="Paid this month" value={inr(d.totals.paidThisMonthPaise)} />
          <StatTile label="To re-bill to clients" value={inr(d.totals.billableUnbilledPaise)} />
        </StatRow>
        {adding && options.data && (
          <Panel title={adding === "vendor_bill" ? "New vendor bill" : "New expense claim"}>
            <ExpenseForm kind={adding} options={options.data} onDone={() => { setAdding(null); list.reload(); }} />
          </Panel>
        )}
        <Note {...msg} />
        {fin && rebillable.length > 0 && (
          <Panel title="Re-bill to clients" subtitle="Approved costs marked “bill this to the client”. One invoice per client, before GST.">
            <div className="flex flex-wrap gap-2">
              {rebillable.map(([id, name]) => (
                <Button key={id} variant="secondary" onClick={() => act(api.money.rebillExpenses(id), `Invoice issued to ${name}.`)} data-testid="rebill">
                  Invoice {name}
                </Button>
              ))}
            </div>
          </Panel>
        )}
        <Panel
          flush
          title={mode === "finance" ? "All expenses and bills" : "My claims"}
          action={
            mode === "finance" ? (
              <Tabs value={tab} onChange={setTab} options={[{ value: "submitted", label: "To approve" }, { value: "all", label: "All" }, { value: "expense", label: "Expenses" }, { value: "vendor_bill", label: "Vendor bills" }]} />
            ) : undefined
          }
        >
          <DataTable<ExpenseRow>
            rows={rows}
            rowKey={(r) => r.id}
            empty="Nothing here."
            columns={[
              { key: "date", header: "Date", cell: (r) => <span className="whitespace-nowrap">{day(r.date)}</span> },
              { key: "what", header: "What", cell: (r) => <span>{r.kind === "vendor_bill" ? <b className="font-medium">{r.vendorName}: </b> : null}{r.description}<span className="block text-xs text-ink-muted">{expenseCategoryLabels[r.category]}{r.client ? ` · ${r.client}${r.project ? ` · ${r.project}` : ""}` : ""}{r.billable ? (r.invoiceId ? " · re-billed" : " · to re-bill") : ""}{mode === "finance" ? ` · by ${r.createdBy}` : ""}</span></span> },
              { key: "amt", header: "To pay", align: "right", cell: (r) => <span className="whitespace-nowrap font-medium">{inr(r.payablePaise)}{r.tdsPaise ? <span className="block text-xs font-normal text-ink-muted">after {inr(r.tdsPaise)} TDS</span> : null}</span> },
              { key: "st", header: "Status", cell: (r) => <span><Badge tone={statusTone[r.status]}>{expenseStatusLabels[r.status]}</Badge>{r.decisionNote && <span className="block text-xs text-ink-muted">{r.decisionNote}</span>}{r.dueDate && r.status === "approved" && <span className="block text-xs text-ink-muted">pay by {day(r.dueDate)}</span>}</span> },
              {
                key: "act",
                header: "",
                align: "right",
                cell: (r) => (
                  <div className="flex justify-end gap-2">
                    {fin && r.status === "submitted" && (
                      <>
                        <Button onClick={() => act(api.money.decideExpense(r.id, { approve: true }), "Approved.")} data-testid="approve-expense">Approve</Button>
                        <Button variant="ghost" onClick={() => { const note = window.prompt("Why is it rejected?"); if (note) act(api.money.decideExpense(r.id, { approve: false, note }), "Rejected."); }}>Reject</Button>
                      </>
                    )}
                    {fin && r.status === "approved" && (
                      <Button variant="secondary" onClick={() => { const ref = window.prompt("Payment reference (UPI / NEFT)"); if (ref) act(api.money.payExpense(r.id, { ref }), "Marked paid."); }} data-testid="pay-expense">Mark paid</Button>
                    )}
                    {r.status === "submitted" && mode === "mine" && (
                      <Button variant="ghost" onClick={() => window.confirm("Delete this claim?") && act(api.money.deleteExpense(r.id), "Deleted.")}>Delete</Button>
                    )}
                  </div>
                ),
              },
            ]}
          />
        </Panel>
      </div>
    </>
  );
}
