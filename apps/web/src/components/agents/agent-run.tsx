"use client";
// v15: one agent run (what it looked at, what it did, what it asked about, what was refused) with Undo and feedback.
// Used by Command Centre → Agents → run, and by the team app for the person an agent acts for.
import Link from "next/link";
import { useState } from "react";
import { agentPolicyLabels, agentTriggerLabels, formatINR, type AgentRunDetail, type AgentRunRow, type AgentRunStatus, type AgentStepView } from "@bmu/shared";
import { AiText } from "@/components/ai/ai-text";
import { DataTable, Panel } from "@/components/dash";
import { Badge, Button, LoadState, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

const dtFmt = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "Asia/Kolkata",
});
export const fmtWhen = (iso: string | null | undefined) => (iso ? dtFmt.format(new Date(iso)) : "—");

export function RunStatusBadge({ status }: { status: AgentRunStatus }) {
  const map: Record<AgentRunStatus, { label: string; tone: "neutral" | "green" | "amber" | "red" | "dark" }> = {
    running: { label: "Running", tone: "amber" },
    done: { label: "Done", tone: "green" },
    failed: { label: "Problem", tone: "red" },
    undone: { label: "Undone", tone: "neutral" },
  };
  const m = map[status];
  return <Badge tone={m.tone}>{m.label}</Badge>;
}

export function ModeBadge({ mode }: { mode: "ai" | "basic" }) {
  return <span className="text-[11px] uppercase tracking-[0.1em] text-ink-muted">{mode === "ai" ? "AI" : "Basic"}</span>;
}

const kindLabel: Record<AgentStepView["kind"], string> = {
  read: "Looked up",
  action: "Did",
  proposal: "Asked first",
  blocked: "Refused",
  note: "Note",
  error: "Problem",
};
const kindTone: Record<AgentStepView["kind"], string> = {
  read: "border-border",
  action: "border-green",
  proposal: "border-amber",
  blocked: "border-red",
  note: "border-border",
  error: "border-red",
};

export function AgentRunView({ id, back }: { id: string; back: { href: string; label: string } }) {
  const state = useLoad(() => api.agents.run(id), {
    live: ["AgentRun", "AgentStep", "AgentProposal"],
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{
    tone: "ok" | "error";
    text: string;
  } | null>(null);
  const r = state.data;
  if (!r) return <LoadState loading={state.loading} error={state.error} />;

  const act = async (key: string, fn: () => Promise<AgentRunDetail>, ok: string) => {
    setBusy(key);
    setNote(null);
    try {
      await fn();
      setNote({ tone: "ok", text: ok });
      state.reload();
    } catch (e) {
      setNote({ tone: "error", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <PageTitle
        title={`${r.agentLabel}: ${r.subject?.label ?? agentTriggerLabels[r.trigger]}`}
        subtitle={`${agentTriggerLabels[r.trigger]} · ${fmtWhen(r.createdAt)}${r.actingFor ? ` · acting for ${r.actingFor}` : ""}${r.startedBy ? ` · started by ${r.startedBy}` : ""}`}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Link href={back.href} className="text-sm text-ink-muted hover:text-ink">
              ← {back.label}
            </Link>
            {r.canUndo && (
              <Button
                variant="secondary"
                disabled={busy === "all"}
                onClick={() => window.confirm("Undo everything this run changed that can be undone? Messages already sent stay sent.") && act("all", () => api.agents.undoRun(r.id), "Undone. Everything this run changed is back as it was.")}
              >
                {busy === "all" ? "Undoing…" : "Undo this run"}
              </Button>
            )}
          </div>
        }
      />
      {note && <p className={`mb-6 border px-4 py-3 text-sm ${note.tone === "ok" ? "border-green bg-green/10" : "border-red bg-red/10"}`}>{note.text}</p>}
      <div className="mb-6 flex flex-wrap items-center gap-x-6 gap-y-2 border border-border bg-surface-raised px-5 py-4 text-sm">
        <span className="flex items-center gap-2">
          <RunStatusBadge status={r.status} /> <ModeBadge mode={r.mode} />
        </span>
        <span>
          <b>{r.actions}</b> done
        </span>
        <span>
          <b>{r.proposals}</b> asked first
        </span>
        <span>
          <b>{r.blocked}</b> refused
        </span>
        <span className="text-ink-muted">AI cost {formatINR(r.costPaise)}</span>
        {r.subject?.link && (
          <Link href={r.subject.link} className="ml-auto hover:underline">
            Open {r.subject.type.toLowerCase()} →
          </Link>
        )}
      </div>
      {r.notice && <p className="mb-6 border border-border bg-canvas/60 px-4 py-3 text-sm text-ink-muted">{r.notice}</p>}
      {r.error && <p className="mb-6 border border-red bg-red/10 px-4 py-3 text-sm">{r.error}</p>}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-6">
          {r.answer && (
            <Panel title="Answer">
              <AiText text={r.answer} />
              {r.citations.length > 0 && (
                <div className="mt-4 border-t border-border pt-3">
                  <p className="text-[11px] uppercase tracking-[0.1em] text-ink-muted">Sources</p>
                  <ul className="mt-1 space-y-0.5 text-sm" data-testid="run-sources">
                    {r.citations.map((c) => (
                      <li key={c.href}>
                        <Link href={c.href} className="hover:underline">
                          {c.label}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </Panel>
          )}
          <Panel title="What it did" subtitle="Every step, in order. Steps marked Did can be undone here, with no time limit." flush>
            {r.steps.length === 0 ? (
              <p className="px-5 py-6 text-sm text-ink-muted">No steps.</p>
            ) : (
              <ol className="divide-y divide-border" data-testid="run-steps">
                {r.steps.map((s) => (
                  <li key={s.id} className={`flex flex-wrap items-start gap-3 border-l-2 px-5 py-3 ${kindTone[s.kind]} ${s.undoneAt ? "opacity-60" : ""}`}>
                    <div className="min-w-0 flex-1">
                      <p className="text-[11px] uppercase tracking-[0.1em] text-ink-muted">
                        {kindLabel[s.kind]}
                        {s.policy && s.policy !== "read" ? ` · ${agentPolicyLabels[s.policy]}` : ""}
                      </p>
                      <p className={`mt-0.5 text-sm ${s.undoneAt ? "line-through" : ""}`}>
                        {s.link ? (
                          <Link href={s.link} className="hover:underline">
                            {s.title}
                          </Link>
                        ) : (
                          s.title
                        )}
                      </p>
                      {s.detail && <p className="mt-0.5 whitespace-pre-line text-xs leading-relaxed text-ink-muted">{s.detail}</p>}
                      {s.undoneAt && (
                        <p className="mt-0.5 text-xs text-ink-muted">
                          Undone by {s.undoneBy} · {fmtWhen(s.undoneAt)}
                        </p>
                      )}
                      {s.kind === "proposal" && s.proposalId && (
                        <Link href="/team/agent-inbox" className="mt-1 inline-block text-xs text-ink-muted hover:text-ink">
                          Open the Agent Inbox →
                        </Link>
                      )}
                    </div>
                    {s.canUndo && (
                      <Button variant="ghost" className="px-3 py-1 text-xs" disabled={busy === s.id} onClick={() => act(s.id, () => api.agents.undoStep(r.id, s.id), "Undone.")}>
                        {busy === s.id ? "Undoing…" : "Undo"}
                      </Button>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </Panel>
        </div>
        <Panel title="Was this useful?">
          {r.feedback ? (
            <p className="text-sm">
              {r.feedback.value === 1 ? "Thumbs up" : "Thumbs down"} from {r.feedback.by}
              {r.feedback.note ? `: ${r.feedback.note}` : ""}
            </p>
          ) : (
            <p className="text-sm text-ink-muted">Tell us so the agent can be tuned.</p>
          )}
          <div className="mt-3 flex gap-2">
            <Button variant="secondary" className="px-3 py-1.5" aria-label="Thumbs up" disabled={!!busy} onClick={() => act("up", () => api.agents.feedback(r.id, { value: 1 }), "Thanks for the feedback.")}>
              👍 Useful
            </Button>
            <Button
              variant="secondary"
              className="px-3 py-1.5"
              aria-label="Thumbs down"
              disabled={!!busy}
              onClick={() =>
                act(
                  "down",
                  () =>
                    api.agents.feedback(r.id, {
                      value: -1,
                      note: window.prompt("What was wrong? (optional)") ?? undefined,
                    }),
                  "Thanks for the feedback.",
                )
              }
            >
              👎 Not useful
            </Button>
          </div>
        </Panel>
      </div>
    </>
  );
}

export function RunsTable({ rows, runHref = (id) => `/admin/agents/runs/${id}` }: { rows: AgentRunRow[]; runHref?: (id: string) => string }) {
  return (
    <DataTable<AgentRunRow>
      rows={rows}
      rowKey={(r) => r.id}
      empty="No runs yet. Switch an agent on, or press Run now."
      columns={[
        {
          key: "when",
          header: "When",
          cell: (r) => <span className="whitespace-nowrap text-ink-muted">{fmtWhen(r.createdAt)}</span>,
        },
        {
          key: "agent",
          header: "Agent",
          cell: (r) => <span className="whitespace-nowrap">{r.agentLabel}</span>,
        },
        {
          key: "what",
          header: "What",
          className: "min-w-72",
          cell: (r) => (
            <Link href={runHref(r.id)} className="block hover:underline">
              <span className="font-medium">{r.subject?.label ?? "—"}</span>
              {r.summary && <span className="mt-0.5 block text-xs leading-relaxed text-ink-muted">{r.summary}</span>}
            </Link>
          ),
        },
        {
          key: "status",
          header: "Status",
          cell: (r) => (
            <span className="flex items-center gap-2">
              <RunStatusBadge status={r.status} />
              <ModeBadge mode={r.mode} />
            </span>
          ),
        },
        { key: "done", header: "Done", align: "right", cell: (r) => r.actions },
        {
          key: "asked",
          header: "Asked",
          align: "right",
          cell: (r) => (r.proposals ? <span className="text-[#9a6b00]">{r.proposals}</span> : 0),
        },
        {
          key: "refused",
          header: "Refused",
          align: "right",
          cell: (r) => (r.blocked ? <span className="text-[#b4432c]">{r.blocked}</span> : 0),
        },
        {
          key: "cost",
          header: "Cost",
          align: "right",
          cell: (r) => <span className="text-ink-muted">{formatINR(r.costPaise)}</span>,
        },
      ]}
    />
  );
}
