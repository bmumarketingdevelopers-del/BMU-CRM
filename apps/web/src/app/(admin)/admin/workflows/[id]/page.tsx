"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { Panel } from "@/components/dash";
import { PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { WithData, ago } from "../../automations/_parts/kit";
import { RunDrawer, RunsTable } from "../_parts/runs";
import { WorkflowBuilder, WorkflowHint } from "../_parts/workflow-builder";

export default function WorkflowDetailPage() {
  const { id } = useParams<{ id: string }>()!;
  const state = useLoad(() => Promise.all([api.workflows.get(id), api.workflows.options(), api.workflows.runs({ workflowId: id })]));
  const [open, setOpen] = useState<string | null>(null);
  return (
    <WithData state={state}>
      {([wf, options, runs]) => (
        <>
          <PageTitle
            title={wf.name}
            subtitle={`${wf.triggerLabel} · version ${wf.version} · ${wf.enabled ? "switched on" : "switched off"} · ${wf.runCount} run${wf.runCount === 1 ? "" : "s"}, last ${ago(wf.lastRunAt).toLowerCase()}`}
            action={
              <Link href="/admin/workflows" className="text-sm text-ink-muted hover:text-ink">
                ← All workflows
              </Link>
            }
          />
          {!options.canManage && <WorkflowHint>Read only. Only the Founder and Admins can change workflows, but you can test this one against current data.</WorkflowHint>}
          {wf.movedFromRule && <WorkflowHint>This workflow was moved over from Automations. Its earlier history is in the runs below.</WorkflowHint>}
          <WorkflowBuilder key={wf.id} initial={wf} options={options} onSaved={state.reload} />
          <Panel
            title="Runs"
            subtitle="Each record that went through this workflow. Open one to see where it is and what happened."
            flush
            className="mt-10 min-w-0"
            action={
              <Link href={`/admin/workflows/runs?workflowId=${wf.id}`} className="text-sm text-ink-muted hover:text-ink">
                Full log →
              </Link>
            }
          >
            <RunsTable rows={runs.slice(0, 50)} onOpen={setOpen} showWorkflow={false} empty="No runs yet. A run starts as soon as a record matches the trigger." />
          </Panel>
          {open && <RunDrawer id={open} onClose={() => setOpen(null)} onChanged={state.reload} />}
        </>
      )}
    </WithData>
  );
}
