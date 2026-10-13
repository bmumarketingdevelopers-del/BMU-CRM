"use client";
// v15 Agent Inbox: suggestions from AI agents that need a person (replies to clients and leads, assigning work,
// anything touching money). Approve as is, edit then approve, or reject with a note.
import Link from "next/link";
import { useState } from "react";
import type { AgentProposalView } from "@bmu/shared";
import { Panel, Tabs } from "@/components/dash";
import { Badge, Button, Input, LoadState, PageTitle, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { fmtWhen } from "./agent-run";

export function AgentInbox({ runHref }: { runHref: (id: string) => string }) {
  const [tab, setTab] = useState<"pending" | "decided">("pending");
  const [flash, setFlash] = useState<string | null>(null);
  return (
    <>
      <PageTitle title="Agent Inbox" subtitle="AI agents never message clients, assign people or touch money on their own. Their suggestions wait here for you." />
      <div className="mb-6">
        <Tabs<"pending" | "decided">
          value={tab}
          onChange={(t) => {
            setTab(t);
            setFlash(null);
          }}
          options={[
            { value: "pending", label: "Waiting for you" },
            { value: "decided", label: "Decided" },
          ]}
        />
      </div>
      {flash && (
        <p className="mb-4 border border-green bg-green/10 px-4 py-3 text-sm" role="status">
          {flash}
        </p>
      )}
      <InboxList key={tab} tab={tab} runHref={runHref} onDecided={setFlash} />
    </>
  );
}

function InboxList({ tab, runHref, onDecided }: { tab: "pending" | "decided"; runHref: (id: string) => string; onDecided: (msg: string) => void }) {
  const state = useLoad(() => api.agents.inbox(tab), { live: ["AgentProposal"] });
  if (state.data === undefined) return <LoadState loading={state.loading} error={state.error} />;
  if (!state.data.length) return <p className="border border-border bg-surface-raised px-5 py-8 text-center text-sm text-ink-muted">{tab === "pending" ? "Nothing waiting. When an agent suggests something for you, it shows up here." : "Nothing decided yet."}</p>;
  return (
    <div className="space-y-4" data-testid="agent-inbox">
      {state.data.map((p) => (
        <Proposal
          key={`${p.id}-${p.status}`}
          p={p}
          runHref={runHref}
          onDone={(msg) => {
            onDecided(msg);
            state.reload();
          }}
        />
      ))}
    </div>
  );
}

function Proposal({ p, runHref, onDone }: { p: AgentProposalView; runHref: (id: string) => string; onDone: (msg: string) => void }) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(p.fields.map((f) => [f.key, String(p.payload[f.key] ?? "")])));
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const changed = p.fields.filter((f) => values[f.key] !== String(p.payload[f.key] ?? ""));

  const decide = async (decision: "approve" | "reject") => {
    let note: string | undefined;
    if (decision === "reject") {
      const n = window.prompt("Why not? (optional, helps tune the agent)");
      if (n === null) return;
      note = n || undefined;
    }
    setBusy(decision);
    setError(null);
    try {
      const r = await api.agents.decide(p.id, {
        decision,
        edits: decision === "approve" && changed.length ? Object.fromEntries(changed.map((f) => [f.key, values[f.key]])) : undefined,
        note,
      });
      const msg = r.status === "approved" ? `Approved and done: ${r.title}` : `Rejected: ${r.title}`;
      setDone(msg);
      onDone(msg);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div data-testid="proposal" data-action={p.action}>
      <Panel
        title={p.title}
        subtitle={`${p.agentLabel} · ${p.actionLabel} · ${fmtWhen(p.createdAt)}${p.actingFor ? ` · acting for ${p.actingFor}` : ""}`}
        action={
          <span className="flex items-center gap-2">
            {p.status !== "pending" && <Badge tone={p.status === "approved" ? "green" : p.status === "rejected" ? "neutral" : "red"}>{p.status}</Badge>}
            <span className="text-[11px] uppercase tracking-[0.1em] text-ink-muted">{p.why}</span>
          </span>
        }
      >
        <div>
          {!editing && p.summary && <p className="whitespace-pre-line text-sm leading-relaxed">{p.summary}</p>}
          {editing && (
            <div className="space-y-3">
              {p.fields.map((f) => (
                <label key={f.key} className="block text-sm">
                  <span className="mb-1 block text-xs text-ink-muted">{f.label}</span>
                  {f.kind === "longtext" ? (
                    <textarea
                      aria-label={f.label}
                      value={values[f.key]}
                      onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                      rows={7}
                      className="w-full border border-border bg-surface px-3 py-2 text-sm focus:border-charcoal focus:outline-none"
                    />
                  ) : f.kind === "select" || f.kind === "person" ? (
                    <Select aria-label={f.label} value={values[f.key]} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}>
                      {!(f.options ?? []).some((o) => o.value === values[f.key]) && <option value={values[f.key]}>Suggested person</option>}
                      {(f.options ?? []).map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <Input aria-label={f.label} value={values[f.key]} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />
                  )}
                </label>
              ))}
            </div>
          )}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {p.canDecide && !done && (
              <>
                <Button onClick={() => decide("approve")} disabled={!!busy}>
                  {busy === "approve" ? "Working…" : changed.length ? "Approve with my changes" : "Approve"}
                </Button>
                {p.fields.length > 0 && (
                  <Button variant="secondary" onClick={() => setEditing(!editing)} disabled={!!busy}>
                    {editing ? "Hide edit" : "Edit"}
                  </Button>
                )}
                <Button variant="ghost" onClick={() => decide("reject")} disabled={!!busy}>
                  {busy === "reject" ? "Working…" : "Reject"}
                </Button>
              </>
            )}
            {p.status === "pending" && !p.canDecide && <span className="text-xs text-ink-muted">Waiting for {p.actingFor ?? "the right person"} or a Branch Manager.</span>}
            {p.decidedBy && (
              <span className="text-xs text-ink-muted">
                {p.status === "approved" ? "Approved" : "Rejected"} by {p.decidedBy} · {fmtWhen(p.decidedAt)}
                {p.decisionNote ? ` · "${p.decisionNote}"` : ""}
              </span>
            )}
            <span className="ml-auto flex gap-4 text-xs">
              {p.link && (
                <Link href={p.link} className="text-ink-muted hover:text-ink">
                  Open record →
                </Link>
              )}
              <Link href={runHref(p.runId)} className="text-ink-muted hover:text-ink">
                Why? See the run →
              </Link>
            </span>
          </div>
          {done && <p className="mt-3 border border-green bg-green/10 px-3 py-2 text-sm">{done}</p>}
          {error && <p className="mt-3 border border-red bg-red/10 px-3 py-2 text-sm">{error}</p>}
        </div>
      </Panel>
    </div>
  );
}
