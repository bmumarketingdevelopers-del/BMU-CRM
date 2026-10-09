"use client";

import { useState } from "react";
import { DELIVER_CHANNELS, deliverChannelLabels, formatINR, type CreativeSettingsView, type DeliverChannel, type PostResultsSummary } from "@bmu/shared";
import { DataTable, Empty, Panel, StatRow, StatTile } from "@/components/dash";
import { Button, Input, LoadState, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

const num = (n: number) => new Intl.NumberFormat("en-IN").format(n);
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const defaultRange = () => ({ from: isoDay(new Date(Date.now() - 30 * 86_400_000)), to: isoDay(new Date(Date.now() + 86_400_000)) });

/** Post results over a date range: totals, by client (team) and the best posts. Numbers are typed in from each platform. */
export function ResultsSummary({ mode }: { mode: "team" | "client" }) {
  const [range, setRange] = useState(defaultRange);
  return (
    <Panel
      title="Post results"
      subtitle="Reach, engagement and clicks of published posts, as recorded from each platform's insights."
      className="mt-8"
      action={
        <span className="flex items-center gap-1 text-xs">
          <Input type="date" className="py-1 text-xs" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} aria-label="From" />
          to
          <Input type="date" className="py-1 text-xs" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} aria-label="To" />
        </span>
      }
    >
      <Results key={`${range.from}-${range.to}`} mode={mode} from={range.from} to={range.to} />
    </Panel>
  );
}

function Results({ mode, from, to }: { mode: "team" | "client"; from: string; to: string }) {
  const r = useLoad<PostResultsSummary>(() => (mode === "team" ? api.creative.results(`${from}T00:00:00+05:30`, `${to}T00:00:00+05:30`) : api.creative.clientResults(`${from}T00:00:00+05:30`, `${to}T00:00:00+05:30`)), { live: ["PostMetric", "Deliverable"] });
  if (!r.data) return <LoadState loading={r.loading} error={r.error} />;
  const s = r.data;
  if (!s.posts) return <Empty>No posts went live in these dates.</Empty>;
  return (
    <div data-testid="results-summary">
      <StatRow cols={5}>
        <StatTile label="Posts live" value={s.posts} hint={`${s.withResults} with results`} />
        <StatTile label="Reach" value={num(s.totals.reach)} />
        <StatTile label="Engagement" value={num(s.totals.engagement)} hint={s.totals.reach ? `${((s.totals.engagement / s.totals.reach) * 100).toFixed(1)}% of reach` : undefined} />
        <StatTile label="Clicks" value={num(s.totals.clicks)} />
        <StatTile label="Ad spend" value={formatINR(s.totals.spendPaise)} />
      </StatRow>
      {mode === "team" && s.byClient.length > 1 && (
        <div className="mt-4">
          <DataTable
            rows={s.byClient}
            rowKey={(c) => c.clientId}
            columns={[
              { key: "client", header: "Client", cell: (c) => c.client },
              { key: "posts", header: "Posts", cell: (c) => c.posts, align: "right" },
              { key: "reach", header: "Reach", cell: (c) => num(c.reach), align: "right" },
              { key: "eng", header: "Engagement", cell: (c) => num(c.engagement), align: "right" },
              { key: "clicks", header: "Clicks", cell: (c) => num(c.clicks), align: "right" },
              { key: "spend", header: "Spend", cell: (c) => formatINR(c.spendPaise), align: "right" },
            ]}
          />
        </div>
      )}
      {s.top.length > 0 && (
        <>
          <p className="mt-4 mb-1 text-xs font-semibold">Best posts by reach</p>
          <ol className="space-y-1 text-sm">
            {s.top.map((p) => (
              <li key={p.deliverableId} className="flex flex-wrap justify-between gap-2">
                <span>
                  {p.liveUrl ? (
                    <a href={p.liveUrl} target="_blank" rel="noreferrer" className="underline">
                      {p.title}
                    </a>
                  ) : (
                    p.title
                  )}
                  <span className="text-xs text-ink-muted">
                    {mode === "team" ? ` · ${p.client}` : ""}
                    {p.channel ? ` · ${deliverChannelLabels[p.channel as DeliverChannel] ?? p.channel}` : ""}
                  </span>
                </span>
                <span className="text-xs tabular-nums text-ink-muted">
                  {num(p.reach)} reach · {num(p.engagement)} engagement
                </span>
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}

/** Each client's social accounts and whether posts need the client's sign-off before they can be published. */
export function PublishingSettings() {
  const loaded = useLoad(() => api.creative.settings(), { live: ["ContentChannel", "ClientOrg"] });
  const [fresh, setFresh] = useState<CreativeSettingsView>();
  const [seen, setSeen] = useState(loaded.data);
  if (seen !== loaded.data) {
    setSeen(loaded.data);
    setFresh(undefined);
  }
  const [form, setForm] = useState<{ clientOrgId: string; platform: DeliverChannel; handle: string; url: string }>({ clientOrgId: "", platform: "instagram", handle: "", url: "" });
  const [error, setError] = useState<string>();
  const s = fresh ?? loaded.data;
  if (!s) return <LoadState loading={loaded.loading} error={loaded.error} />;
  const run = async (fn: () => Promise<CreativeSettingsView>) => {
    setError(undefined);
    try {
      setFresh(await fn());
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };
  return (
    <Panel title="Channels and publishing rules" subtitle="Where each client posts, and who must approve a post before it can go out." className="mt-8">
      {error && <p className="mb-3 text-sm text-red">{error}</p>}
      {s.rules.length === 0 ? (
        <Empty>No clients yet.</Empty>
      ) : (
        <ul className="divide-y divide-border text-sm" data-testid="publishing-settings">
          {s.rules.map((r) => {
            const channels = s.channels.filter((c) => c.clientId === r.clientId);
            return (
              <li key={r.clientId} className="flex flex-wrap items-start gap-4 py-3">
                <span className="w-48 font-semibold">{r.client}</span>
                <span className="min-w-48 flex-1">
                  {channels.length ? (
                    channels.map((c) => (
                      <span key={c.id} className="mr-2 mb-1 inline-flex items-center gap-1 border border-border bg-canvas px-2 py-0.5 text-xs">
                        {deliverChannelLabels[c.platform]}:{" "}
                        {c.url ? (
                          <a href={c.url} target="_blank" rel="noreferrer" className="underline">
                            {c.handle}
                          </a>
                        ) : (
                          c.handle
                        )}
                        {s.canEdit && (
                          <button className="ml-1 text-ink-muted hover:text-red" aria-label={`Remove ${c.handle}`} onClick={() => run(() => api.creative.removeChannel(c.id))}>
                            ×
                          </button>
                        )}
                      </span>
                    ))
                  ) : (
                    <span className="text-xs text-ink-muted">No channels yet</span>
                  )}
                </span>
                <label className="flex items-center gap-2 text-xs">
                  <input type="checkbox" checked={r.publishNeedsApproval} disabled={!s.canEdit} onChange={(e) => run(() => api.creative.setPublishRule(r.clientId, e.target.checked))} data-rule={r.clientId} />
                  {r.publishNeedsApproval ? "Client approves every post" : "BMU can approve posts"}
                </label>
              </li>
            );
          })}
        </ul>
      )}
      {s.canEdit && s.rules.length > 0 && (
        <form
          className="mt-3 flex flex-wrap gap-2 border-t border-border pt-3"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await run(() => api.creative.addChannel({ clientOrgId: form.clientOrgId, platform: form.platform, handle: form.handle, url: form.url || null }))) setForm({ ...form, handle: "", url: "" });
          }}
        >
          <Select value={form.clientOrgId} onChange={(e) => setForm({ ...form, clientOrgId: e.target.value })} required aria-label="Client">
            <option value="">Client…</option>
            {s.rules.map((r) => (
              <option key={r.clientId} value={r.clientId}>
                {r.client}
              </option>
            ))}
          </Select>
          <Select value={form.platform} onChange={(e) => setForm({ ...form, platform: e.target.value as DeliverChannel })} aria-label="Platform">
            {DELIVER_CHANNELS.map((c) => (
              <option key={c} value={c}>
                {deliverChannelLabels[c]}
              </option>
            ))}
          </Select>
          <Input placeholder="@handle or page name" value={form.handle} onChange={(e) => setForm({ ...form, handle: e.target.value })} required />
          <Input type="url" placeholder="Profile link (optional)" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} />
          <Button type="submit" variant="secondary">
            Add channel
          </Button>
        </form>
      )}
      <p className="mt-3 text-xs text-ink-muted">Posting itself is done on each platform for now; mark posts published here with the live link, then add their results.</p>
    </Panel>
  );
}
