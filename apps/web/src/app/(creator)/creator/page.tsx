"use client";

import Link from "next/link";
import { useState } from "react";
import { formatINR, type BriefRow } from "@bmu/shared";
import { Empty, Panel, StatRow, StatTile, Tabs } from "@/components/dash";
import { BriefStatusBadge } from "@/components/workspace/brief-bits";
import { fmtDay } from "@/components/workspace/format";
import { Button, LoadState, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

type Group = "offered" | "active" | "done";
const groupOf = (b: BriefRow): Group => (b.status === "offered" ? "offered" : ["accepted", "submitted", "revision"].includes(b.status) ? "active" : "done");

export default function CreatorBriefsPage() {
  const loaded = useLoad(() => api.creator.briefs());
  const [rows, setRows] = useState<BriefRow[]>();
  const [group, setGroup] = useState<Group>();
  const [error, setError] = useState<string>();
  const briefs = rows ?? loaded.data;
  if (!briefs)
    return (
      <div className="[&_.grid>*]:min-w-0">
        <PageTitle title="Briefs" subtitle="Work offered to you by BMU Marketing." />
        <LoadState loading={loaded.loading} error={loaded.error} />
      </div>
    );
  const counts = { offered: 0, active: 0, done: 0 };
  for (const b of briefs) counts[groupOf(b)]++;
  const current = group ?? (counts.offered ? "offered" : "active");
  const list = briefs.filter((b) => groupOf(b) === current);

  async function respond(id: string, accept: boolean) {
    setError(undefined);
    try {
      await (accept ? api.creator.accept(id) : api.creator.decline(id));
      setRows(await api.creator.briefs());
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="[&_.grid>*]:min-w-0">
      <PageTitle title="Briefs" subtitle="Work offered to you by BMU Marketing. Accept a brief to start, then send your work for review." />
      <StatRow cols={4}>
        <StatTile label="New offers" value={counts.offered} tone={counts.offered ? "good" : "default"} />
        <StatTile label="In progress" value={counts.active} />
        <StatTile label="Needs revision" value={briefs.filter((b) => b.status === "revision").length} tone={briefs.some((b) => b.status === "revision") ? "warn" : "default"} href="/creator/revisions" />
        <StatTile label="Completed" value={counts.done} href="/creator/payouts" hint="See payouts →" />
      </StatRow>

      <div className="mt-6 mb-4 flex flex-wrap items-center justify-between gap-3">
        <Tabs
          value={current}
          onChange={setGroup}
          options={[
            { value: "offered", label: `Offered ${counts.offered}` },
            { value: "active", label: `Active ${counts.active}` },
            { value: "done", label: `Done ${counts.done}` },
          ]}
        />
      </div>
      {error && <p className="mb-4 border border-red bg-red/10 px-4 py-2 text-sm">{error}</p>}

      {list.length === 0 ? (
        <Panel>
          <Empty>{current === "offered" ? "No new offers right now. We'll notify you when one arrives." : current === "active" ? "Nothing in progress." : "No completed briefs yet."}</Empty>
        </Panel>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {list.map((b) => (
            <article key={b.id} className="flex flex-col border border-border bg-surface-raised">
              <Link href={`/creator/briefs/${b.id}`} className="block flex-1 p-5 transition-colors hover:bg-canvas/40">
                <div className="flex items-start justify-between gap-3">
                  <h2 className="font-semibold tracking-tight">{b.title}</h2>
                  <BriefStatusBadge status={b.status} creatorView />
                </div>
                <p className="mt-1 text-sm text-ink-muted">{b.client?.name ?? "BMU Marketing"}</p>
                <div className="mt-5 flex gap-6 text-sm">
                  <div>
                    <p className="text-[11px] uppercase tracking-[0.1em] text-ink-muted">Fee</p>
                    <p className="mt-0.5 font-semibold tabular-nums">{formatINR(b.feePaise)}</p>
                  </div>
                  <div>
                    <p className="text-[11px] uppercase tracking-[0.1em] text-ink-muted">Due</p>
                    <p className="mt-0.5 font-semibold">{b.dueAt ? fmtDay.format(new Date(b.dueAt)) : "Flexible"}</p>
                  </div>
                  <div>
                    <p className="text-[11px] uppercase tracking-[0.1em] text-ink-muted">Versions</p>
                    <p className="mt-0.5 font-semibold tabular-nums">{b.submissions}</p>
                  </div>
                </div>
              </Link>
              {b.status === "offered" && (
                <div className="flex gap-2 border-t border-border px-5 py-3">
                  <Button onClick={() => respond(b.id, true)}>Accept</Button>
                  <Button variant="ghost" onClick={() => respond(b.id, false)}>
                    Decline
                  </Button>
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
