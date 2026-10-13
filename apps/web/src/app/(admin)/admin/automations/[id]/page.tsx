"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import type { AutomationRunRow } from "@bmu/shared";
import { DataTable, Panel } from "@/components/dash";
import { Badge, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { RunStatus, Steps, WithData, ago, fmtWhen } from "../_parts/kit";
import { RuleBuilder } from "../_parts/rule-builder";

export default function AutomationDetailPage() {
  const { id } = useParams<{ id: string }>()!;
  const state = useLoad(() => Promise.all([api.automations.get(id), api.automations.options()]));
  return (
    <WithData state={state}>
      {([rule, options]) => (
        <>
          <PageTitle
            title={rule.name}
            subtitle={`${rule.triggerLabel} · ${rule.enabled ? "switched on" : "switched off"} · ran ${rule.runCount} time${rule.runCount === 1 ? "" : "s"}, last ${ago(rule.lastRunAt).toLowerCase()}`}
            action={
              <Link href="/admin/automations" className="text-sm text-ink-muted hover:text-ink">
                ← All automations
              </Link>
            }
          />
          {!options.canManage && <p className="mb-6 border border-border bg-canvas/60 px-4 py-3 text-sm text-ink-muted">Read only. Only the Founder and Branch Managers can change automations, but you can test this rule against current data.</p>}
          <RuleBuilder key={rule.id} initial={rule} options={options} onSaved={state.reload} />
          <Panel
            title="This rule's history"
            subtitle="The last 50 runs. Each record is handled once per rule."
            flush
            className="mt-10 min-w-0"
            action={
              <Link href={`/admin/automations/runs?ruleId=${rule.id}`} className="text-sm text-ink-muted hover:text-ink">
                Full log →
              </Link>
            }
          >
            <DataTable<AutomationRunRow>
              rows={rule.runs}
              rowKey={(r) => r.id}
              empty="This rule has not run yet. It acts as soon as a record matches."
              columns={[
                { key: "at", header: "When", cell: (r) => <span className="whitespace-nowrap text-ink-muted">{fmtWhen(r.at)}</span> },
                {
                  key: "record",
                  header: "Record",
                  className: "min-w-48",
                  cell: (r) =>
                    r.link ? (
                      <Link href={r.link} className="hover:underline">
                        {r.record ?? r.entity}
                      </Link>
                    ) : (
                      (r.record ?? <Badge>{r.entity}</Badge>)
                    ),
                },
                { key: "status", header: "Result", cell: (r) => <RunStatus status={r.status} /> },
                { key: "steps", header: "What happened", className: "min-w-72", cell: (r) => <Steps steps={r.steps} compact /> },
              ]}
            />
          </Panel>
        </>
      )}
    </WithData>
  );
}
