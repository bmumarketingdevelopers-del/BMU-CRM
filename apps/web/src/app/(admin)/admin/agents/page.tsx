"use client";

import Link from "next/link";
import { useState } from "react";
import { agentPolicyLabels, formatINR, type AgentAskResult, type AgentEvalResult, type AgentKey, type AgentsOverview, type AgentView } from "@bmu/shared";
import { AiText } from "@/components/ai/ai-text";
import { RunsTable } from "@/components/agents/agent-run";
import { Panel, StatRow, StatTile } from "@/components/dash";
import { Badge, Button, Input, PageTitle, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { Toggle, WithData, ago } from "../automations/_parts/kit";

export default function AgentsPage() {
  const state = useLoad(() => api.agents.overview(), { live: ["Agent", "AgentRun", "AgentProposal"] });
  return <WithData state={state}>{(data) => <Overview data={data} reload={state.reload} />}</WithData>;
}

type Note = { tone: "ok" | "error"; text: string } | null;

function Overview({ data, reload }: { data: AgentsOverview; reload: () => void }) {
  const [note, setNote] = useState<Note>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const act = async (key: string, fn: () => Promise<string | void>) => {
    setBusy(key);
    setNote(null);
    try {
      const text = await fn();
      if (text) setNote({ tone: "ok", text });
      reload();
    } catch (e) {
      setNote({ tone: "error", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };
  const on = data.agents.filter((a) => a.enabled).length;
  const spent = data.agents.reduce((s, a) => s + a.spentPaise, 0);

  return (
    <>
      <PageTitle
        title="AI Agents"
        subtitle="Agents that watch for new leads and requests, chase work and answer questions. They only do what the person they act for may do, and anything client-facing or about money waits for you."
        action={
          <div className="flex flex-wrap gap-2">
            <Link href="/team/agent-inbox" className="border border-border px-4 py-2 text-sm hover:border-charcoal">
              Agent Inbox{data.pendingProposals ? ` (${data.pendingProposals})` : ""}
            </Link>
            <Link href="/admin/agents/runs" className="border border-border px-4 py-2 text-sm hover:border-charcoal">
              Run log
            </Link>
          </div>
        }
      />
      {note && <p className={`mb-6 border px-4 py-3 text-sm ${note.tone === "ok" ? "border-green bg-green/10" : "border-red bg-red/10"}`}>{note.text}</p>}
      {data.notice && <p className="mb-6 border border-border bg-canvas/60 px-4 py-3 text-sm text-ink-muted">{data.notice}</p>}

      <div className="space-y-8">
        <StatRow cols={4}>
          <StatTile label="Agents on" value={on} hint={`of ${data.agents.length}`} tone={on ? "good" : "default"} />
          <StatTile label="Waiting in the Agent Inbox" value={data.pendingProposals} href="/team/agent-inbox" tone={data.pendingProposals ? "warn" : "default"} />
          <StatTile label="Runs this month" value={data.agents.reduce((s, a) => s + a.runsThisMonth, 0)} href="/admin/agents/runs" />
          <StatTile label="AI cost this month" value={formatINR(spent)} hint={data.aiMode === "ai" ? "estimate" : "basic mode is free"} />
        </StatRow>

        <div className="grid gap-px border border-border bg-border lg:grid-cols-2" data-testid="agent-cards">
          {data.agents.map((a) => (
            <AgentCard key={a.key} a={a} people={data.people} busy={busy} act={act} />
          ))}
        </div>

        <AskAnalyst enabled={data.agents.find((a) => a.key === "analyst")!.enabled} />

        <Panel
          title="Recent runs"
          flush
          action={
            <Link href="/admin/agents/runs" className="text-sm text-ink-muted hover:text-ink">
              All runs →
            </Link>
          }
        >
          <RunsTable rows={data.recent.slice(0, 15)} />
        </Panel>

        <div className="grid gap-6 lg:grid-cols-2">
          <SafetyChecks />
          <Panel
            title="Knowledge"
            subtitle="What agents search when they need facts. Keyword search with English word forms (plan, plans, planning); every answer links to where it came from."
            action={
              <Button variant="secondary" className="px-3 py-1.5" disabled={busy === "knowledge"} onClick={() => act("knowledge", async () => `Knowledge refreshed: ${(await api.agents.refreshKnowledge()).chunks} pieces.`)}>
                {busy === "knowledge" ? "Refreshing…" : "Refresh now"}
              </Button>
            }
          >
            <ul className="space-y-1 text-sm">
              {data.knowledge.sources.map((s) => (
                <li key={s.type} className="flex justify-between gap-3">
                  <span>{s.label}</span>
                  <span className="tabular-nums text-ink-muted">{s.count}</span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-ink-muted">{data.knowledge.refreshedAt ? `Last refreshed ${ago(data.knowledge.refreshedAt)}.` : "Built the first time an agent searches."} Refreshes every hour on its own.</p>
          </Panel>
        </div>

        <section>
          <h2 className="mb-3 text-[15px] font-semibold tracking-tight">Coming later</h2>
          <div className="grid gap-px border border-border bg-border sm:grid-cols-3">
            {data.later.map((l) => (
              <article key={l.key} className="bg-surface-raised p-5 opacity-70">
                <h3 className="text-sm font-semibold">{l.label}</h3>
                <p className="mt-1 text-sm text-ink-muted">{l.summary}</p>
              </article>
            ))}
          </div>
        </section>
      </div>
    </>
  );
}

function AgentCard({ a, people, busy, act }: { a: AgentView; people: AgentsOverview["people"]; busy: string | null; act: (key: string, fn: () => Promise<string | void>) => Promise<void> }) {
  const [budget, setBudget] = useState(String(Math.round(a.monthlyBudgetPaise / 100)));
  const [subject, setSubject] = useState("");
  const update = (patch: Parameters<typeof api.agents.update>[1]) =>
    act(a.key, async () => {
      await api.agents.update(a.key, patch);
    });
  const runNow = () =>
    act(`run-${a.key}`, async () => {
      const runs = await api.agents.runNow(a.key, subject.trim() || undefined);
      return runs.length
        ? `${a.label} ran ${runs.length === 1 ? "once" : `${runs.length} times`}: ${runs
            .map((r) => r.summary)
            .filter(Boolean)
            .join(" · ")}`
        : `${a.label} found nothing new to do.`;
    });
  const needsSubject: AgentKey[] = ["sales_assistant", "request_triage"];
  return (
    <article className="flex flex-col bg-surface-raised p-5" data-testid={`agent-${a.key}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-[15px] font-semibold">{a.label}</h3>
          <p className="mt-1 text-sm text-ink-muted">{a.summary}</p>
        </div>
        <span className="flex shrink-0 items-center gap-2">
          <Toggle on={a.enabled} label={`${a.enabled ? "Switch off" : "Switch on"} ${a.label}`} disabled={busy === a.key} onChange={(v) => update({ enabled: v })} />
          <span className="text-xs text-ink-muted">{a.enabled ? "On" : "Off"}</span>
        </span>
      </div>
      <p className="mt-3 text-xs text-ink-muted">
        <b className="font-medium text-ink">When:</b> {a.when}
      </p>
      <ul className="mt-3 space-y-1 text-xs">
        {a.actions.map((x) => (
          <li key={x.action} className="flex items-center justify-between gap-3">
            <span>{x.label}</span>
            <Badge tone={x.policy === "auto" ? "green" : x.policy === "confirm" ? "amber" : "red"}>{agentPolicyLabels[x.policy]}</Badge>
          </li>
        ))}
      </ul>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="text-xs text-ink-muted">
          Acts for (it can only do what they can)
          <Select aria-label={`${a.label} acts for`} value={a.actsFor?.id ?? ""} disabled={busy === a.key} onChange={(e) => update({ actsForUserId: e.target.value || null })} className="mt-1 w-full">
            <option value="">Nobody (agent can&apos;t act)</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {p.roles.map((r) => r.replaceAll("_", " ")).join(", ")}
              </option>
            ))}
          </Select>
        </label>
        <label className="text-xs text-ink-muted">
          Monthly AI budget (₹, 0 = no limit)
          <span className="mt-1 flex gap-2">
            <Input type="number" min={0} aria-label={`${a.label} monthly budget`} value={budget} onChange={(e) => setBudget(e.target.value)} className="w-full" />
            {Number(budget) * 100 !== a.monthlyBudgetPaise && (
              <Button variant="secondary" className="px-3 py-1" onClick={() => update({ monthlyBudgetPaise: Math.max(0, Math.round(Number(budget) || 0) * 100) })}>
                Save
              </Button>
            )}
          </span>
        </label>
      </div>
      <p className="mt-3 text-xs text-ink-muted">
        This month: {a.runsThisMonth} run{a.runsThisMonth === 1 ? "" : "s"} · {formatINR(a.spentPaise)}
        {a.monthlyBudgetPaise ? ` of ${formatINR(a.monthlyBudgetPaise)}` : ""} · last run {ago(a.lastRunAt)} · 👍 {a.thumbsUp} 👎 {a.thumbsDown}
      </p>
      <div className="mt-auto flex flex-wrap items-center gap-2 pt-4">
        {needsSubject.includes(a.key) && (
          <Input aria-label={`${a.label} record id`} placeholder={a.key === "sales_assistant" ? "Lead id (optional)" : "Request id (optional)"} value={subject} onChange={(e) => setSubject(e.target.value)} className="w-48" />
        )}
        {a.key !== "analyst" || a.enabled ? (
          <Button variant="secondary" className="px-3 py-1.5" disabled={busy === `run-${a.key}`} onClick={runNow}>
            {busy === `run-${a.key}` ? "Running…" : a.key === "analyst" ? "Write this month's report" : "Run now"}
          </Button>
        ) : null}
        <Link href={`/admin/agents/runs?agent=${a.key}`} className="ml-auto text-xs text-ink-muted hover:text-ink">
          Runs →
        </Link>
      </div>
    </article>
  );
}

function AskAnalyst({ enabled }: { enabled: boolean }) {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<AgentAskResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ask = async () => {
    setBusy(true);
    setError(null);
    try {
      setRes(await api.agents.ask({ question: q }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel title="Ask the Analyst" subtitle="Answers from your data and knowledge, using only what you can see, with links to every source.">
      {!enabled && <p className="mb-3 text-sm text-ink-muted">Switch the Analyst on above to ask questions.</p>}
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (q.trim().length >= 2) void ask();
        }}
      >
        <Input aria-label="Question for the Analyst" placeholder="e.g. What does our onboarding SOP say about kickoff calls?" value={q} onChange={(e) => setQ(e.target.value)} className="min-w-64 flex-1" disabled={!enabled} />
        <Button type="submit" disabled={!enabled || busy || q.trim().length < 2}>
          {busy ? "Thinking…" : "Ask"}
        </Button>
      </form>
      {error && <p className="mt-3 border border-red bg-red/10 px-3 py-2 text-sm">{error}</p>}
      {res && (
        <div className="mt-4 border-t border-border pt-4" data-testid="analyst-answer">
          {res.notice && <p className="mb-2 text-xs text-ink-muted">{res.notice}</p>}
          <AiText text={res.text} />
          {res.citations.length > 0 && (
            <div className="mt-3">
              <p className="text-[11px] uppercase tracking-[0.1em] text-ink-muted">Sources</p>
              <ul className="mt-1 space-y-0.5 text-sm">
                {res.citations.map((c) => (
                  <li key={c.href}>
                    <Link href={c.href} className="hover:underline">
                      {c.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <Link href={`/admin/agents/runs/${res.runId}`} className="mt-3 inline-block text-xs text-ink-muted hover:text-ink">
            See how it found this →
          </Link>
        </div>
      )}
    </Panel>
  );
}

function SafetyChecks() {
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<AgentEvalResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setRes(await api.agents.evals());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel
      title="Safety checks"
      subtitle="Runs the agents against a test lead with a model that misbehaves on purpose, and checks every rule held. Free, and leaves nothing behind."
      action={
        <Button variant="secondary" className="px-3 py-1.5" disabled={busy} onClick={run}>
          {busy ? "Checking…" : "Run safety checks"}
        </Button>
      }
    >
      {error && <p className="border border-red bg-red/10 px-3 py-2 text-sm">{error}</p>}
      {!res && !error && <p className="text-sm text-ink-muted">The same checks run in the automated tests on every build.</p>}
      {res && (
        <div data-testid="safety-results">
          <p className={`mb-3 border px-3 py-2 text-sm ${res.passed ? "border-green bg-green/10" : "border-red bg-red/10"}`}>{res.passed ? `All ${res.total} checks passed.` : `${res.failed} of ${res.total} checks failed.`}</p>
          <ul className="space-y-2 text-sm">
            {res.cases.map((c) => (
              <li key={c.key} className="flex items-start gap-2">
                <span aria-hidden className={c.passed ? "text-[#2f7d4f]" : "text-[#b4432c]"}>
                  {c.passed ? "✓" : "✗"}
                </span>
                <span>
                  {c.label}
                  <span className="block text-xs text-ink-muted">{c.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  );
}
