"use client";

import { useState } from "react";
import { formatINR, type BriefOptions, type BriefRow, type BriefStatus, type CreatorRow } from "@bmu/shared";
import { DataTable, Empty, Panel, StatRow, StatTile, Tabs } from "@/components/dash";
import { BriefStatusBadge } from "@/components/workspace/brief-bits";
import { fmtDay, istToday } from "@/components/workspace/format";
import { Button, Input, LoadState, PageTitle, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { useRouter } from "next/navigation";
import { CreatorRoster } from "@/components/ops/creator-roster";

type Group = "review" | "active" | "done" | "all";
const groupOf = (s: BriefStatus): Exclude<Group, "all"> => (s === "submitted" ? "review" : ["offered", "accepted", "revision"].includes(s) ? "active" : "done");

export default function CreatorsPage() {
  // Department heads see the roster (v11 ops) but not briefs, which stay with Client Managers.
  const data = useLoad(() => Promise.all([api.creatorAdmin.creators().catch(() => null), api.creatorAdmin.briefs().catch(() => null)]));
  const [picked, setGroup] = useState<Group>();
  const [creating, setCreating] = useState(false);
  if (!data.data)
    return (
      <div className="[&_.grid>*]:min-w-0">
        <PageTitle title="Creators" subtitle="Brief UGC creators and influencers, review their work and book payouts." />
        <LoadState loading={data.loading} error={data.error} />
      </div>
    );
  const [creatorsOrNull, briefsOrNull] = data.data;
  if (!briefsOrNull || !creatorsOrNull)
    return (
      <div className="[&_.grid>*]:min-w-0">
        <PageTitle title="Creators" subtitle="The UGC creators and influencers we work with." />
        <CreatorRoster />
      </div>
    );
  const creators: CreatorRow[] = creatorsOrNull;
  const briefs: BriefRow[] = briefsOrNull;
  const counts = { review: 0, active: 0, done: 0 };
  for (const b of briefs) counts[groupOf(b.status)]++;
  const group: Group = picked ?? (counts.review ? "review" : counts.active ? "active" : "all");
  const rows = group === "all" ? briefs : briefs.filter((b) => groupOf(b.status) === group);
  const pending = creators.reduce((s, c) => s + c.pendingPayoutPaise, 0);

  return (
    <div className="[&_.grid>*]:min-w-0">
      <PageTitle
        title="Creators"
        subtitle="Brief UGC creators and influencers, review their work and book payouts. Approving work books the payout with 10% TDS."
        action={<Button onClick={() => setCreating((v) => !v)}>{creating ? "Close" : "New brief"}</Button>}
      />
      {creating && <NewBrief onClose={() => setCreating(false)} />}

      <StatRow cols={4}>
        <StatTile label="Creators" value={creators.length} />
        <StatTile label="Waiting for your review" value={counts.review} tone={counts.review ? "warn" : "default"} />
        <StatTile label="Briefs in progress" value={counts.active} />
        <StatTile label="Payouts pending" value={formatINR(pending)} hint="Net of TDS" />
      </StatRow>

      <Panel
        title="Briefs"
        className="mt-6"
        flush
        action={
          <Tabs
            value={group}
            onChange={setGroup}
            options={[
              { value: "review", label: `To review ${counts.review}` },
              { value: "active", label: `In progress ${counts.active}` },
              { value: "done", label: `Closed ${counts.done}` },
              { value: "all", label: "All" },
            ]}
          />
        }
      >
        <DataTable<BriefRow>
          rows={rows}
          rowKey={(b) => b.id}
          rowHref={(b) => `/team/creators/briefs/${b.id}`}
          empty={briefs.length ? "No briefs in this group." : "No briefs yet. Create one with New brief."}
          columns={[
            { key: "t", header: "Brief", cell: (b) => <span>{b.title}<span className="block text-xs font-normal text-ink-muted">{b.client?.name ?? "Internal"}</span></span> },
            { key: "c", header: "Creator", cell: (b) => b.creator.name },
            { key: "s", header: "Status", cell: (b) => <BriefStatusBadge status={b.status} /> },
            { key: "v", header: "Versions", align: "right", cell: (b) => b.submissions },
            { key: "d", header: "Due", align: "right", cell: (b) => (b.dueAt ? fmtDay.format(new Date(b.dueAt)) : "—") },
            { key: "f", header: "Fee", align: "right", cell: (b) => formatINR(b.feePaise) },
          ]}
        />
      </Panel>

      <CreatorRoster />
    </div>
  );
}

function NewBrief({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const options = useLoad<BriefOptions>(() => api.creatorAdmin.options());
  const [v, setV] = useState({ creatorId: "", title: "", brief: "", deliverables: "", dueAt: "", fee: "", clientOrgId: "", engagementId: "" });
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const o = options.data;
  const client = o?.clients.find((c) => c.id === v.clientOrgId);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const b = await api.creatorAdmin.createBrief({
        creatorId: v.creatorId,
        title: v.title,
        brief: v.brief,
        deliverables: v.deliverables.split("\n").map((l) => l.trim()).filter(Boolean),
        dueAt: v.dueAt || undefined,
        feeRupees: Number(v.fee || 0),
        clientOrgId: v.clientOrgId || undefined,
        engagementId: v.engagementId || undefined,
      });
      router.push(`/team/creators/briefs/${b.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Panel title="New brief" subtitle="The creator is notified and can accept or decline it in the creator portal." className="mb-6">
      {!o ? (
        <LoadState loading={options.loading} error={options.error} />
      ) : o.creators.length === 0 ? (
        <Empty>No creators to brief yet.</Empty>
      ) : (
        <form onSubmit={submit} className="grid gap-4 md:grid-cols-2">
          <label className="text-sm">
            <span className="text-ink-muted">Creator</span>
            <Select className="mt-1 block w-full py-2" value={v.creatorId} onChange={(e) => setV({ ...v, creatorId: e.target.value })} required>
              <option value="">Choose…</option>
              {o.creators.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.niche.length ? ` · ${c.niche.join(", ")}` : ""}
                </option>
              ))}
            </Select>
          </label>
          <label className="text-sm">
            <span className="text-ink-muted">Title</span>
            <Input className="mt-1" value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} placeholder="e.g. Diwali home tour reel" required />
          </label>
          <label className="text-sm md:col-span-2">
            <span className="text-ink-muted">What you need</span>
            <textarea className="mt-1 w-full border border-border bg-surface-raised px-3 py-2 text-sm" rows={4} value={v.brief} onChange={(e) => setV({ ...v, brief: e.target.value })} placeholder="Hook, tone, must-show moments, call to action…" required />
          </label>
          <label className="text-sm">
            <span className="text-ink-muted">Deliverables (one per line)</span>
            <textarea className="mt-1 w-full border border-border bg-surface-raised px-3 py-2 text-sm" rows={3} value={v.deliverables} onChange={(e) => setV({ ...v, deliverables: e.target.value })} placeholder={"1 vertical reel (30s)\n3 story frames"} required />
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="text-sm">
              <span className="text-ink-muted">Due date</span>
              <Input type="date" className="mt-1" min={istToday()} value={v.dueAt} onChange={(e) => setV({ ...v, dueAt: e.target.value })} />
            </label>
            <label className="text-sm">
              <span className="text-ink-muted">Fee (₹, before TDS)</span>
              <Input type="number" min={0} step={1} className="mt-1" value={v.fee} onChange={(e) => setV({ ...v, fee: e.target.value })} placeholder="15000" required />
            </label>
            <label className="text-sm">
              <span className="text-ink-muted">Client (optional)</span>
              <Select className="mt-1 block w-full py-2" value={v.clientOrgId} onChange={(e) => setV({ ...v, clientOrgId: e.target.value, engagementId: "" })}>
                <option value="">None</option>
                {o.clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </label>
            <label className="text-sm">
              <span className="text-ink-muted">Service (optional)</span>
              <Select className="mt-1 block w-full py-2" value={v.engagementId} onChange={(e) => setV({ ...v, engagementId: e.target.value })} disabled={!client}>
                <option value="">None</option>
                {client?.engagements.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.serviceName}
                  </option>
                ))}
              </Select>
            </label>
          </div>
          <div className="md:col-span-2">
            {error && <p className="mb-2 text-sm text-red">{error}</p>}
            <div className="flex gap-2">
              <Button disabled={busy}>{busy ? "Sending…" : "Send brief"}</Button>
              <Button type="button" variant="ghost" onClick={onClose}>
                Cancel
              </Button>
            </div>
          </div>
        </form>
      )}
    </Panel>
  );
}
