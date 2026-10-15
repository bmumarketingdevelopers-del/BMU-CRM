"use client";

import Link from "next/link";
import { useState } from "react";
import type { ClientRow } from "@bmu/shared";
import { DataTable, Panel, StatRow, StatTile, type Column } from "@/components/dash";
import { Badge, Input, LoadState } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

const statusLabel = (s: string) => s.replace(/_/g, " ");
const ACTIVE = (s: string) => !["delivered", "closed", "paused"].includes(s);
export const healthTone = (h: string) => (h === "green" ? "green" : h === "amber" ? "amber" : "red");
export const healthLabel = (h: string) => (h === "green" ? "Healthy" : h === "amber" ? "Watch" : "At risk");

export function ClientsTable() {
  const clients = useLoad(() => api.clients.list());
  const [q, setQ] = useState("");
  if (!clients.data) return <LoadState loading={clients.loading} error={clients.error} />;
  const all = clients.data;
  const rows = all.filter((c) => `${c.name} ${c.industry ?? ""} ${c.am?.name ?? ""}`.toLowerCase().includes(q.trim().toLowerCase()));
  const services = all.reduce((s, c) => s + c.engagements.filter((e) => ACTIVE(e.status)).length, 0);

  const columns: Column<ClientRow>[] = [
    {
      key: "name",
      header: "Client",
      cell: (c) => (
        <span>
          {c.name}
          {c.industry && <span className="block text-xs font-normal text-ink-muted">{c.industry}</span>}
        </span>
      ),
    },
    { key: "am", header: "Client Manager", cell: (c) => c.am?.name ?? <span className="text-ink-muted">Unassigned</span> },
    {
      key: "services",
      header: "Services",
      cell: (c) =>
        c.engagements.length ? (
          <ul className="space-y-0.5">
            {c.engagements.map((e) => (
              <li key={e.id} className="whitespace-nowrap">
                <Link href={`/team/projects/${e.id}`} className="hover:underline">
                  {e.serviceName}
                </Link>{" "}
                <span className="text-xs text-ink-muted">
                  · {statusLabel(e.status)} · {e.currentGate}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <span className="text-ink-muted">None yet</span>
        ),
    },
    { key: "health", header: "Health", cell: (c) => <Badge tone={healthTone(c.health)}>{healthLabel(c.health)}</Badge> },
    {
      key: "open",
      header: "",
      align: "right",
      cell: (c) => (
        <Link href={`/team/clients/${c.id}`} className="text-xs whitespace-nowrap text-ink-muted hover:text-ink">
          Client 360 →
        </Link>
      ),
    },
  ];

  return (
    <div className="grid gap-6 [&_.grid>*]:min-w-0 [&>*]:min-w-0">
      <StatRow cols={4}>
        <StatTile label="Clients" value={all.length} />
        <StatTile label="Active services" value={services} />
        <StatTile label="Healthy" value={all.filter((c) => c.health === "green").length} tone="good" />
        <StatTile label="Watch or at risk" value={all.filter((c) => c.health !== "green").length} tone={all.some((c) => c.health === "red") ? "bad" : all.some((c) => c.health !== "green") ? "warn" : "default"} />
      </StatRow>
      <Panel
        title="All clients"
        subtitle={`${rows.length} of ${all.length}`}
        action={<Input className="w-56" placeholder="Search clients or CMs" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search clients" />}
        flush
      >
        <DataTable
          rows={rows}
          columns={columns}
          rowKey={(c) => c.id}
          rowHref={(c) => `/team/clients/${c.id}`}
          empty={all.length ? "No clients match your search." : "No clients yet. A client account is created automatically when a proposal is paid."}
        />
      </Panel>
    </div>
  );
}
