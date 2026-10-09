"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { AGENT_KEYS, agentInfo, type AgentKey } from "@bmu/shared";
import { RunsTable } from "@/components/agents/agent-run";
import { Panel } from "@/components/dash";
import { LoadState, PageTitle, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { WithData } from "../../automations/_parts/kit";

export default function AgentRunsPage() {
  return (
    <Suspense fallback={<LoadState loading />}>
      <RunsLog />
    </Suspense>
  );
}

function RunsLog() {
  const params = useSearchParams();
  const agent = params.get("agent") ?? "";
  const status = params.get("status") ?? "";
  return <Runs key={`${agent}|${status}`} agent={agent} status={status} />;
}

function Runs({ agent, status }: { agent: string; status: string }) {
  const router = useRouter();
  const state = useLoad(() => api.agents.runs({ agent: agent || undefined, status: status || undefined }), { live: ["AgentRun"] });
  const go = (next: { agent?: string; status?: string }) => {
    const q = new URLSearchParams(Object.entries({ agent, status, ...next }).filter(([, v]) => v) as [string, string][]).toString();
    router.push(`/admin/agents/runs${q ? `?${q}` : ""}`);
  };
  return (
    <>
      <PageTitle
        title="Agent run log"
        subtitle="Everything the AI agents looked at, did, asked about and were refused. Open a run to undo what it changed."
        action={
          <Link href="/admin/agents" className="text-sm text-ink-muted hover:text-ink">
            ← Agents
          </Link>
        }
      />
      <div className="mb-6 flex flex-wrap gap-3">
        <Select aria-label="Agent" value={agent} onChange={(e) => go({ agent: e.target.value })}>
          <option value="">All agents</option>
          {AGENT_KEYS.map((k) => (
            <option key={k} value={k}>
              {agentInfo[k as AgentKey].label}
            </option>
          ))}
        </Select>
        <Select aria-label="Status" value={status} onChange={(e) => go({ status: e.target.value })}>
          <option value="">Any status</option>
          <option value="done">Done</option>
          <option value="undone">Undone</option>
          <option value="failed">Problem</option>
        </Select>
      </div>
      <WithData state={state}>
        {(rows) => (
          <Panel flush>
            <RunsTable rows={rows} />
          </Panel>
        )}
      </WithData>
    </>
  );
}
