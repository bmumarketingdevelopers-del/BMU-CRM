"use client";

import Link from "next/link";
import { PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { WithData } from "../../automations/_parts/kit";
import { WorkflowBuilder, WorkflowHint } from "../_parts/workflow-builder";

export default function NewWorkflowPage() {
  const state = useLoad(() => api.workflows.options());
  return (
    <>
      <PageTitle
        title="New workflow"
        subtitle="Pick what starts it, then add steps: actions, waits, checks with two paths, and approvals."
        action={
          <Link href="/admin/workflows" className="text-sm text-ink-muted hover:text-ink">
            ← All workflows
          </Link>
        }
      />
      <WithData state={state}>{(options) => (options.canManage ? <WorkflowBuilder options={options} /> : <WorkflowHint>Only the Founder and Admins can create workflows.</WorkflowHint>)}</WithData>
    </>
  );
}
