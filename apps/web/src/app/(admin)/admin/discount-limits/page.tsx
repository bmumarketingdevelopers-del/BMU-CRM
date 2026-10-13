"use client";

import { useState } from "react";
import { formatINR, type SettingsView } from "@bmu/shared";
import { BarList, DataTable, Panel } from "@/components/dash";
import { Badge, Button, Input, LoadState, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { ErrorNote, ROLE_LABEL, fmtDate } from "../_admin-org/kit";

const SELLING_ROLES = ["sales_executive", "sales_manager", "am_lead", "account_manager", "admin"];

export default function DiscountLimitsPage() {
  const s = useLoad(() => api.settings.all());
  const approvals = useLoad(() => api.adminOrg.discountApprovals());
  const [view, setView] = useState<SettingsView>();
  const data = view ?? s.data;
  return (
    <>
      <PageTitle title="Discount Limits" subtitle="The most extra discount each role can give on a proposal without asking. Anything above goes to the Founder to approve." />
      <LoadState loading={!data && s.loading} error={s.error} />
      {data && (
        <div className="grid grid-cols-1 gap-6 [&>*]:min-w-0 lg:grid-cols-[3fr_2fr]">
          {/* Not keyed on the saved values: remounting after a save would hide the "saved" confirmation. */}
          <LimitsEditor data={data} onSaved={setView} />
          <div className="space-y-6">
            <Panel title="How it works">
              <ol className="list-decimal space-y-2 pl-5 text-sm text-ink-muted">
                <li>Bundle discounts from the price book apply automatically and don’t count here.</li>
                <li>On top of that, a seller may add an extra discount up to their role’s limit.</li>
                <li>
                  Above the limit, the proposal is held and the <strong className="text-ink">Founder</strong> approves it. The Founder has no limit.
                </li>
                <li>A role set to 0% can’t give any extra discount. Roles not listed are treated as 0%.</li>
              </ol>
            </Panel>
            <Panel title="Recent proposals that needed approval" flush>
              <LoadState loading={approvals.loading && !approvals.data} error={approvals.error} />
              {approvals.data && (
                <DataTable
                  rows={approvals.data}
                  rowKey={(p) => p.id}
                  empty="No proposal has gone over a limit yet."
                  columns={[
                    {
                      key: "lead",
                      header: "Proposal",
                      cell: (p) => (
                        <div>
                          <div className="font-medium">{p.lead}</div>
                          <div className="text-xs text-ink-muted">
                            {p.createdBy ?? "—"} · {fmtDate(p.createdAt)}
                          </div>
                        </div>
                      ),
                    },
                    { key: "pct", header: "Extra", align: "right", cell: (p) => `${p.extraDiscountPct}%` },
                    { key: "total", header: "Total", align: "right", cell: (p) => formatINR(p.totalPaise) },
                    { key: "who", header: "Approval", cell: (p) => (p.approvedBy ? <span className="text-xs">by {p.approvedBy}</span> : <Badge tone="amber">Waiting</Badge>) },
                  ]}
                />
              )}
            </Panel>
          </div>
        </div>
      )}
    </>
  );
}

function LimitsEditor({ data, onSaved }: { data: SettingsView; onSaved: (v: SettingsView) => void }) {
  const roles = [...new Set([...SELLING_ROLES, ...Object.keys(data.discountLimits)])].filter((r) => r !== "founder");
  const [limits, setLimits] = useState<Record<string, number>>(() => Object.fromEntries(roles.map((r) => [r, data.discountLimits[r] ?? 0])));
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const can = data.canEdit.discountLimits;
  const dirty = roles.some((r) => (data.discountLimits[r] ?? 0) !== limits[r]);

  async function save() {
    setError(undefined);
    setSaved(false);
    try {
      onSaved(await api.settings.save("discountLimits", limits));
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <Panel title="Limit per role" subtitle="Extra discount on top of bundle pricing, as % of the subtotal.">
      <ErrorNote>{error}</ErrorNote>
      {saved && !dirty && <p className="mb-4 border border-green bg-green/10 px-4 py-2 text-sm">Limits saved and logged.</p>}
      <ul className="divide-y divide-border border-y border-border">
        <li className="flex items-center justify-between gap-4 py-3 text-sm">
          <span className="font-medium">Founder</span>
          <span className="text-ink-muted">No limit · approves everything above</span>
        </li>
        {roles.map((r) => (
          <li key={r} className="flex items-center justify-between gap-4 py-3 text-sm">
            <label htmlFor={`lim-${r}`} className="font-medium">
              {ROLE_LABEL[r] ?? r}
            </label>
            <div className="flex items-center gap-2">
              <Input
                id={`lim-${r}`}
                type="number"
                min={0}
                max={100}
                step={1}
                disabled={!can}
                value={limits[r]}
                onChange={(e) => setLimits({ ...limits, [r]: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })}
                className="w-20 text-right tabular-nums"
              />
              <span className="text-ink-muted">%</span>
            </div>
          </li>
        ))}
      </ul>
      <div className="mt-6">
        <BarList items={roles.map((r) => ({ label: ROLE_LABEL[r] ?? r, value: limits[r] }))} format={(n) => `${n}%`} max={Math.max(25, ...roles.map((r) => limits[r]))} />
      </div>
      {can ? (
        <Button className="mt-6" disabled={!dirty} onClick={save}>
          Save limits
        </Button>
      ) : (
        <p className="mt-6 text-sm text-ink-muted">Only the Founder or Branch Manager can change limits.</p>
      )}
    </Panel>
  );
}
