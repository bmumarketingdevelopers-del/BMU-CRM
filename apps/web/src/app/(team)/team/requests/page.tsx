"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useActions } from "@/components/actions/actions-provider";
import { RequestStatusBadge, RequestTypeLabel, SlaBadge, when } from "@/components/request-bits";
import { LoadState, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

const OPEN = ["received", "scope_check", "in_scope", "quoted", "approved", "paid", "in_progress", "rescheduled"];

export default function TeamRequestsPage() {
  const list = useLoad(() => api.requests.list());
  const [tab, setTab] = useState<"open" | "closed">("open");
  const { canNew, openNew } = useActions();
  const router = useRouter();
  if (!list.data) return <LoadState loading={list.loading} error={list.error} />;
  const rows = list.data
    .filter((r) => (tab === "open" ? OPEN.includes(r.status) : !OPEN.includes(r.status)))
    .sort((a, b) => (a.sla.state === "overdue" ? -1 : 0) - (b.sla.state === "overdue" ? -1 : 0) || (a.type === "urgent" ? -1 : 0) - (b.type === "urgent" ? -1 : 0));
  const overdue = list.data.filter((r) => r.sla.state === "overdue").length;
  return (
    <>
      <PageTitle
        title="Requests inbox"
        subtitle={overdue ? `${overdue} request${overdue > 1 ? "s" : ""} past the first-reply target.` : "First replies are counted in working hours, 9:30 to 6:30, Monday to Saturday."}
        action={
          <div className="flex flex-wrap gap-2 text-sm">
            {canNew("request") && (
              <button type="button" onClick={() => openNew("request", {}, (rid) => (rid ? router.push(`/team/requests/${rid}`) : list.reload()))} className="bg-charcoal px-3 py-1 font-medium text-ivory">
                + Raise request
              </button>
            )}
            {(["open", "closed"] as const).map((t) => (
              <button key={t} onClick={() => setTab(t)} className={`border px-3 py-1 capitalize ${tab === t ? "border-ink" : "border-border text-ink-muted"}`}>
                {t}
              </button>
            ))}
          </div>
        }
      />
      <div className="border-t border-border">
        {rows.map((r) => (
          <Link key={r.id} href={`/team/requests/${r.id}`} className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-4 text-sm hover:bg-canvas/40">
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{r.description}</p>
              <p className="text-xs text-ink-muted">
                <RequestTypeLabel type={r.type} side="team" /> · {r.client.name} · {r.engagement.serviceName} · {when.format(new Date(r.createdAt))}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {r.rating && <span title={r.rating.comment ?? undefined}>{r.rating.value === "up" ? "👍" : "👎"}</span>}
              {!!r.reopenCount && OPEN.includes(r.status) && <span className="text-xs text-amber">Reopened</span>}
              {OPEN.includes(r.status) && <SlaBadge sla={r.sla} />}
              <RequestStatusBadge status={r.status} side="team" />
            </div>
          </Link>
        ))}
        {rows.length === 0 && <p className="py-8 text-center text-sm text-ink-muted">Nothing here.</p>}
      </div>
    </>
  );
}
