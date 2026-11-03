"use client";

// v45: every quotation the person can see (a Client Manager: their clients; leadership and Finance: all).
import Link from "next/link";
import { useState } from "react";
import { formatINR, quoteStatusLabels, type QuoteStatus } from "@bmu/shared";
import { Badge, LoadState, PageTitle, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

const tone: Record<QuoteStatus, "neutral" | "amber" | "green" | "red"> = { draft: "neutral", sent: "amber", accepted: "green", declined: "red", cancelled: "neutral", expired: "neutral" };
const day = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });

export default function QuotesPage() {
  const [status, setStatus] = useState("");
  const list = useLoad(() => api.quotes.list(), { live: ["Quotation"] });
  const rows = (list.data ?? []).filter((r) => !status || r.status === status);
  return (
    <>
      <PageTitle
        title="Quotations"
        subtitle="Make a quotation from a template, send it, and the client accepts it in their app. The advance invoice is created when they accept; raise the balance invoice later from the quotation."
        action={
          <Link href="/team/quotes/new" className="bg-charcoal px-4 py-2 text-sm font-medium text-ivory" data-testid="quote-new">
            New quotation
          </Link>
        }
      />
      <div className="mb-3 flex items-center gap-3">
        <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status" className="max-w-xs">
          <option value="">Every status</option>
          {(Object.keys(quoteStatusLabels) as QuoteStatus[]).map((s) => (
            <option key={s} value={s}>
              {quoteStatusLabels[s].team}
            </option>
          ))}
        </Select>
      </div>
      {!list.data ? (
        <LoadState loading={list.loading} error={list.error} />
      ) : rows.length === 0 ? (
        <p className="py-10 text-center text-sm text-ink-muted">No quotations yet.</p>
      ) : (
        <div className="overflow-x-auto border border-border bg-surface-raised">
          <table className="w-full min-w-[720px] text-sm" data-testid="quote-list">
            <thead>
              <tr className="border-b border-border text-left text-xs text-ink-muted">
                <th className="px-4 py-2 font-normal">Quotation</th>
                <th className="px-4 py-2 font-normal">Client</th>
                <th className="px-4 py-2 font-normal">Project</th>
                <th className="px-4 py-2 text-right font-normal">Total</th>
                <th className="px-4 py-2 font-normal">Valid until</th>
                <th className="px-4 py-2 font-normal">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-border">
                  <td className="px-4 py-2">
                    <Link href={`/team/quotes/${r.id}`} className="font-medium underline">
                      {r.number}
                    </Link>
                    <span className="block text-xs text-ink-muted">
                      {day.format(new Date(r.date))}
                      {r.createdBy ? ` · ${r.createdBy}` : ""}
                    </span>
                  </td>
                  <td className="px-4 py-2">{r.client.name}</td>
                  <td className="px-4 py-2">{r.title}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{formatINR(r.totalPaise)}</td>
                  <td className="px-4 py-2">{day.format(new Date(`${r.validUntil}T00:00:00+05:30`))}</td>
                  <td className="px-4 py-2">
                    <Badge tone={tone[r.status]}>{quoteStatusLabels[r.status].team}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
