"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { WorkflowOverview, WorkflowRow } from "@bmu/shared";
import { DataTable, Panel, StatRow, StatTile } from "@/components/dash";
import { Badge, Button, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { Toggle, WithData, ago } from "../automations/_parts/kit";

export default function WorkflowsPage() {
  const state = useLoad(() => api.workflows.overview());
  return <WithData state={state}>{(data) => <Overview data={data} reload={state.reload} />}</WithData>;
}

function Overview({ data, reload }: { data: WorkflowOverview; reload: () => void }) {
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
      const r = await api.workflows.runNow();
      setNote({ tone: "ok", text: r.started + r.advanced === 0 ? "Checked every workflow. Nothing new to do right now." : `Started ${r.started} run${r.started === 1 ? "" : "s"}, moved ${r.advanced} along, ${r.finished} finished${r.failed ? `, ${r.failed} had problems` : ""}.` });
      reload();
    });

  const move = () =>
    act("move", async () => {
      if (!window.confirm(`Move ${data.automationsToMove} automation${data.automationsToMove === 1 ? "" : "s"} into workflows? Each becomes a workflow that does the same thing, its history comes along, and the old rule is switched off.`)) return;
      const r = await api.workflows.moveAutomations();
      setNote({ tone: "ok", text: `Moved ${r.moved.length} automation${r.moved.length === 1 ? "" : "s"} into workflows.` });
      reload();
    });

  const toggle = (w: WorkflowRow, on: boolean) =>
    act(w.id, async () => {
      await api.workflows.setEnabled(w.id, on);
      reload();
    });

  const addTemplate = (key: string) =>
    act(key, async () => {
      const r = await api.workflows.fromTemplate(key);
      router.push(`/admin/workflows/${r.id}`);
    });

  return (
    <>
      <PageTitle
        title="Workflows"
        subtitle="Multi-step follow-ups that can wait days, check things, ask for approval and take different paths."
        action={
          data.canManage && (
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={runNow} disabled={busy === "run"}>
                {busy === "run" ? "Running…" : "Run now"}
              </Button>
              <Link href="/admin/workflows/new" className="bg-charcoal px-4 py-2 text-sm font-medium text-ivory hover:opacity-90">
                New workflow
              </Link>
            </div>
          )
        }
      />
      {note && <p className={`mb-6 border px-4 py-3 text-sm ${note.tone === "ok" ? "border-green bg-green/10" : "border-red bg-red/10"}`}>{note.text}</p>}
      {!data.canManage && <p className="mb-6 border border-border bg-canvas/60 px-4 py-3 text-sm text-ink-muted">You can see the workflows and what they did. Only the Founder and Branch Managers can change them.</p>}
      {data.canManage && data.automationsToMove > 0 && (
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 border border-amber bg-amber/10 px-4 py-3 text-sm">
          <span>
            You have {data.automationsToMove} automation{data.automationsToMove === 1 ? "" : "s"} from before. Move them here to add waits, checks and approvals.
          </span>
          <Button variant="secondary" className="px-3 py-1.5" onClick={move} disabled={busy === "move"}>
            {busy === "move" ? "Moving…" : "Move them into workflows"}
          </Button>
        </div>
      )}

      <div className="space-y-8">
        <StatRow cols={5}>
          <StatTile label="Active workflows" value={stats.active} hint={`of ${stats.total}`} tone={stats.active ? "good" : "default"} />
          <StatTile label="Runs started, 7 days" value={stats.runs7d} href="/admin/workflows/runs" />
          <StatTile label="Waiting now" value={stats.waiting} hint="paused on a wait step" href="/admin/workflows/runs?status=waiting" />
          <StatTile label="Waiting for approval" value={stats.awaitingApproval} href="/admin/workflows/runs?status=waiting_approval" tone={stats.awaitingApproval ? "warn" : "default"} />
          <StatTile label="Problems, 7 days" value={stats.failures7d} tone={stats.failures7d ? "bad" : "default"} href="/admin/workflows/runs?status=failed" />
        </StatRow>

        <Panel
          title="Your workflows"
          subtitle="Switch one off to pause new runs. Runs already in progress carry on with the version they started on."
          flush
          className="min-w-0"
          action={
            <Link href="/admin/workflows/runs" className="text-sm text-ink-muted hover:text-ink">
              All runs →
            </Link>
          }
        >
          <DataTable<WorkflowRow>
            rows={data.workflows}
            rowKey={(r) => r.id}
            empty="No workflows yet. Start from a template below or build your own."
            columns={[
              {
                key: "wf",
                header: "Workflow",
                className: "min-w-72",
                cell: (r) => (
                  <Link href={`/admin/workflows/${r.id}`} className="block hover:underline">
                    <span className="font-medium">{r.name}</span>
                    {r.movedFromRule && <span className="ml-2 text-[11px] uppercase tracking-[0.1em] text-ink-muted">from automations</span>}
                    <span className="mt-0.5 block text-xs leading-relaxed text-ink-muted">{r.summary}</span>
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
              { key: "ver", header: "Version", align: "right", cell: (r) => <span className="text-ink-muted">v{r.version}</span> },
              { key: "active", header: "In progress", align: "right", cell: (r) => (r.active ? <Link href={`/admin/workflows/runs?workflowId=${r.id}`} className="hover:underline">{r.active}</Link> : <span className="text-ink-muted">0</span>) },
              { key: "runs", header: "Runs", align: "right", cell: (r) => r.runCount },
              { key: "fail", header: "Problems (30d)", align: "right", cell: (r) => (r.failures30d ? <span className="text-[#b4432c]">{r.failures30d}</span> : <span className="text-ink-muted">0</span>) },
              { key: "last", header: "Last run", cell: (r) => <span className="whitespace-nowrap text-ink-muted">{ago(r.lastRunAt)}</span> },
            ]}
          />
        </Panel>

        <section>
          <div className="mb-4">
            <h2 className="text-[15px] font-semibold tracking-tight">Templates</h2>
            <p className="mt-0.5 text-xs text-ink-muted">Ready-made agency workflows. One click adds it switched on; you can change any step after.</p>
          </div>
          <div className="grid gap-px border border-border bg-border sm:grid-cols-2 xl:grid-cols-3">
            {data.templates.map((t) => (
              <article key={t.key} className="flex flex-col bg-surface-raised p-5">
                <div className="flex items-start justify-between gap-3">
                  <h3 className="text-sm font-semibold">{t.name}</h3>
                  <span className="shrink-0 text-[11px] uppercase tracking-[0.1em] text-ink-muted">{t.area}</span>
                </div>
                <p className="mt-1.5 text-sm text-ink-muted">{t.description}</p>
                <p className="mt-3 border-l-2 border-border pl-3 text-xs leading-relaxed text-ink">{t.summary}</p>
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
