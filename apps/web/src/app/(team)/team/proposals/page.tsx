"use client";

import Link from "next/link";
import { formatINR } from "@bmu/shared";
import { statusBadge } from "@/components/proposal-status";
import { LoadState, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

const date = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" });

export default function ProposalsPage() {
  const list = useLoad(() => api.proposals.list());
  return (
    <>
      <PageTitle title="Proposals" subtitle="Create a proposal from any lead in the pipeline. Only the latest version of each proposal is listed." action={<Link href="/team/approvals" className="text-sm underline">Discount approvals</Link>} />
      <LoadState loading={list.loading} error={list.error} />
      {list.data && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] bg-surface-raised text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[11px] uppercase tracking-[0.12em] text-ink-muted">
                <th className="px-3 py-2">Client</th>
                <th className="px-3 py-2">Total</th>
                <th className="px-3 py-2">Due now</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Client opened</th>
                <th className="px-3 py-2">Created</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((p) => (
                <tr key={p.id} className="border-b border-border hover:bg-canvas/50">
                  <td className="px-3 py-2">
                    <Link href={`/team/proposals/${p.id}`} className="font-medium underline-offset-2 hover:underline">
                      {p.client.company || p.client.name}
                    </Link>
                    <span className="ml-2 text-xs text-ink-muted">v{p.version}{p.kind === "renewal" ? " · renewal" : ""}</span>
                  </td>
                  <td className="px-3 py-2">{formatINR(p.totalPaise)}</td>
                  <td className="px-3 py-2">{formatINR(p.firstPayment.totalPaise)}</td>
                  <td className="px-3 py-2">
                    {statusBadge(p)}
                    {p.status === "draft" && p.discountStatus === "pending" && (
                      <span className="block text-xs text-ink-muted">
                        waiting for {p.approvalSteps?.find((s) => s.status === "pending")?.level === "founder" ? "the Founder" : "a sales manager"}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-ink-muted">{p.viewCount ? `${p.viewCount}×, last ${date.format(new Date(p.lastViewedAt ?? p.viewedAt ?? p.createdAt))}` : p.status === "sent" ? "not yet" : "—"}</td>
                  <td className="px-3 py-2">{date.format(new Date(p.createdAt))}</td>
                </tr>
              ))}
              {list.data.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-6 text-center text-ink-muted">
                    No proposals yet. Open a lead in <Link href="/team/leads" className="underline">Leads</Link> and choose Create proposal.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
