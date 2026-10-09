"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { SalesProfitabilityView, SalesProfitRow } from "@bmu/shared";
import { CsvButton, type Period } from "@/components/charts";
import { BarList, DataTable, Grid, Meter, Panel, StatRow, StatTile, Tabs, type Column } from "@/components/dash";
import { Button, Input } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { Field, FormNote, Insights, PeriodLine, PeriodPage, SortHeader, WithData, change, hours, inr, inrShort, rupees } from "../_sales/kit";

export default function ProfitabilityPage() {
  return (
    <PeriodPage title="Profitability" subtitle="What each client and service earns after paying for the team's time and creators. Amounts are before GST.">
      {(p) => <ProfitBody period={p} />}
    </PeriodPage>
  );
}

function ProfitBody({ period }: { period: Period }) {
  const state = useLoad(() => api.analytics.profitability({ from: period.from, to: period.to }));
  return <WithData state={state}>{(d) => <Profit d={d} reload={state.reload} />}</WithData>;
}

type SortKey = "name" | "revenuePaise" | "collectedPaise" | "hours" | "costPaise" | "marginPaise" | "marginPct" | "hourlyRatePaise";
const ROLE_LABELS: Record<string, string> = {
  default: "Everyone else (default)",
  founder: "Founder",
  admin: "Admin",
  account_manager: "Account manager",
  am_lead: "AM lead",
  strategist: "Strategist",
  producer: "Producer",
  qc: "QC reviewer",
  sales_manager: "Sales manager",
  sales_executive: "Sales executive",
};
const roleLabel = (r: string) => ROLE_LABELS[r] ?? r.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
const marginTone = (pct: number | null) => (pct === null ? "default" : pct < 0 ? "bad" : pct < 30 ? "warn" : "good");

function Profit({ d, reload }: { d: SalesProfitabilityView; reload: () => void }) {
  const [view, setView] = useState<"clients" | "services">("clients");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "revenuePaise", dir: -1 });
  const rows = view === "clients" ? d.clients : d.services;
  const sorted = useMemo(
    () =>
      [...rows].sort((a, b) => {
        const x = a[sort.key];
        const y = b[sort.key];
        if (typeof x === "string" || typeof y === "string") return String(x).localeCompare(String(y)) * sort.dir;
        return ((x ?? -Infinity) - (y ?? -Infinity)) * sort.dir;
      }),
    [rows, sort],
  );
  const t = d.totals;
  const p = d.prevTotals;
  const h = (label: string, k: SortKey) => <SortHeader label={label} k={k} sort={sort} onSort={setSort} />;
  const isClients = view === "clients";

  const columns: Column<SalesProfitRow>[] = [
    { key: "name", header: h(isClients ? "Client" : "Service", "name"), cell: (r) => r.name },
    { key: "rev", header: h("Revenue", "revenuePaise"), align: "right", cell: (r) => inr(r.revenuePaise) },
    { key: "col", header: h("Collected", "collectedPaise"), align: "right", cell: (r) => <span className="text-ink-muted">{inr(r.collectedPaise)}</span> },
    { key: "hrs", header: h("Hours", "hours"), align: "right", cell: (r) => hours(r.hours) },
    { key: "cost", header: h("Cost", "costPaise"), align: "right", cell: (r) => <span title={r.creatorCostPaise ? `Team ${inr(r.labourCostPaise)} + creators ${inr(r.creatorCostPaise)}` : undefined}>{inr(r.costPaise)}</span> },
    { key: "m", header: h("Margin", "marginPaise"), align: "right", cell: (r) => <span className={r.marginPaise < 0 ? "text-[#b4432c]" : ""}>{inr(r.marginPaise)}</span> },
    { key: "mp", header: h("Margin %", "marginPct"), className: "min-w-36", cell: (r) =>
        r.marginPct === null ? <span className="text-xs text-ink-muted">no revenue yet</span> : r.costPaise === 0 ? <span className="text-xs text-ink-muted">no hours logged</span> : <Meter value={r.marginPct} tone={marginTone(r.marginPct)} />,
    },
    { key: "hr", header: h("Per hour", "hourlyRatePaise"), align: "right", cell: (r) => (r.hourlyRatePaise === null ? "—" : inr(r.hourlyRatePaise)) },
  ];

  // Only clients with logged hours: without them the margin says nothing about how hard they are to serve.
  const ranked = d.clients.filter((c) => c.hours > 0);
  const best = [...ranked].sort((a, b) => b.marginPaise - a.marginPaise).slice(0, 5);
  const worst = [...ranked].sort((a, b) => (a.marginPct ?? -Infinity) - (b.marginPct ?? -Infinity)).slice(0, 5);

  return (
    <div className="space-y-8">
      <PeriodLine period={d.period} />
      <StatRow cols={5}>
        <StatTile label="Revenue" value={inrShort(t.revenuePaise)} delta={change(t.revenuePaise, p.revenuePaise)} hint={`${inrShort(t.collectedPaise)} collected`} href="/admin/finance/invoices" />
        <StatTile label="Delivery cost" value={inrShort(t.costPaise)} delta={change(t.costPaise, p.costPaise, { lowerIsBetter: true })} hint={t.creatorCostPaise ? `incl. ${inrShort(t.creatorCostPaise)} creators` : "team time with overhead"} />
        <StatTile label="Gross margin" value={t.marginPct === null ? "—" : `${Math.round(t.marginPct)}%`} delta={change(t.marginPct, p.marginPct, { unit: "pct" })} hint={inrShort(t.marginPaise)} tone={marginTone(t.marginPct)} />
        <StatTile label="Earned per hour" value={t.hourlyRatePaise === null ? "—" : inrShort(t.hourlyRatePaise)} delta={change(t.hourlyRatePaise, p.hourlyRatePaise)} hint={d.avgCostPerHourPaise ? `an hour costs ~${inrShort(d.avgCostPerHourPaise)}` : "revenue ÷ hours"} />
        <StatTile label="Hours logged" value={hours(t.hours)} delta={change(t.hours, p.hours)} hint="on client work" />
      </StatRow>
      <Insights items={d.insights} />

      <Panel
        className="min-w-0"
        title={isClients ? "By client" : "By service"}
        subtitle="Revenue = invoices raised in the period. Cost = hours × hourly cost × overhead, plus creator payouts. Click a header to sort."
        flush
        action={
          <div className="flex flex-wrap gap-2">
            <Tabs value={view} onChange={setView} options={[{ value: "clients", label: "Clients" }, { value: "services", label: "Services" }]} />
            <CsvButton
              rows={sorted}
              filename={`profitability-by-${view}`}
              columns={[
                { header: isClients ? "Client" : "Service", value: (r) => r.name },
                { header: "Revenue (₹)", value: (r) => rupees(r.revenuePaise) },
                { header: "Collected (₹, before GST)", value: (r) => rupees(r.collectedPaise) },
                { header: "Hours", value: (r) => r.hours },
                { header: "Team cost (₹)", value: (r) => rupees(r.labourCostPaise) },
                { header: "Creator cost (₹)", value: (r) => rupees(r.creatorCostPaise) },
                { header: "Margin (₹)", value: (r) => rupees(r.marginPaise) },
                { header: "Margin %", value: (r) => r.marginPct },
                { header: "Revenue per hour (₹)", value: (r) => (r.hourlyRatePaise === null ? "" : rupees(r.hourlyRatePaise)) },
              ]}
            />
          </div>
        }
      >
        <DataTable rows={sorted} rowKey={(r) => r.id} rowHref={isClients ? (r) => `/team/clients/${r.id}` : undefined} columns={columns} empty="No invoices or logged hours in this period." />
      </Panel>

      <Grid>
        <Panel className="min-w-0" title="Most profitable clients" subtitle="Margin in this period, clients with logged hours">
          <BarList items={best.filter((c) => c.marginPaise > 0).map((c, i) => ({ label: c.name, value: c.marginPaise, href: `/team/clients/${c.id}`, highlight: i === 0, note: c.marginPct === null ? undefined : `${Math.round(c.marginPct)}%` }))} format={inrShort} />
        </Panel>
        <Panel className="min-w-0" title="Least profitable clients" subtitle="Lowest margin % first; red means we lose money">
          <ul className="space-y-3">
            {worst.map((c) => (
              <li key={c.id} className="flex items-baseline justify-between gap-3 text-sm">
                <Link href={`/team/clients/${c.id}`} className="truncate hover:underline">
                  {c.name}
                </Link>
                <span className={`shrink-0 tabular-nums ${c.marginPaise < 0 ? "text-[#b4432c]" : (c.marginPct ?? 100) < 30 ? "text-[#9a6b00]" : "text-ink-muted"}`}>
                  {c.marginPct === null ? "no revenue · " : `${Math.round(c.marginPct)}% · `}
                  {inr(c.marginPaise)}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      </Grid>

      <Panel className="min-w-0" title="Where the hours go" subtitle="Hours logged and their cost by role, including overhead">
        <BarList items={d.byRole.map((r) => ({ label: roleLabel(r.role), value: r.costPaise, note: `${hours(r.hours)} at ${inrShort(r.ratePaise)}/h` }))} format={inrShort} />
      </Panel>

      <CostEditor d={d} onSaved={reload} />
    </div>
  );
}

function CostEditor({ d, onSaved }: { d: SalesProfitabilityView; onSaved: () => void }) {
  const keys = Object.keys(d.costRates.hourlyPaise).sort((a, b) => (a === "default" ? 1 : b === "default" ? -1 : roleLabel(a).localeCompare(roleLabel(b))));
  const [rates, setRates] = useState<Record<string, string>>(() => Object.fromEntries(keys.map((k) => [k, String(Math.round(d.costRates.hourlyPaise[k] / 100))])));
  const [overhead, setOverhead] = useState(String(d.costRates.overheadPct));
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ error?: string; ok?: string }>({});

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const hourlyPaise: Record<string, number> = {};
    for (const k of keys) {
      const n = Number(rates[k]);
      if (!Number.isFinite(n) || n < 0) return setNote({ error: `Enter an hourly cost in rupees for ${roleLabel(k)}.` });
      hourlyPaise[k] = Math.round(n * 100);
    }
    const o = Number(overhead);
    if (!Number.isFinite(o) || o < 0 || o > 200) return setNote({ error: "Overhead must be between 0 and 200%." });
    setBusy(true);
    setNote({});
    try {
      await api.settings.save("costRates", { hourlyPaise, overheadPct: o });
      setNote({ ok: "Saved. Costs and margins are recalculated." });
      onSaved();
    } catch (err) {
      setNote({ error: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Hourly cost of the team" subtitle={d.canEdit ? "What one hour of each role costs us (salary and benefits), plus an overhead for rent, tools and admin." : "Only Founder, Admin and Finance can change these."}>
      <form onSubmit={save} className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {keys.map((k) => (
            <Field key={k} label={`${roleLabel(k)} (₹/hour)`}>
              <Input type="number" min={0} value={rates[k]} onChange={(e) => setRates({ ...rates, [k]: e.target.value })} disabled={!d.canEdit} />
            </Field>
          ))}
          <Field label="Overhead (%)" hint="added on top of every hour">
            <Input type="number" min={0} max={200} value={overhead} onChange={(e) => setOverhead(e.target.value)} disabled={!d.canEdit} />
          </Field>
        </div>
        {d.canEdit && (
          <div className="flex flex-wrap items-center gap-4">
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </Button>
            <FormNote error={note.error} ok={note.ok} />
          </div>
        )}
      </form>
    </Panel>
  );
}
