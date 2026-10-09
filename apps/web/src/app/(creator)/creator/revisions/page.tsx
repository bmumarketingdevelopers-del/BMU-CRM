"use client";

import Link from "next/link";
import { formatINR } from "@bmu/shared";
import { Empty, Panel } from "@/components/dash";
import { fmtDay } from "@/components/workspace/format";
import { Badge, LoadState, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

export default function RevisionsPage() {
  const loaded = useLoad(async () => {
    const briefs = (await api.creator.briefs()).filter((b) => b.status === "revision");
    return Promise.all(briefs.map((b) => api.creator.brief(b.id)));
  });
  return (
    <>
      <PageTitle title="Revisions" subtitle="Briefs where BMU asked for changes. Open one, read the feedback and send a new version." />
      {!loaded.data ? (
        <LoadState loading={loaded.loading} error={loaded.error} />
      ) : loaded.data.length === 0 ? (
        <Panel>
          <Empty>No revisions needed. Nice work!</Empty>
        </Panel>
      ) : (
        <div className="grid gap-4">
          {loaded.data.map((b) => {
            const last = b.submissionList.at(-1);
            return (
              <Link key={b.id} href={`/creator/briefs/${b.id}`} className="block border border-border border-l-2 border-l-red bg-surface-raised p-5 transition-colors hover:bg-canvas/40">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="font-semibold tracking-tight">{b.title}</h2>
                    <p className="text-sm text-ink-muted">
                      {b.client?.name ?? "BMU Marketing"} · {formatINR(b.feePaise)}
                      {b.dueAt && ` · due ${fmtDay.format(new Date(b.dueAt))}`}
                    </p>
                  </div>
                  <Badge tone="red">Version {last?.number ?? 1} needs changes</Badge>
                </div>
                {last?.feedback && <p className="mt-3 border-t border-border pt-3 text-sm whitespace-pre-line">“{last.feedback}”</p>}
                <p className="mt-3 text-xs text-ink-muted">Open to send a new version →</p>
              </Link>
            );
          })}
        </div>
      )}
    </>
  );
}
