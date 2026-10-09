"use client";

import Link from "next/link";
import { Badge, Card, LoadState, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

export default function ClientReviewsPage() {
  const list = useLoad(() => api.client.reviews());
  if (!list.data) return <LoadState loading={list.loading} error={list.error} />;
  const waiting = list.data.filter((r) => r.waitingOnYou);
  const rest = list.data.filter((r) => !r.waitingOnYou);
  return (
    <>
      <PageTitle title="Review Studio" subtitle="Look at drafts, pin comments right on the work, and approve when you're happy." />
      {waiting.length > 0 && <h2 className="mb-2 font-semibold">Ready for your review</h2>}
      <div className="mb-6 grid gap-2 md:grid-cols-2">
        {waiting.map((r) => (
          <Link key={r.id} href={`/client/reviews/${r.id}`} className="border border-amber bg-surface-raised p-4 hover:border-green">
            <div className="flex justify-between gap-2">
              <span className="font-medium">{r.title}</span>
              <Badge tone="amber">Version {r.latestVersion}</Badge>
            </div>
            <p className="mt-1 text-xs text-ink-muted">{r.serviceName}</p>
          </Link>
        ))}
      </div>
      <h2 className="mb-2 font-semibold">All work</h2>
      <Card className="p-0">
        <ul className="divide-y divide-border text-sm">
          {rest.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
              {r.latestVersion ? (
                <Link href={`/client/reviews/${r.id}`} className="underline">
                  {r.title}
                </Link>
              ) : (
                <span>{r.title}</span>
              )}
              <span className="text-ink-muted">
                {r.serviceName} · {r.statusLabel}
              </span>
            </li>
          ))}
          {rest.length === 0 && <li className="px-4 py-3 text-ink-muted">Nothing else yet.</li>}
        </ul>
      </Card>
    </>
  );
}
