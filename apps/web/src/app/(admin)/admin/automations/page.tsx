"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { AutomationOverview, AutomationRuleRow } from "@bmu/shared";
import { DataTable, Panel, StatRow, StatTile } from "@/components/dash";
import { Insight, LineChart, deltaVs } from "@/components/charts";
import { Badge, Button, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { Toggle, WithData, ago } from "./_parts/kit";

export default function AutomationsPage() {
  const state = useLoad(() => api.automations.overview());
  return (
    <WithData state={state}>
      {(data) => <Overview data={data} reload={state.reload} />}
    </WithData>
  );
}

function Overview({ data, reload }: { data: AutomationOverview; reload: () => void }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const { stats } = data;

  const act = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setNote(null);
    try {
      await fn();
    } catch (e) {
      setNote({ tone: "error", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const runNow = () =>
    act("run", async () => {
      const r = await api.automations.runNow();
      setNote({ tone: "ok", text: r.fired + r.failed + r.skipped === 0 ? `Checked ${r.rules} active rule${r.rules === 1 ? "" : "s"}. Nothing new to do right now.` : `Checked ${r.rules} rules: ${r.fired} done, ${r.failed} failed, ${r.skipped} skipped.` });
      reload();
    });

  const toggle = (r: AutomationRuleRow, on: boolean) =>
    act(r.id, async () => {
      await api.automations.setEnabled(r.id, on);
      reload();
    });

  const addTemplate = (key: string) =>
    act(key, async () => {
      const r = await api.automations.fromTemplate(key);
      router.push(`/admin/automations/${r.id}`);
    });

  const totals = data.daily.reduce((s, d) => ({ success: s.success + d.success, failed: s.failed + d.failed, skipped: s.skipped + d.skipped }), { success: 0, failed: 0, skipped: 0 });
  const total30 = totals.success + totals.failed + totals.skipped;
  const successRate = total30 ? Math.round((totals.success / total30) * 100) : null;
  const busiest = data.topRules[0];
  const worst = [...data.rules].sort((a, b) => b.failures30d - a.failures30d)[0];

  return (
    <>
      <PageTitle
        title="Automations"
        subtitle="When something happens, BMU Hub does the follow-up for you: reminders, alerts, tasks and hand-offs."
        action={
          data.canManage && (
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={runNow} disabled={busy === "run"}>
                {busy === "run" ? "Running…" : "Run now"}
              </Button>
              <Link href="/admin/automations/new" className="bg-charcoal px-4 py-2 text-sm font-medium text-ivory hover:opacity-90">
                New rule
              </Link>
            </div>
          )
        }
      />
      <p className="mb-6 border border-border bg-canvas/60 px-4 py-3 text-sm">
        New: <Link href="/admin/workflows" className="font-medium underline">Workflows</Link> do everything rules do, plus waits, checks with two paths and approvals. You can move these rules into workflows from the Workflows page.
      </p>
      {note && <p className={`mb-6 border px-4 py-3 text-sm ${note.tone === "ok" ? "border-green bg-green/10" : "border-red bg-red/10"}`}>{note.text}</p>}
      {!data.canManage && <p className="mb-6 border border-border bg-canvas/60 px-4 py-3 text-sm text-ink-muted">You can see the rules and what they did. Only the Founder and Branch Managers can change them.</p>}

      <div className="space-y-8">
        <StatRow cols={4}>
          <StatTile label="Active rules" value={stats.activeRules} hint={`of ${stats.totalRules} rule${stats.totalRules === 1 ? "" : "s"}`} tone={stats.activeRules ? "good" : "default"} />
          <StatTile label="Runs, last 7 days" value={stats.runs7d} delta={deltaVs(stats.runs7d, stats.runsPrev7d)} href="/admin/automations/runs" />
          <StatTile label="Actions done, last 7 days" value={stats.actions7d} hint="alerts, tasks, messages" />
          <StatTile label="Failures, last 7 days" value={stats.failures7d} tone={stats.failures7d ? "bad" : "default"} hint={stats.failures7d ? "open the log to see why" : "all good"} href="/admin/automations/runs" />
        </StatRow>

        <Panel title="Runs per day" subtitle="Last 30 days. Each run is one rule acting on one record." className="min-w-0">
          <LineChart
            labels={data.daily.map((d) => new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short" }).format(new Date(`${d.date}T12:00:00+05:30`)))}
            series={[
              { key: "success", label: "Done", values: data.daily.map((d) => d.success), color: "dark", area: true },
              { key: "failed", label: "Failed", values: data.daily.map((d) => d.failed), color: "red" },
              { key: "skipped", label: "Skipped", values: data.daily.map((d) => d.skipped), color: "grey", dashed: true },
            ]}
            height={180}
          />
          {total30 > 0 ? (
            <Insight tone={totals.failed / total30 > 0.1 ? "warn" : "good"}>
              Rules ran {total30} times in 30 days and {successRate}% went through cleanly.
              {busiest && ` The busiest rule is "${busiest.name}" with ${busiest.runs} runs.`}
              {worst && worst.failures30d > 0 && ` "${worst.name}" failed ${worst.failures30d} time${worst.failures30d === 1 ? "" : "s"}; check the log.`}
            </Insight>
          ) : (
            <Insight>No runs in the last 30 days yet. Switch on a rule or pick a recipe below.</Insight>
          )}
        </Panel>

        <Panel title="Rules" subtitle="Read each rule as a sentence. Switch one off to pause it; it picks up new records again when switched back on." flush className="min-w-0">
          <DataTable<AutomationRuleRow>
            rows={data.rules}
            rowKey={(r) => r.id}
            empty="No rules yet. Start from a recipe below or create your own."
            columns={[
              {
                key: "rule",
                header: "Rule",
                className: "min-w-72",
                cell: (r) => (
                  <Link href={`/admin/automations/${r.id}`} className="block hover:underline">
                    <span className="font-medium">{r.name}</span>
                    <span className="mt-0.5 block text-xs leading-relaxed text-ink-muted">{r.sentence}</span>
                  </Link>
                ),
              },
              { key: "area", header: "Area", cell: (r) => <Badge>{r.area}</Badge> },
              {
                key: "on",
                header: "On",
                cell: (r) => (
                  <span className="flex items-center gap-2">
                    <Toggle on={r.enabled} label={`${r.enabled ? "Switch off" : "Switch on"} ${r.name}`} disabled={busy === r.id} onChange={data.canManage ? (v) => toggle(r, v) : undefined} />
                    <span className="text-xs text-ink-muted">{r.enabled ? "On" : "Off"}</span>
                  </span>
                ),
              },
              { key: "last", header: "Last run", cell: (r) => <span className="whitespace-nowrap text-ink-muted">{ago(r.lastRunAt)}</span> },
              { key: "runs", header: "Runs", align: "right", cell: (r) => r.runCount },
              { key: "fail", header: "Failed (30d)", align: "right", cell: (r) => (r.failures30d ? <span className="text-[#b4432c]">{r.failures30d}</span> : <span className="text-ink-muted">0</span>) },
            ]}
          />
        </Panel>

        <section>
          <div className="mb-4">
            <h2 className="text-[15px] font-semibold tracking-tight">Ready-made recipes</h2>
            <p className="mt-0.5 text-xs text-ink-muted">Common agency follow-ups. One click adds the rule, switched on, and you can change anything after.</p>
          </div>
          <div className="grid gap-px border border-border bg-border sm:grid-cols-2 xl:grid-cols-3">
            {data.templates.map((t) => (
              <article key={t.key} className="flex flex-col bg-surface-raised p-5">
                <div className="flex items-start justify-between gap-3">
                  <h3 className="text-sm font-semibold">{t.name}</h3>
                  <span className="shrink-0 text-[11px] uppercase tracking-[0.1em] text-ink-muted">{t.area}</span>
                </div>
                <p className="mt-1.5 text-sm text-ink-muted">{t.description}</p>
                <p className="mt-3 border-l-2 border-border pl-3 text-xs leading-relaxed text-ink">{t.sentence}</p>
                <div className="mt-auto flex items-center justify-between gap-3 pt-4">
                  {t.installed ? <Badge tone="green">In use</Badge> : <span />}
                  {data.canManage && (
                    <Button variant={t.installed ? "ghost" : "secondary"} className="px-3 py-1.5" disabled={busy === t.key} onClick={() => addTemplate(t.key)}>
                      {busy === t.key ? "Adding…" : t.installed ? "Add another" : "Use this"}
                    </Button>
                  )}
                </div>
              </article>
            ))}
          </div>
        </section>
      </div>
    </>
  );
}
