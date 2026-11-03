"use client";

// v45: Client 360 → the client's quotations, with "New quotation" (for the client's CM, leadership and Finance).
import Link from "next/link";
import { formatINR, quoteStatusLabels } from "@bmu/shared";
import { Panel } from "@/components/dash";
import { Badge } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

export function ClientQuotations({ clientId }: { clientId: string }) {
  const list = useLoad(() => api.quotes.list({ clientOrgId: clientId }), { live: ["Quotation"] });
  if (list.error || !list.data) return null;
  return (
    <Panel
      title="Quotations"
      subtitle="Sent to the client to accept in their app; the advance invoice is created when they accept"
      action={
        <Link href={`/team/quotes/new?clientId=${clientId}`} className="text-sm underline" data-testid="client-quote-new">
          + New quotation
        </Link>
      }
      flush
    >
      {list.data.length ? (
        <ul className="divide-y divide-border" data-testid="client-quotations">
          {list.data.map((q) => (
            <li key={q.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
              <Link href={`/team/quotes/${q.id}`} className="min-w-0 truncate underline">
                {q.number} · {q.title}
              </Link>
              <span className="flex shrink-0 items-center gap-3">
                <span className="tabular-nums">{formatINR(q.totalPaise)}</span>
                <Badge tone={q.status === "accepted" ? "green" : q.status === "sent" ? "amber" : q.status === "declined" ? "red" : "neutral"}>{quoteStatusLabels[q.status].team}</Badge>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-4 py-3 text-sm text-ink-muted">No quotations yet.</p>
      )}
    </Panel>
  );
}
