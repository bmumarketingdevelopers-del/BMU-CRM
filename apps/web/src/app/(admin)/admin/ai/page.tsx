"use client";

import { useState } from "react";
import { AI_FEATURE_GROUPS, aiGroupLabels, formatINR, type AiLogRow, type AiSettings, type AiUsageView } from "@bmu/shared";
import { CsvButton, Insight } from "@/components/charts";
import { ColumnChart, DataTable, Panel, StatRow, StatTile, type Column } from "@/components/dash";
import { Badge, Button, Input, LoadState, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { resetAiStatus } from "@/lib/ai";
import { useLoad } from "@/lib/use-load";

const when = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });
const num = (n: number) => n.toLocaleString("en-IN");

export default function AiCopilotPage() {
  const state = useLoad(() => api.ai.usage());
  const [fresh, setFresh] = useState<AiUsageView>();
  const data = fresh ?? state.data;
  return (
    <>
      <PageTitle
        title="AI Copilot"
        subtitle="BMU Hub's built-in assistant: Ask BMU, drafts on leads, deliverables and requests, the weekly digest and AI automations. It only ever uses data the signed-in person may see, and never sends anything by itself."
      />
      {!data ? <LoadState loading={state.loading} error={state.error} /> : <Body data={data} onSaved={setFresh} />}
    </>
  );
}

function Body({ data, onSaved }: { data: AiUsageView; onSaved: (d: AiUsageView) => void }) {
  const m = data.month;
  return (
    <div className="space-y-6">
      <ConnectionCard data={data} />
      <StatRow cols={4}>
        <StatTile label={`Calls in ${m.label}`} value={num(m.calls)} hint={`${num(m.aiCalls)} with AI · ${num(m.basicCalls)} basic`} />
        <StatTile
          label="Estimated cost this month"
          value={formatINR(m.costPaise)}
          hint={data.settings.monthlyBudgetPaise ? `${m.budgetPct ?? 0}% of the ${formatINR(data.settings.monthlyBudgetPaise)} budget` : "No monthly budget set"}
          tone={m.budgetPct !== null && m.budgetPct >= 90 ? "warn" : "default"}
        />
        <StatTile label="Tokens used (AI)" value={num(m.inputTokens + m.outputTokens)} hint={`${num(m.inputTokens)} in · ${num(m.outputTokens)} out`} />
        <StatTile label="Average AI answer time" value={m.avgLatencyMs === null ? "—" : `${(m.avgLatencyMs / 1000).toFixed(1)} s`} hint={`${m.blocked} blocked by limits · ${m.errors} errors`} tone={m.errors > 0 ? "warn" : "default"} />
      </StatRow>
      {m.budgetPct !== null && m.budgetPct >= 80 && <Insight tone="warn">This month&apos;s AI spend is at {m.budgetPct}% of the budget. When it reaches 100%, everyone gets basic suggestions until next month or until you raise the budget below.</Insight>}

      <SettingsForm initial={data.settings} canEdit={data.canEdit} onSaved={onSaved} />

      <div className="grid gap-6 [&>*]:min-w-0 lg:grid-cols-2">
        <Panel title="Calls per day" subtitle={`All AI Copilot use in ${m.label}, AI and basic.`}>
          {data.daily.calls.some((c) => c > 0) ? <ColumnChart data={data.daily.labels.map((label, i) => ({ label, value: data.daily.calls[i] }))} /> : <p className="text-sm text-ink-muted">No use yet this month.</p>}
        </Panel>
        <Panel title="By feature" flush>
          <DataTable
            rows={data.byFeature}
            rowKey={(r) => r.feature}
            empty="No use yet this month."
            columns={[
              { key: "f", header: "Feature", cell: (r) => r.label },
              { key: "c", header: "Calls", cell: (r) => num(r.calls), align: "right" },
              { key: "cost", header: "Cost", cell: (r) => formatINR(r.costPaise), align: "right" },
              { key: "l", header: "Avg time", cell: (r) => `${(r.avgLatencyMs / 1000).toFixed(1)} s`, align: "right" },
            ]}
          />
        </Panel>
      </div>
      <Panel title="By person" flush>
        <DataTable
          rows={data.byUser}
          rowKey={(r) => r.userId}
          empty="No one has used AI Copilot this month."
          columns={[
            { key: "n", header: "Person", cell: (r) => r.name },
            { key: "c", header: "Calls", cell: (r) => num(r.calls), align: "right" },
            { key: "cost", header: "Estimated cost", cell: (r) => formatINR(r.costPaise), align: "right" },
          ]}
        />
      </Panel>
      <Panel
        title="Recent calls"
        subtitle="Every AI call, basic answer and blocked attempt is logged."
        flush
        action={
          <CsvButton
            rows={data.recent}
            filename="ai-copilot-log.csv"
            columns={[
              { header: "When", value: (r) => r.at },
              { header: "Person", value: (r) => r.user },
              { header: "Feature", value: (r) => r.featureLabel },
              { header: "Mode", value: (r) => r.mode },
              { header: "Status", value: (r) => r.status },
              { header: "Model", value: (r) => r.model },
              { header: "Tokens in", value: (r) => r.inputTokens },
              { header: "Tokens out", value: (r) => r.outputTokens },
              { header: "Cost (paise)", value: (r) => r.costPaise },
              { header: "Time (ms)", value: (r) => r.latencyMs },
            ]}
          />
        }
      >
        <DataTable rows={data.recent} rowKey={(r) => r.id} empty="Nothing logged yet." columns={logColumns} />
      </Panel>
    </div>
  );
}

const statusTone = (s: string) => (s === "ok" ? "green" : s === "blocked" ? "amber" : s === "error" || s === "refused" ? "red" : "neutral");
const logColumns: Column<AiLogRow>[] = [
  { key: "at", header: "When", cell: (r) => when.format(new Date(r.at)) },
  { key: "u", header: "Person", cell: (r) => r.user ?? "—" },
  { key: "f", header: "Feature", cell: (r) => r.featureLabel },
  { key: "m", header: "Mode", cell: (r) => <Badge tone={r.mode === "ai" ? "dark" : "neutral"}>{r.mode === "ai" ? "AI" : "Basic"}</Badge> },
  { key: "s", header: "Status", cell: (r) => <span title={r.error ?? undefined}><Badge tone={statusTone(r.status) as "green"}>{r.status}</Badge></span> },
  { key: "t", header: "Tokens", cell: (r) => (r.inputTokens + r.outputTokens ? num(r.inputTokens + r.outputTokens) : "—"), align: "right" },
  { key: "c", header: "Cost", cell: (r) => (r.costPaise ? formatINR(r.costPaise) : "—"), align: "right" },
  { key: "l", header: "Time", cell: (r) => `${(r.latencyMs / 1000).toFixed(1)} s`, align: "right" },
];

function ConnectionCard({ data }: { data: AiUsageView }) {
  if (data.connected)
    return (
      <div className="flex flex-wrap items-center gap-3 border border-green bg-green/10 px-5 py-4 text-sm">
        <Badge tone="green">Connected</Badge>
        <span>
          AI is connected. Main model <code className="font-mono text-xs">{data.model}</code>, quick tasks <code className="font-mono text-xs">{data.fastModel}</code>.
        </span>
      </div>
    );
  return (
    <section className="border border-amber bg-amber/10 px-5 py-4 text-sm" aria-label="Connect AI">
      <p className="font-semibold">AI Copilot is running in basic mode</p>
      <p className="mt-1 text-ink-muted">Every feature already works with ready-made suggestions built from your data. Add an Anthropic API key to get full AI answers:</p>
      <ol className="mt-3 list-decimal space-y-1 pl-5">
        <li>
          Go to <span className="font-medium">console.anthropic.com</span>, sign in, open <span className="font-medium">API Keys</span> and create a key (it starts with <code className="font-mono text-xs">sk-ant-</code>).
        </li>
        <li>
          Open the file <code className="font-mono text-xs">apps/api/.env</code> in the BMU Hub folder and add a line: <code className="font-mono text-xs">ANTHROPIC_API_KEY=sk-ant-…</code>
        </li>
        <li>
          Stop BMU Hub (Ctrl + C in the terminal) and start it again with <code className="font-mono text-xs">pnpm dev</code>. This page will then say “Connected”.
        </li>
      </ol>
      <p className="mt-2 text-xs text-ink-muted">Keep the key private. Set a monthly budget below so spend never surprises you.</p>
    </section>
  );
}

function SettingsForm({ initial, canEdit, onSaved }: { initial: AiSettings; canEdit: boolean; onSaved: (d: AiUsageView) => void }) {
  const [s, setS] = useState(initial);
  const [budget, setBudget] = useState(String(initial.monthlyBudgetPaise / 100));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();
  const set = (p: Partial<AiSettings>) => setS({ ...s, ...p });

  async function save() {
    const rupees = Number(budget || 0);
    if (!Number.isFinite(rupees) || rupees < 0) return setMsg({ ok: false, text: "Enter the monthly budget in rupees (0 for no limit)." });
    setBusy(true);
    setMsg(undefined);
    try {
      const next = await api.ai.saveSettings({ ...s, monthlyBudgetPaise: Math.round(rupees * 100) });
      resetAiStatus();
      onSaved(next);
      setMsg({ ok: true, text: "Saved. Changes apply straight away." });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Settings" subtitle="Only the Founder and Admins can change these.">
      <fieldset disabled={!canEdit || busy} className="space-y-5">
        <label className="flex items-start gap-3 text-sm">
          <input type="checkbox" className="mt-1" checked={s.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
          <span>
            <span className="font-medium">AI Copilot is on for the organisation</span>
            <span className="block text-xs text-ink-muted">Switch off to hide every AI feature for everyone.</span>
          </span>
        </label>
        <div className="grid gap-4 sm:grid-cols-3">
          <label className="grid gap-1 text-sm">
            Monthly budget (₹)
            <Input type="number" min={0} step={100} value={budget} onChange={(e) => setBudget(e.target.value)} />
            <span className="text-xs text-ink-muted">Estimated. 0 = no limit. Above it, basic suggestions only.</span>
          </label>
          <label className="grid gap-1 text-sm">
            Monthly token limit
            <Input type="number" min={0} step={100000} value={s.monthlyTokenCap} onChange={(e) => set({ monthlyTokenCap: Math.max(0, Math.round(Number(e.target.value) || 0)) })} />
            <span className="text-xs text-ink-muted">0 = no limit.</span>
          </label>
          <label className="grid gap-1 text-sm">
            AI answers per person per hour
            <Input type="number" min={1} max={500} value={s.perUserPerHour} onChange={(e) => set({ perUserPerHour: Math.min(500, Math.max(1, Math.round(Number(e.target.value) || 1))) })} />
            <span className="text-xs text-ink-muted">Stops one person using up the budget.</span>
          </label>
        </div>
        <div>
          <p className="text-sm font-medium">Features</p>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {AI_FEATURE_GROUPS.map((g) => (
              <label key={g} className="flex items-start gap-2 border border-border px-3 py-2 text-sm">
                <input type="checkbox" className="mt-1" checked={s.features[g]} onChange={(e) => set({ features: { ...s.features, [g]: e.target.checked } })} />
                <span>{aiGroupLabels[g]}</span>
              </label>
            ))}
          </div>
        </div>
      </fieldset>
      {canEdit && (
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <Button onClick={save} disabled={busy}>
            {busy ? "Saving…" : "Save settings"}
          </Button>
          {msg && (
            <p className={`text-sm ${msg.ok ? "text-ink" : "text-red"}`} role={msg.ok ? "status" : "alert"}>
              {msg.text}
            </p>
          )}
        </div>
      )}
    </Panel>
  );
}
