"use client";

import Link from "next/link";
import { useState } from "react";
import type { SalesForecastView } from "@bmu/shared";
import { CsvButton, LineChart } from "@/components/charts";
import { DataTable, Grid, Panel, StatRow, StatTile } from "@/components/dash";
import { Badge, Button, Input, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { Field, FormNote, Insights, WithData, inr, inrShort, rupees } from "../_sales/kit";

const STAGES: { key: string; label: string }[] = [
  { key: "new", label: "New" },
  { key: "contacted", label: "Contacted" },
  { key: "discovery", label: "Discovery" },
  { key: "proposal_sent", label: "Proposal sent" },
];

export default function ForecastPage() {
  const state = useLoad(() => api.analytics.forecast());
  return (
    <>
      <PageTitle title="Revenue Forecast" subtitle="What the next 6 months should bring in: retainers we already have, project balances due, and open deals weighted by how likely they are to close. Before GST." />
      <WithData state={state}>{(d) => <Forecast d={d} reload={state.reload} />}</WithData>
    </>
  );
}

function Forecast({ d, reload }: { d: SalesForecastView; reload: () => void }) {
  const future = d.months.filter((m) => m.future);
  return (
    <div className="space-y-8">
      <StatRow cols={4}>
        <StatTile label="Expected, next 6 months" value={inrShort(d.totals.expectedPaise)} hint={d.totals.targetPaise ? `target ${inrShort(d.totals.targetPaise)}` : "no target set"} tone={d.totals.targetPaise && d.totals.expectedPaise >= d.totals.targetPaise ? "good" : "default"} />
        <StatTile label="Already committed" value={inrShort(d.totals.committedPaise)} hint={`${inrShort(d.mrrPaise)} a month in retainers`} />
        <StatTile label="Weighted pipeline" value={inrShort(d.totals.weightedPaise)} hint={`${d.deals.length} open deal${d.deals.length === 1 ? "" : "s"}`} />
        <StatTile label="Worst to best case" value={`${inrShort(d.totals.worstPaise)} – ${inrShort(d.totals.bestPaise)}`} hint={d.atRiskMrrPaise ? `${inrShort(d.atRiskMrrPaise)}/month at risk` : "no retainers at risk"} tone={d.atRiskMrrPaise ? "warn" : "default"} />
      </StatRow>

      <Panel className="min-w-0" title="Last 6 months and the next 6" subtitle="Solid line: invoiced. Dashed: expected. Shaded: worst to best case.">
        <LineChart
          labels={d.months.map((m) => m.label)}
          splitAt={d.splitAt}
          series={[
            { key: "actual", label: "Invoiced", values: d.months.map((m) => m.actualPaise) },
            { key: "expected", label: "Expected", values: d.months.map((m) => m.expectedPaise), color: "green", dashed: true },
            { key: "committed", label: "Committed", values: d.months.map((m) => m.committedPaise), color: "grey", dashed: true },
          ]}
          band={{ low: d.months.map((m) => m.worstPaise), high: d.months.map((m) => m.bestPaise), label: "Worst – best case" }}
          target={d.targetPaise ? { value: d.targetPaise, label: `Monthly target ${inrShort(d.targetPaise)}` } : undefined}
          format={inrShort}
          height={240}
        />
        <Insights items={d.insights} />
        <p className="mt-4 text-xs text-ink-muted">
          Committed = active retainers every month plus project balances in the month they are expected. Expected adds open deals × win chance for their stage. Best case uses 1.5× those chances (capped at 100%); worst case is committed minus retainers at risk.
        </p>
      </Panel>

      <Panel
        title="Month by month"
        flush
        action={
          <CsvButton
            rows={future}
            filename="revenue-forecast"
            columns={[
              { header: "Month", value: (m) => m.month },
              { header: "Committed (₹)", value: (m) => rupees(m.committedPaise ?? 0) },
              { header: "Weighted pipeline (₹)", value: (m) => rupees(m.weightedPaise ?? 0) },
              { header: "Expected (₹)", value: (m) => rupees(m.expectedPaise ?? 0) },
              { header: "Worst case (₹)", value: (m) => rupees(m.worstPaise ?? 0) },
              { header: "Best case (₹)", value: (m) => rupees(m.bestPaise ?? 0) },
              { header: "Target (₹)", value: () => rupees(d.targetPaise) },
            ]}
          />
        }
      >
        <DataTable
          rows={future}
          rowKey={(m) => m.month}
          columns={[
            { key: "m", header: "Month", cell: (m) => m.label },
            { key: "c", header: "Committed", align: "right", cell: (m) => inr(m.committedPaise ?? 0) },
            { key: "w", header: "Pipeline", align: "right", cell: (m) => inr(m.weightedPaise ?? 0) },
            { key: "e", header: "Expected", align: "right", cell: (m) => <span className="font-medium">{inr(m.expectedPaise ?? 0)}</span> },
            { key: "r", header: "Range", align: "right", cell: (m) => <span className="whitespace-nowrap text-ink-muted">{inrShort(m.worstPaise ?? 0)} – {inrShort(m.bestPaise ?? 0)}</span> },
            { key: "g", header: "vs target", align: "right", cell: (m) => (d.targetPaise ? <Gap v={(m.expectedPaise ?? 0) - d.targetPaise} /> : "—") },
          ]}
        />
      </Panel>

      <Panel
        title="Deals that drive the forecast"
        subtitle="Open leads, valued from their sent proposal (or the budget they gave us), for the next 6 months"
        flush
        action={
          <CsvButton
            rows={d.deals}
            filename="forecast-deals"
            columns={[
              { header: "Deal", value: (x) => x.name },
              { header: "Stage", value: (x) => x.stageLabel },
              { header: "Source", value: (x) => x.source },
              { header: "Valued from", value: (x) => (x.basis === "proposal" ? "Proposal" : "Budget") },
              { header: "Value next 6 months (₹)", value: (x) => rupees(x.valuePaise) },
              { header: "Win chance %", value: (x) => x.probabilityPct },
              { header: "Weighted (₹)", value: (x) => rupees(x.weightedPaise) },
              { header: "Expected close", value: (x) => x.expectedMonth },
            ]}
          />
        }
      >
        <DataTable
          rows={d.deals}
          rowKey={(x) => x.leadId}
          rowHref={(x) => (x.proposalId ? `/team/proposals/${x.proposalId}` : "/admin/pipeline")}
          empty="No open deals with a proposal or budget."
          columns={[
            { key: "n", header: "Deal", cell: (x) => x.name },
            { key: "s", header: "Stage", cell: (x) => <Badge tone={x.stage === "proposal_sent" ? "dark" : "neutral"}>{x.stageLabel}</Badge> },
            { key: "b", header: "Valued from", cell: (x) => <span className="text-ink-muted">{x.basis === "proposal" ? "Proposal" : "Budget"}</span> },
            { key: "v", header: "Value", align: "right", cell: (x) => inr(x.valuePaise) },
            { key: "p", header: "Chance", align: "right", cell: (x) => `${x.probabilityPct}%` },
            { key: "w", header: "Weighted", align: "right", cell: (x) => <span className="font-medium">{inr(x.weightedPaise)}</span> },
            { key: "c", header: "Close", align: "right", cell: (x) => <span className="whitespace-nowrap text-ink-muted">{x.expectedMonth}</span> },
          ]}
        />
      </Panel>

      <Grid>
        <Panel className="min-w-0" title="Committed retainers" subtitle={`${inr(d.mrrPaise)} a month`} flush>
          <DataTable
            rows={d.retainers}
            rowKey={(r) => r.engagementId}
            rowHref={(r) => `/team/clients/${r.clientId}`}
            empty="No active retainers."
            columns={[
              {
                key: "c",
                header: "Client",
                cell: (r) => (
                  <span className="block">
                    {r.client}
                    <span className="block text-xs font-normal text-ink-muted">
                      {r.service} · <span className="capitalize">{r.tier}</span>
                    </span>
                    {r.atRisk && (
                      <span className="mt-1 block">
                        <Badge tone="amber">{r.atRisk}</Badge>
                      </span>
                    )}
                  </span>
                ),
              },
              { key: "m", header: "Per month", align: "right", cell: (r) => inr(r.monthlyPaise) },
            ]}
          />
        </Panel>
        <Panel className="min-w-0" title="Project balances due" subtitle="Balance invoices not raised yet, by expected month" flush>
          <DataTable
            rows={d.balances}
            rowKey={(b) => b.engagementId}
            rowHref={(b) => `/team/clients/${b.clientId}`}
            empty="No project balances expected."
            columns={[
              {
                key: "c",
                header: "Client",
                cell: (b) => (
                  <span className="block">
                    {b.client}
                    <span className="block text-xs font-normal text-ink-muted">{b.service}</span>
                  </span>
                ),
              },
              { key: "m", header: "Month", cell: (b) => <span className="whitespace-nowrap text-ink-muted">{b.month}</span> },
              { key: "a", header: "Balance", align: "right", cell: (b) => inr(b.amountPaise) },
            ]}
          />
        </Panel>
      </Grid>

      <TargetsEditor d={d} onSaved={reload} />
    </div>
  );
}

function Gap({ v }: { v: number }) {
  return <span className={v >= 0 ? "text-[#5f8a12]" : "text-[#b4432c]"}>{v >= 0 ? "+" : "−"}{inrShort(Math.abs(v))}</span>;
}

function TargetsEditor({ d, onSaved }: { d: SalesForecastView; onSaved: () => void }) {
  const [probs, setProbs] = useState<Record<string, string>>(() => Object.fromEntries(STAGES.map((s) => [s.key, String(d.settings.stageProbabilityPct[s.key] ?? 0)])));
  const [target, setTarget] = useState(String(Math.round(d.settings.monthlyTargetPaise / 100)));
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ error?: string; ok?: string }>({});

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const stageProbabilityPct: Record<string, number> = { ...d.settings.stageProbabilityPct };
    for (const s of STAGES) {
      const n = Number(probs[s.key]);
      if (!Number.isFinite(n) || n < 0 || n > 100) return setNote({ error: `Win chance for “${s.label}” must be between 0 and 100.` });
      stageProbabilityPct[s.key] = n;
    }
    const rupeesTarget = Number(target.replace(/[,₹\s]/g, ""));
    if (!Number.isFinite(rupeesTarget) || rupeesTarget < 0) return setNote({ error: "Enter the monthly target in rupees." });
    setBusy(true);
    setNote({});
    try {
      await api.settings.save("forecast", { stageProbabilityPct, monthlyTargetPaise: Math.round(rupeesTarget * 100) });
      setNote({ ok: "Saved. The forecast now uses these numbers." });
      onSaved();
    } catch (err) {
      setNote({ error: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div id="targets">
      <Panel title="Targets and win chances" subtitle={d.canEdit ? "Used by this forecast and the Scorecard. Founder, Branch Manager and Finance can change them." : "Only Founder, Branch Manager and Finance can change these."}>
        <form onSubmit={save} className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <Field label="Monthly revenue target (₹)" hint="before GST">
              <Input inputMode="numeric" value={target} onChange={(e) => setTarget(e.target.value)} disabled={!d.canEdit} />
            </Field>
            {STAGES.map((s) => (
              <Field key={s.key} label={`Win chance: ${s.label} (%)`}>
                <Input type="number" min={0} max={100} value={probs[s.key]} onChange={(e) => setProbs({ ...probs, [s.key]: e.target.value })} disabled={!d.canEdit} />
              </Field>
            ))}
          </div>
          {d.canEdit && (
            <div className="flex flex-wrap items-center gap-4">
              <Button type="submit" disabled={busy}>
                {busy ? "Saving…" : "Save"}
              </Button>
              <FormNote error={note.error} ok={note.ok} />
            </div>
          )}
          <p className="text-xs text-ink-muted">
            Tip: compare with the real conversion on the <Link href="/admin/analytics/funnel" className="underline">Sales Funnel</Link> page.
          </p>
        </form>
      </Panel>
    </div>
  );
}
