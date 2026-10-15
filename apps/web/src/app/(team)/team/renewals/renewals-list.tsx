"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatINR, SELL_RENEWAL_MONTHS, type SellRenewal } from "@bmu/shared";
import { CsvButton } from "@/components/charts";
import { Empty, StatRow, StatTile } from "@/components/dash";
import { Badge, Button, LoadState } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

const d = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" });
const tone = { overdue: "red", soon: "amber", upcoming: "neutral" } as const;

export function RenewalsList() {
  const router = useRouter();
  const list = useLoad(() => api.sell.renewals());
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [picked, setPicked] = useState<Record<string, string[]>>({});

  async function start(clientOrgId: string, rows: SellRenewal[]) {
    const ids = picked[clientOrgId] ?? rows.filter((r) => !r.openProposal).map((r) => r.engagementId);
    if (!ids.length) return setError("Tick at least one service to renew.");
    setBusy(clientOrgId);
    setError(undefined);
    try {
      const p = await api.sell.createRenewal(clientOrgId, ids);
      router.push(`/team/proposals/${p.id}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(undefined);
    }
  }

  if (!list.data) return <LoadState loading={list.loading} error={list.error} />;
  const rows = list.data;
  const byClient = Map.groupBy(rows, (r) => r.clientOrgId);
  const monthly = rows.filter((r) => r.monthlyPaise).reduce((s, r) => s + (r.monthlyPaise ?? 0), 0);

  return (
    <div className="space-y-6">
      {error && <p className="border border-red bg-red/10 px-4 py-2 text-sm" role="alert">{error}</p>}
      <StatRow cols={4}>
        <StatTile label="Up for renewal" value={rows.length} hint="services in the window" />
        <StatTile label="Overdue" value={rows.filter((r) => r.urgency === "overdue").length} tone={rows.some((r) => r.urgency === "overdue") ? "bad" : "default"} hint="past the date, not renewed" />
        <StatTile label="Monthly value at stake" value={formatINR(monthly)} hint="retainers in this list" />
        <StatTile label="Proposal in progress" value={rows.filter((r) => r.openProposal).length} hint="renewal drafted or sent" />
      </StatRow>
      <div className="flex justify-end">
        <CsvButton
          filename="renewals.csv"
          rows={rows}
          columns={[
            { header: "Client", value: (r) => r.client },
            { header: "Service", value: (r) => r.service },
            { header: "Tier", value: (r) => r.tier },
            { header: "Billing", value: (r) => r.billingType },
            { header: "Due", value: (r) => r.dueDate.slice(0, 10) },
            { header: "Reason", value: (r) => r.reason },
            { header: "Monthly (₹)", value: (r) => (r.monthlyPaise ? r.monthlyPaise / 100 : "") },
            { header: "Client manager", value: (r) => r.am },
            { header: "Proposal", value: (r) => r.openProposal?.status ?? "" },
          ]}
        />
      </div>
      {rows.length === 0 && <Empty>No renewals due in the next 45 days.</Empty>}
      {[...byClient.entries()].map(([clientOrgId, items]) => {
        const sel = picked[clientOrgId] ?? items.filter((r) => !r.openProposal).map((r) => r.engagementId);
        const allOpen = items.every((r) => r.openProposal);
        return (
          <section key={clientOrgId} className="border border-border bg-surface-raised" aria-label={`Renewal for ${items[0].client}`}>
            <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
              <div>
                <Link href={`/team/clients/${clientOrgId}`} className="font-semibold underline-offset-2 hover:underline">
                  {items[0].client}
                </Link>
                <span className="ml-2 text-xs text-ink-muted">CM: {items[0].am ?? "not assigned"}</span>
              </div>
              {allOpen ? (
                <Link href={`/team/proposals/${items[0].openProposal!.id}`} className="text-sm underline">
                  Open renewal proposal (v{items[0].openProposal!.version}, {items[0].openProposal!.status})
                </Link>
              ) : (
                <Button disabled={busy === clientOrgId || sel.length === 0} onClick={() => start(clientOrgId, items)}>
                  {busy === clientOrgId ? "Drafting…" : "Create renewal proposal"}
                </Button>
              )}
            </header>
            <ul className="divide-y divide-border text-sm">
              {items.map((r) => (
                <li key={r.engagementId} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <input
                    type="checkbox"
                    aria-label={`Renew ${r.service}`}
                    className="size-4 accent-[#8BB72C]"
                    disabled={!!r.openProposal}
                    checked={sel.includes(r.engagementId)}
                    onChange={() => setPicked({ ...picked, [clientOrgId]: sel.includes(r.engagementId) ? sel.filter((x) => x !== r.engagementId) : [...sel, r.engagementId] })}
                  />
                  <span className="min-w-0 flex-1">
                    {r.service} <span className="capitalize text-ink-muted">· {r.tier} · {r.billingType === "monthly" ? "monthly" : "project"}</span>
                    <span className="block text-xs text-ink-muted">
                      {r.reason}
                      {r.startDate ? ` · started ${d.format(new Date(r.startDate))} (${r.monthsActive} months)` : ""}
                      {r.renewalCount ? ` · renewed ${r.renewalCount}×` : ""}
                    </span>
                  </span>
                  {r.monthlyPaise ? <span>{formatINR(r.monthlyPaise)}/mo</span> : null}
                  <Badge tone={tone[r.urgency]}>{r.urgency === "overdue" ? "overdue" : r.urgency === "soon" ? "within 14 days" : "upcoming"}</Badge>
                  {r.openProposal && (
                    <Link href={`/team/proposals/${r.openProposal.id}`} className="text-xs underline">
                      proposal {r.openProposal.status}
                    </Link>
                  )}
                </li>
              ))}
            </ul>
            <p className="px-4 pb-3 text-xs text-ink-muted">Accepting a renewal extends monthly retainers by {SELL_RENEWAL_MONTHS} months on the same client account (no duplicate client). Added services start as new engagements.</p>
          </section>
        );
      })}
    </div>
  );
}
