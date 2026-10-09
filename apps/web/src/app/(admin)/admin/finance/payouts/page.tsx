"use client";

import { useState } from "react";
import type { PayoutRow, PayoutsView } from "@bmu/shared";
import { DataTable, Panel, StatRow, StatTile, Tabs, type Column } from "@/components/dash";
import { Badge, Button, Input, PageTitle, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { Field, FormNote, WithData, fmtDate, inr, rupeesInput } from "../../_insights/kit";

type Filter = "all" | "pending" | "paid";
const statusTone = { pending: "amber", paid: "green", on_hold: "neutral" } as const;
const statusLabel = { pending: "To pay", paid: "Paid", on_hold: "On hold" } as const;

export default function PayoutsPage() {
  const state = useLoad(() => api.finance.payouts());
  const [filter, setFilter] = useState<Filter>("all");
  return (
    <>
      <PageTitle title="Creator Payouts" subtitle="What we owe creators for approved work. 10% TDS is held back on every payout." />
      <WithData state={state}>
        {(v) => {
          const rows = v.rows.filter((r) => filter === "all" || (filter === "paid" ? r.status === "paid" : r.status !== "paid"));
          return (
            <div className="space-y-8">
              <StatRow cols={3}>
                <StatTile label="To pay" value={inr(v.pendingNetPaise)} tone={v.pendingNetPaise ? "warn" : "default"} hint="after TDS" />
                <StatTile label="Paid out" value={inr(v.paidNetPaise)} tone="good" hint="after TDS" />
                <StatTile label="TDS held" value={inr(v.tdsPaise)} hint="to deposit with the tax department" />
              </StatRow>
              <div className="grid gap-6 lg:grid-cols-3">
                <div className="min-w-0 lg:col-span-2">
                  <Panel className="min-w-0"
                    title="Payouts"
                    flush
                    action={
                      <Tabs
                        value={filter}
                        onChange={setFilter}
                        options={[
                          { value: "all", label: "All" },
                          { value: "pending", label: "To pay" },
                          { value: "paid", label: "Paid" },
                        ]}
                      />
                    }
                  >
                    <PayoutTable rows={rows} canEdit={v.canEdit} done={state.reload} />
                  </Panel>
                </div>
                {v.canEdit && <AddPayout view={v} done={state.reload} />}
              </div>
            </div>
          );
        }}
      </WithData>
    </>
  );
}

function PayoutTable({ rows, canEdit, done }: { rows: PayoutRow[]; canEdit: boolean; done: () => void }) {
  const [paying, setPaying] = useState<string | null>(null);
  const [ref, setRef] = useState("");
  const [error, setError] = useState<string | null>(null);
  async function pay(id: string) {
    setError(null);
    try {
      await api.finance.markPayoutPaid(id, ref);
      setPaying(null);
      setRef("");
      done();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const columns: Column<PayoutRow>[] = [
    { key: "creator", header: "Creator", cell: (r) => <div><p className="font-medium">{r.creator}</p>{r.brief && <p className="text-xs text-ink-muted">{r.brief}</p>}</div> },
    { key: "at", header: "Added", cell: (r) => <span className="whitespace-nowrap text-ink-muted">{fmtDate(r.createdAt)}</span> },
    { key: "fee", header: "Fee", align: "right", cell: (r) => inr(r.amountPaise) },
    { key: "tds", header: "TDS", align: "right", cell: (r) => <span className="text-ink-muted">{inr(r.tdsPaise)}</span> },
    { key: "net", header: "To pay", align: "right", cell: (r) => <span className="font-medium">{inr(r.netPaise)}</span> },
    {
      key: "status",
      header: "Status",
      cell: (r) =>
        r.status === "paid" ? (
          <div>
            <Badge tone="green">Paid</Badge>
            <p className="mt-1 whitespace-nowrap text-xs text-ink-muted">{fmtDate(r.paidAt)} · {r.ref}</p>
          </div>
        ) : canEdit && paying === r.id ? (
          <div className="flex min-w-56 flex-col gap-1">
            <div className="flex gap-1">
              <Input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="UTR / reference" className="!py-1 text-xs" autoFocus />
              <Button className="!px-2 !py-1 text-xs" onClick={() => pay(r.id)}>Save</Button>
              <Button variant="ghost" className="!px-2 !py-1 text-xs" onClick={() => setPaying(null)}>×</Button>
            </div>
            <FormNote error={error} />
          </div>
        ) : canEdit ? (
          <Button variant="secondary" className="whitespace-nowrap !px-3 !py-1 text-xs" onClick={() => { setPaying(r.id); setRef(""); setError(null); }}>
            Mark paid
          </Button>
        ) : (
          <Badge tone={statusTone[r.status]}>{statusLabel[r.status]}</Badge>
        ),
    },
  ];
  return <DataTable rows={rows} rowKey={(r) => r.id} columns={columns} empty="No payouts here yet. They appear when a creator brief is approved." />;
}

function AddPayout({ view, done }: { view: PayoutsView; done: () => void }) {
  const [creatorId, setCreatorId] = useState("");
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const paise = rupeesInput(amount);
  const tds = paise ? Math.round(paise * 0.1) : 0;
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!creatorId) return setError("Pick a creator");
    if (!paise) return setError("Enter the creator’s fee");
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      await api.finance.addPayout({ creatorId, amountPaise: paise });
      setOk("Payout added");
      setAmount("");
      done();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Panel className="min-w-0" title="Add a payout" subtitle="For work agreed outside a brief">
      {view.creators.length === 0 ? (
        <p className="text-sm text-ink-muted">No creators yet. Creators appear here once they join the creator portal.</p>
      ) : (
        <form onSubmit={submit} className="space-y-3">
          <Field label="Creator">
            <Select value={creatorId} onChange={(e) => setCreatorId(e.target.value)} className="w-full !py-2">
              <option value="">Pick a creator</option>
              {view.creators.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Fee (₹)" hint={paise ? `TDS 10%: ${inr(tds)} · to pay ${inr(paise - tds)}` : undefined}>
            <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
          <FormNote error={error} ok={ok} />
          <Button disabled={busy}>{busy ? "Adding…" : "Add payout"}</Button>
        </form>
      )}
    </Panel>
  );
}
