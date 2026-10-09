"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import type { AutomationRunRow } from "@bmu/shared";
import { DataTable, Panel, StatRow, StatTile, Tabs } from "@/components/dash";
import { CsvButton, Insight, PeriodPicker, usePeriod } from "@/components/charts";
import { Badge, LoadState, PageTitle, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { RunStatus, Steps, fmtWhen, runStatusLabel } from "../_parts/kit";

type StatusFilter = "all" | "success" | "failed" | "skipped";

export default function AutomationRunsPage() {
  return (
    <Suspense fallback={<LoadState loading />}>
      <RunsLog />
    </Suspense>
  );
}

function RunsLog() {
  const params = useSearchParams();
  const [ruleId, setRuleId] = useState(params.get("ruleId") ?? "");
  const [status, setStatus] = useState<StatusFilter>("all");
  const { period, setPeriod } = usePeriod("30d");
  const rules = useLoad(() => api.automations.overview().then((o) => o.rules));
  const [state, setState] = useState<{ rows?: AutomationRunRow[]; error?: string; loading: boolean }>({ loading: true });

  useEffect(() => {
    let live = true;
    api.automations
      .runs({ ruleId: ruleId || undefined, status: status === "all" ? undefined : status, from: period.from, to: period.to })
      .then((rows) => live && setState({ rows, loading: false }))
      .catch((e: Error) => live && setState({ error: e.message, loading: false }));
    return () => {
      live = false;
    };
  }, [ruleId, status, period.from, period.to]);

  const rows = state.rows ?? [];
  const failed = rows.filter((r) => r.status === "failed").length;
  const done = rows.filter((r) => r.status === "success").length;
  const rate = rows.length ? Math.round((done / rows.length) * 100) : null;
  const failingRule = Object.entries(rows.filter((r) => r.status === "failed").reduce<Record<string, number>>((m, r) => ({ ...m, [r.ruleName]: (m[r.ruleName] ?? 0) + 1 }), {})).sort((a, b) => b[1] - a[1])[0];

  return (
    <>
      <PageTitle
        title="Automation Log"
        subtitle="Everything the automations did, in plain words, with a link to each record."
        action={
          <Link href="/admin/automations" className="text-sm text-ink-muted hover:text-ink">
            ← Automations
          </Link>
        }
      />
      <div className="space-y-6">
        <div className="flex flex-wrap items-center gap-3">
          <PeriodPicker value={period} onChange={setPeriod} />
          <Select aria-label="Rule" value={ruleId} onChange={(e) => setRuleId(e.target.value)} className="max-w-full">
            <option value="">All rules</option>
            {(rules.data ?? []).map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </Select>
          <Tabs<StatusFilter>
            value={status}
            onChange={setStatus}
            options={[
              { value: "all", label: "All" },
              { value: "success", label: runStatusLabel.success },
              { value: "failed", label: runStatusLabel.failed },
              { value: "skipped", label: runStatusLabel.skipped },
            ]}
          />
        </div>

        {state.error ? (
          <LoadState loading={false} error={state.error} />
        ) : state.rows === undefined ? (
          <LoadState loading />
        ) : (
          <>
            <StatRow cols={3}>
              <StatTile label="Runs in this view" value={rows.length} hint={rows.length >= 500 ? "showing the latest 500" : undefined} />
              <StatTile label="Went through cleanly" value={rate === null ? "—" : `${rate}%`} tone={rate !== null && rate >= 90 ? "good" : "default"} hint={`${done} done`} />
              <StatTile label="Failed" value={failed} tone={failed ? "bad" : "default"} hint={failed ? "see the red lines below" : "none"} />
            </StatRow>
            {failingRule && (
              <Insight tone="warn">
                Most failures come from &quot;{failingRule[0]}&quot; ({failingRule[1]} in this period). Open the rule to check who it alerts and test it against current data.
              </Insight>
            )}
            <Panel
              title="Runs"
              subtitle="Newest first."
              flush
              className="min-w-0"
              action={
                <CsvButton
                  rows={rows}
                  filename={`automation-log-${period.from}-to-${period.to}`}
                  columns={[
                    { header: "When", value: (r) => fmtWhen(r.at) },
                    { header: "Rule", value: (r) => r.ruleName },
                    { header: "Record", value: (r) => r.record ?? r.entity },
                    { header: "Result", value: (r) => runStatusLabel[r.status] },
                    { header: "What happened", value: (r) => r.steps.map((s) => s.text).join(" | ") || r.summary },
                  ]}
                />
              }
            >
              <DataTable<AutomationRunRow>
                rows={rows}
                rowKey={(r) => r.id}
                empty="No runs match these filters."
                columns={[
                  { key: "at", header: "When", cell: (r) => <span className="whitespace-nowrap text-ink-muted">{fmtWhen(r.at)}</span> },
                  {
                    key: "rule",
                    header: "Rule",
                    className: "min-w-40",
                    cell: (r) => (
                      <Link href={`/admin/automations/${r.ruleId}`} className="hover:underline">
                        {r.ruleName}
                      </Link>
                    ),
                  },
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
                  { key: "steps", header: "What happened", className: "min-w-80", cell: (r) => <Steps steps={r.steps} compact /> },
                ]}
              />
            </Panel>
          </>
        )}
      </div>
    </>
  );
}
