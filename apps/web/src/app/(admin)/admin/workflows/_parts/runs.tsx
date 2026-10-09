"use client";
// Run status badges, the runs table and the run detail drawer (outline of steps, what happened, stop button).
import Link from "next/link";
import { useEffect, useState } from "react";
import { workflowRunStatusLabels, type WorkflowRunDetail, type WorkflowRunRow, type WorkflowRunStatus } from "@bmu/shared";
import { DataTable } from "@/components/dash";
import { Badge, Button, LoadState } from "@/components/ui";
import { api } from "@/lib/api";
import { Steps, ago, fmtWhen } from "../../automations/_parts/kit";

const tone: Record<WorkflowRunStatus, "green" | "red" | "amber" | "neutral" | "dark"> = { running: "dark", waiting: "amber", waiting_approval: "amber", done: "green", failed: "red", cancelled: "neutral" };

export function WfRunStatus({ status }: { status: WorkflowRunStatus }) {
  return <Badge tone={tone[status]}>{workflowRunStatusLabels[status]}</Badge>;
}

export function RunsTable({ rows, onOpen, showWorkflow = true, empty }: { rows: WorkflowRunRow[]; onOpen: (id: string) => void; showWorkflow?: boolean; empty?: string }) {
  return (
    <DataTable<WorkflowRunRow>
      rows={rows}
      rowKey={(r) => r.id}
      empty={empty ?? "No runs yet."}
      columns={[
        { key: "started", header: "Started", cell: (r) => <span className="whitespace-nowrap text-ink-muted">{fmtWhen(r.startedAt)}</span> },
        ...(showWorkflow ? [{ key: "wf", header: "Workflow", className: "min-w-44", cell: (r: WorkflowRunRow) => <Link href={`/admin/workflows/${r.workflowId}`} className="hover:underline">{r.workflowName} <span className="text-xs text-ink-muted">v{r.version}</span></Link> }] : []),
        {
          key: "record",
          header: "Record",
          className: "min-w-44",
          cell: (r) =>
            r.link ? (
              <Link href={r.link} className="hover:underline">
                {r.record}
              </Link>
            ) : (
              r.record
            ),
        },
        { key: "status", header: "Status", cell: (r) => <WfRunStatus status={r.status} /> },
        { key: "where", header: "Where it is", className: "min-w-56", cell: (r) => <span className="text-ink-muted">{r.where}</span> },
        {
          key: "open",
          header: "",
          align: "right",
          cell: (r) => (
            <Button variant="ghost" className="px-2 py-1" onClick={() => onOpen(r.id)}>
              Details
            </Button>
          ),
        },
      ]}
    />
  );
}

export function RunDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged?: () => void }) {
  const [run, setRun] = useState<WorkflowRunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    api.workflows
      .run(id)
      .then((r) => live && setRun(r))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const cancel = async () => {
    if (!run || !window.confirm("Stop this run? Steps that have not happened yet are skipped.")) return;
    setBusy(true);
    try {
      setRun(await api.workflows.cancelRun(run.id));
      onChanged?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-charcoal/30" onClick={onClose} role="presentation">
      <aside role="dialog" aria-label="Workflow run" className="h-full w-full max-w-xl overflow-y-auto bg-surface-raised shadow-xl" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <p className="text-[11px] uppercase tracking-[0.1em] text-ink-muted">{run ? `${run.workflowName} · v${run.version}` : "Workflow run"}</p>
            <h2 className="mt-0.5 text-[15px] font-semibold tracking-tight">{run ? run.link ? <Link href={run.link} className="hover:underline">{run.record}</Link> : run.record : "Loading…"}</h2>
            {run && (
              <p className="mt-1 flex flex-wrap items-center gap-2 text-sm">
                <WfRunStatus status={run.status} />
                <span className="text-ink-muted">{run.where}</span>
              </p>
            )}
          </div>
          <Button variant="ghost" className="px-2 py-1" onClick={onClose}>
            Close
          </Button>
        </header>
        {error && <p className="m-5 border border-red bg-red/10 px-3 py-2 text-sm">{error}</p>}
        {!run && !error && <LoadState loading />}
        {run && (
          <div className="space-y-6 px-5 py-5">
            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-[0.1em] text-ink-muted">The workflow</h3>
              <ol className="space-y-1 text-sm">
                {run.outline.map((o) => (
                  <li key={o.stepId} style={{ paddingLeft: `${o.depth * 16}px` }} className={`flex items-start gap-2 ${o.state === "todo" || o.state === "skipped" ? "text-ink-muted" : ""}`}>
                    <span aria-hidden className={`mt-1.5 inline-block h-2 w-2 shrink-0 ${o.state === "done" ? "bg-[#8BB72C]" : o.state === "current" ? "bg-amber ring-2 ring-amber/30" : "border border-ink-muted/50"}`} />
                    <span className={o.state === "skipped" ? "line-through" : o.state === "current" ? "font-medium" : ""}>{o.text}</span>
                    {o.state === "current" && <span className="text-xs text-ink-muted">(here now)</span>}
                  </li>
                ))}
              </ol>
            </section>
            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-[0.1em] text-ink-muted">What happened</h3>
              {run.steps.length ? (
                <ul className="space-y-1.5">
                  {run.steps.map((s) => (
                    <li key={s.id} className="flex items-start justify-between gap-3 text-sm">
                      <Steps steps={[{ ok: s.ok, skipped: s.skipped, text: s.text }]} compact />
                      <span className="shrink-0 whitespace-nowrap text-xs text-ink-muted">{fmtWhen(s.at)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-ink-muted">Nothing yet.</p>
              )}
            </section>
            <p className="text-xs text-ink-muted">
              Started {ago(run.startedAt).toLowerCase()}
              {run.finishedAt ? `, finished ${ago(run.finishedAt).toLowerCase()}` : ""}.{run.failures ? ` ${run.failures} step${run.failures === 1 ? "" : "s"} had problems.` : ""}
              {run.approvalId && (
                <>
                  {" "}
                  <Link href="/admin/approvals" className="underline">
                    Open Approvals
                  </Link>
                </>
              )}
            </p>
            {run.canCancel && (
              <Button variant="secondary" onClick={cancel} disabled={busy}>
                {busy ? "Stopping…" : "Stop this run"}
              </Button>
            )}
          </div>
        )}
      </aside>
    </div>
  );
}
