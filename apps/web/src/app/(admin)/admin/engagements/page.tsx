"use client";

import { useMemo, useState } from "react";
import type { AdminEngagementRow } from "@bmu/shared";
import { DataTable, Panel, StackBar, StatRow, StatTile, type Column } from "@/components/dash";
import { Button, LoadState, PageTitle, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { BILLING, ENGAGEMENT_STATUS, StatusBadge, fmtDate, gateLabel } from "../_admin-org/kit";

const STOPPED = ["paused", "offboarding", "closed"];
const GATES = ["G1", "G2", "G3", "G4", "G5"];

export default function EngagementsPage() {
  const rows = useLoad(() => api.adminOrg.engagements());
  const [status, setStatus] = useState("open");
  const [gate, setGate] = useState("");
  const [am, setAm] = useState("");
  const [billing, setBilling] = useState("");

  const all = useMemo(() => rows.data ?? [], [rows.data]);
  const ams = useMemo(() => [...new Map(all.filter((r) => r.am).map((r) => [r.am!.id, r.am!.name])).entries()].sort((a, b) => a[1].localeCompare(b[1])), [all]);
  const filtered = all.filter(
    (r) =>
      (status === "" || (status === "open" ? !STOPPED.includes(r.status) : r.status === status)) &&
      (!gate || r.currentGate === gate) &&
      (!am || (am === "none" ? !r.am : r.am?.id === am)) &&
      (!billing || r.billingType === billing),
  );
  const count = (pred: (r: AdminEngagementRow) => boolean) => all.filter(pred).length;
  const open = all.filter((r) => !STOPPED.includes(r.status));

  const columns: Column<AdminEngagementRow>[] = [
    {
      key: "client",
      header: "Client",
      cell: (r) => (
        <span>
          {r.client.name}
          <span className="block text-xs font-normal text-ink-muted">{r.serviceName}</span>
        </span>
      ),
    },
    { key: "tier", header: "Tier", cell: (r) => <span className="capitalize">{r.tier}</span> },
    { key: "billing", header: "Billing", cell: (r) => BILLING[r.billingType] ?? r.billingType },
    { key: "status", header: "Status", cell: (r) => <StatusBadge status={r.status} /> },
    { key: "gate", header: "Current gate", cell: (r) => <span className="whitespace-nowrap text-ink-muted">{gateLabel(r.currentGate)}</span> },
    { key: "am", header: "Account manager", cell: (r) => r.am?.name ?? <span className="text-[#9a6b00]">Unassigned</span> },
    { key: "start", header: "Started", align: "right", cell: (r) => <span className="whitespace-nowrap">{fmtDate(r.startDate)}</span> },
  ];

  const filtersOn = status !== "open" || gate || am || billing;

  return (
    <>
      <PageTitle title="Engagements" subtitle="Every client service we deliver, where it stands, and who looks after it. Open a row to see the full project." />
      <LoadState loading={rows.loading && !rows.data} error={rows.error} />
      {rows.data && (
        <div className="space-y-6">
          <StatRow cols={5}>
            <StatTile label="Open" value={open.length} hint={`${count((r) => r.billingType === "monthly" && !STOPPED.includes(r.status))} retainers`} />
            <StatTile label="Blocked" value={count((r) => r.status === "blocked")} tone={count((r) => r.status === "blocked") ? "warn" : "default"} />
            <StatTile label="Final payment due" value={count((r) => r.status === "awaiting_final_payment")} />
            <StatTile label="Paused or offboarding" value={count((r) => r.status === "paused" || r.status === "offboarding")} href="/admin/offboarding" />
            <StatTile label="Closed" value={count((r) => r.status === "closed")} />
          </StatRow>

          <Panel title="Open work by gate">
            <StackBar
              parts={GATES.map((g, i) => ({ label: gateLabel(g), value: open.filter((r) => r.currentGate === g).length, tone: (["grey", "muted", "dark", "amber", "green"] as const)[i] }))}
            />
          </Panel>

          <Panel
            title={`${filtered.length} engagement${filtered.length === 1 ? "" : "s"}`}
            action={
              <div className="flex flex-wrap items-center gap-2">
                <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
                  <option value="open">Open</option>
                  <option value="">All statuses</option>
                  {Object.entries(ENGAGEMENT_STATUS).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </Select>
                <Select aria-label="Gate" value={gate} onChange={(e) => setGate(e.target.value)}>
                  <option value="">All gates</option>
                  {GATES.map((g) => (
                    <option key={g} value={g}>
                      {gateLabel(g)}
                    </option>
                  ))}
                </Select>
                <Select aria-label="Account manager" value={am} onChange={(e) => setAm(e.target.value)}>
                  <option value="">All AMs</option>
                  <option value="none">Unassigned</option>
                  {ams.map(([id, name]) => (
                    <option key={id} value={id}>
                      {name}
                    </option>
                  ))}
                </Select>
                <Select aria-label="Billing type" value={billing} onChange={(e) => setBilling(e.target.value)}>
                  <option value="">All billing</option>
                  {Object.entries(BILLING).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </Select>
                {filtersOn && (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setStatus("open");
                      setGate("");
                      setAm("");
                      setBilling("");
                    }}
                  >
                    Clear
                  </Button>
                )}
              </div>
            }
            flush
          >
            <DataTable rows={filtered} columns={columns} rowKey={(r) => r.id} rowHref={(r) => `/team/projects/${r.id}`} empty={all.length ? "No engagements match these filters." : "No engagements yet. They start when a client pays for a proposal."} />
          </Panel>
        </div>
      )}
    </>
  );
}
