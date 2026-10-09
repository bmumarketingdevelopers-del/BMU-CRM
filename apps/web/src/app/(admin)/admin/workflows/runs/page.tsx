"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { WORKFLOW_RUN_STATUSES, workflowRunStatusLabels, type WorkflowRunRow } from "@bmu/shared";
import { Panel, StatRow, StatTile } from "@/components/dash";
import { LoadState, PageTitle, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { RunDrawer, RunsTable } from "../_parts/runs";

export default function WorkflowRunsPage() {
  return (
    <Suspense fallback={<LoadState loading />}>
      <RunsLog />
    </Suspense>
  );
}

function RunsLog() {
  const params = useSearchParams()!;
  const [workflowId, setWorkflowId] = useState(params.get("workflowId") ?? "");
  const [status, setStatus] = useState(params.get("status") ?? "");
  const [open, setOpen] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const workflows = useLoad(() => api.workflows.overview().then((o) => o.workflows));
  const [state, setState] = useState<{ rows?: WorkflowRunRow[]; error?: string; loading: boolean }>({ loading: true });

  useEffect(() => {
    let live = true;
    api.workflows
      .runs({ workflowId: workflowId || undefined, status: status || undefined })
      .then((rows) => live && setState({ rows, loading: false }))
      .catch((e: Error) => live && setState({ error: e.message, loading: false }));
    return () => {
      live = false;
    };
  }, [workflowId, status, tick]);

  const rows = state.rows ?? [];
  const count = (s: string[]) => rows.filter((r) => s.includes(r.status)).length;

  return (
    <>
      <PageTitle
        title="Workflow Runs"
        subtitle="Every record going through a workflow: where it is now, what already happened and what comes next."
        action={
          <Link href="/admin/workflows" className="text-sm text-ink-muted hover:text-ink">
            ← Workflows
          </Link>
        }
      />
      <div className="space-y-6">
        <div className="flex flex-wrap items-center gap-3">
          <Select aria-label="Workflow" value={workflowId} onChange={(e) => setWorkflowId(e.target.value)} className="max-w-full">
            <option value="">All workflows</option>
            {(workflows.data ?? []).map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </Select>
          <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Any status</option>
            <option value="active">In progress (any)</option>
            {WORKFLOW_RUN_STATUSES.map((s) => (
              <option key={s} value={s}>
                {workflowRunStatusLabels[s]}
              </option>
            ))}
          </Select>
        </div>
        <StatRow cols={4}>
          <StatTile label="Shown" value={rows.length} hint="newest 500" />
          <StatTile label="In progress" value={count(["running", "waiting", "waiting_approval"])} />
          <StatTile label="Finished" value={count(["done"])} tone="good" />
          <StatTile label="With problems" value={count(["failed"])} tone={count(["failed"]) ? "bad" : "default"} />
        </StatRow>
        {state.error && <LoadState loading={false} error={state.error} />}
        <Panel flush className="min-w-0">
          {state.loading ? <LoadState loading /> : <RunsTable rows={rows} onOpen={setOpen} empty="No runs match these filters." />}
        </Panel>
      </div>
      {open && <RunDrawer id={open} onClose={() => setOpen(null)} onChanged={() => setTick((t) => t + 1)} />}
    </>
  );
}
