"use client";

// v45: the client's quotations from BMU.
import Link from "next/link";
import { formatINR, quoteStatusLabels } from "@bmu/shared";
import { Badge, LoadState, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

const day = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });

export default function ClientQuotesPage() {
  const list = useLoad(() => api.quotes.mine(), { live: ["Quotation"] });
  return (
    <>
      <PageTitle title="Quotations" subtitle="Quotations from your Client Manager. Open one to read it, accept it or decline it." />
      {!list.data ? (
        <LoadState loading={list.loading} error={list.error} />
      ) : list.data.length === 0 ? (
        <p className="py-10 text-center text-sm text-ink-muted">No quotations yet.</p>
      ) : (
        <ul className="divide-y divide-border border border-border bg-surface-raised" data-testid="client-quotes">
          {list.data.map((q) => (
            <li key={q.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
              <div className="min-w-0">
                <Link href={`/client/quotes/${q.id}`} className="font-medium underline">
                  {q.title}
                </Link>
                <p className="text-xs text-ink-muted">
                  {q.number} · {day.format(new Date(q.date))} · valid until {day.format(new Date(`${q.validUntil}T00:00:00+05:30`))}
                </p>
              </div>
              <span className="flex items-center gap-3">
                <span className="tabular-nums">{formatINR(q.totalPaise)}</span>
                <Badge tone={q.status === "accepted" ? "green" : q.status === "sent" ? "amber" : q.status === "declined" ? "red" : "neutral"}>{quoteStatusLabels[q.status].client}</Badge>
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
