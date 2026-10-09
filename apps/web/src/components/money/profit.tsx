"use client";
// v18 profit 2.0: per client, project, service and person, with the formula written out.
import { useState } from "react";
import type { ProfitRow } from "@bmu/shared";
import { Button, Input, LoadState, PageTitle } from "@/components/ui";
import { DataTable, Panel, StatRow, StatTile, Tabs } from "@/components/dash";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { addDays, dayYear, inr, todayIst } from "./kit";

const pct = (n: number | null) => (n === null ? "—" : `${Math.round(n)}%`);

function Rows({ rows, label }: { rows: ProfitRow[]; label: string }) {
  return (
    <DataTable<ProfitRow>
      rows={rows}
      rowKey={(r) => r.key}
      empty="Nothing billed or worked in this period."
      columns={[
        { key: "l", header: label, cell: (r) => <span>{r.label}{r.sub && <span className="block text-xs text-ink-muted">{r.sub}</span>}</span> },
        { key: "rev", header: "Revenue", align: "right", cell: (r) => inr(r.revenuePaise) },
        { key: "lab", header: "Team cost", align: "right", cell: (r) => <span>{inr(r.labourPaise)}<span className="block text-xs text-ink-muted">{r.hours}h</span></span> },
        { key: "cre", header: "Creators", align: "right", cell: (r) => inr(r.payoutsPaise) },
        { key: "exp", header: "Expenses", align: "right", cell: (r) => inr(r.expensesPaise) },
        { key: "pro", header: "Profit", align: "right", cell: (r) => <span className={`font-semibold ${r.profitPaise < 0 ? "text-[#b4432c]" : ""}`} data-testid="profit-cell">{inr(r.profitPaise)}</span> },
        { key: "m", header: "Margin", align: "right", cell: (r) => <span className={r.marginPct !== null && r.marginPct < 30 ? "text-[#9a6b00]" : ""}>{pct(r.marginPct)}</span> },
      ]}
    />
  );
}

export function ProfitDesk() {
  const [range, setRange] = useState({ from: `${addDays(`${todayIst().slice(0, 7)}-01`, -62).slice(0, 7)}-01`, to: todayIst() });
  const [applied, setApplied] = useState(range);
  const [tab, setTab] = useState<"client" | "project" | "service" | "person">("client");
  const view = useLoad(() => api.money.profit(applied), { live: false });
  const [key, setKey] = useState(0);
  if (!view.data) return <LoadState loading={view.loading} error={view.error} />;
  const v = view.data;
  return (
    <>
      <PageTitle title="Profit" subtitle={`What each client, project, service and person earns after team time, creators and expenses. ${dayYear(v.from)} to ${dayYear(v.to)}.`} />
      <div className="space-y-6" key={key}>
        <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); setApplied(range); setKey(key + 1); setTimeout(view.reload, 0); }}>
          <label className="text-xs text-ink-muted">From<Input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></label>
          <label className="text-xs text-ink-muted">To<Input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></label>
          <Button type="submit" variant="secondary">Show</Button>
        </form>
        <StatRow cols={5}>
          <StatTile label="Revenue" value={inr(v.totals.revenuePaise)} hint="before GST, after credit notes" />
          <StatTile label="Team cost" value={inr(v.totals.labourPaise)} hint={`${v.totals.hours} hours`} />
          <StatTile label="Creators and expenses" value={inr(v.totals.payoutsPaise + v.totals.expensesPaise)} />
          <StatTile label="Profit" value={inr(v.totals.profitPaise)} tone={v.totals.profitPaise < 0 ? "bad" : "good"} />
          <StatTile label="Margin" value={pct(v.totals.marginPct)} tone={v.totals.marginPct !== null && v.totals.marginPct < 30 ? "warn" : "default"} />
        </StatRow>
        <Panel flush title="Breakdown" action={<Tabs value={tab} onChange={setTab} options={[{ value: "client", label: "Clients" }, { value: "project", label: "Projects" }, { value: "service", label: "Services" }, { value: "person", label: "People" }]} />}>
          {tab === "client" && <Rows rows={v.byClient} label="Client" />}
          {tab === "project" && <Rows rows={v.byEngagement} label="Project" />}
          {tab === "service" && <Rows rows={v.byService} label="Service" />}
          {tab === "person" && (
            <DataTable
              rows={v.byPerson}
              rowKey={(r) => r.userId}
              empty="No time logged in this period."
              columns={[
                { key: "n", header: "Person", cell: (r) => <span>{r.name}<span className="block text-xs text-ink-muted">{r.role.replaceAll("_", " ")} · {inr(r.ratePaise)}/h</span></span> },
                { key: "h", header: "Hours", align: "right", cell: (r) => r.hours },
                { key: "c", header: "On clients", align: "right", cell: (r) => `${r.clientHours}h (${r.utilisationPct}%)` },
                { key: "cost", header: "Cost incl. overhead", align: "right", cell: (r) => inr(r.costPaise) },
              ]}
            />
          )}
        </Panel>
        <Panel title="How it is worked out">
          <ul className="list-disc space-y-1 pl-5 text-sm text-ink-muted">
            {v.formula.map((f) => <li key={f}>{f}</li>)}
          </ul>
        </Panel>
      </div>
    </>
  );
}
