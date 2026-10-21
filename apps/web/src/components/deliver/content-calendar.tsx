"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { CHANNEL_PROVIDER, DELIVER_CHANNELS, deliverChannelLabels, formatINR, type DeliverCalendarItem, type DeliverCalendarView, type DeliverChannel } from "@bmu/shared";
import { Tabs } from "@/components/dash";
import { istMonth, istToday, monthLabel, shiftMonth } from "@/components/workspace/format";
import { Badge, Button, Input, LoadState, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { useAutoRefresh } from "@/lib/use-auto-refresh";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const IST = 330 * 60_000;
const istDay = (iso: string) => new Date(new Date(iso).getTime() + IST).toISOString().slice(0, 10);
const istTime = (iso: string) => new Date(new Date(iso).getTime() + IST).toISOString().slice(11, 16);
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const mondayOf = (day: string) => addDays(day, -((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7));
const dayLabel = (day: string) => new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${day}T00:00:00Z`));
const itemDay = (i: DeliverCalendarItem) => istDay(i.scheduledAt ?? i.publishedAt!);
const tone = (s: string, due?: boolean) => (s === "published" ? "bg-green/25 border-green" : due ? "bg-amber/15 border-amber" : "bg-surface-raised border-border");
const num = (n: number) => new Intl.NumberFormat("en-IN").format(n);

function monthCells(month: string) {
  const start = mondayOf(`${month}-01`);
  const last = addDays(`${shiftMonth(month, 1)}-01`, -1);
  const end = addDays(mondayOf(last), 6);
  const cells: { day: string; inMonth: boolean }[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) cells.push({ day: d, inMonth: d.startsWith(month) });
  return cells;
}

/**
 * Content calendar (month / week). Team: drag approved posts from "Ready to schedule" onto a day, drag scheduled
 * posts to another day, click a post to set channel and time or mark it published. Client: read-only.
 */
export function ContentCalendar({ mode }: { mode: "team" | "client" }) {
  const [view, setView] = useState<"month" | "week">("month");
  const [month, setMonth] = useState(istMonth());
  const [week, setWeek] = useState(mondayOf(istToday()));
  const [data, setData] = useState<DeliverCalendarView>();
  const [error, setError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [selected, setSelected] = useState<string>();
  const [dragging, setDragging] = useState<string>();
  const [over, setOver] = useState<string>();

  const days = view === "month" ? monthCells(month) : Array.from({ length: 7 }, (_, i) => ({ day: addDays(week, i), inMonth: true }));
  const from = `${days[0].day}T00:00:00+05:30`;
  const to = `${addDays(days.at(-1)!.day, 1)}T00:00:00+05:30`;

  const load = useCallback(() => {
    (mode === "team" ? api.deliver.calendar(from, to) : api.deliver.clientCalendar(from, to))
      .then((d) => {
        setData(d);
        setError(undefined);
      })
      .catch((e: Error) => setError(e.message));
  }, [mode, from, to]);
  useEffect(load, [load]);
  // v34: refresh on its own while open (approvals, scheduling, publishing anywhere; and every minute), not mid-drag.
  useAutoRefresh(() => {
    if (!dragging) load();
  }, ["Deliverable", "Version", "Approval", "PostPublication", "PostMetric"]);

  const items = data?.items ?? [];
  const all = [...items, ...(data?.unscheduled ?? [])];
  const sel = all.find((i) => i.deliverableId === selected) ?? data?.dueToPublish?.find((i) => i.deliverableId === selected);
  const canSchedule = !!data?.canSchedule;

  async function moveTo(id: string, day: string) {
    const it = all.find((i) => i.deliverableId === id);
    if (!it || it.status === "published") return;
    setActionError(undefined);
    const time = it.scheduledAt ? istTime(it.scheduledAt) : "11:00";
    try {
      await api.deliver.schedule(id, `${day}T${time}:00+05:30`, (it.channel ?? "instagram") as DeliverChannel);
      load();
      setSelected(id);
    } catch (e) {
      setActionError(`${it.title}: ${(e as Error).message}`);
    }
  }

  const today = istToday();
  return (
    <div data-testid="content-calendar">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button variant="secondary" className="px-2 py-1" aria-label="Previous" onClick={() => (view === "month" ? setMonth(shiftMonth(month, -1)) : setWeek(addDays(week, -7)))}>
            ←
          </Button>
          <p className="min-w-44 text-center font-medium">{view === "month" ? monthLabel(month) : `${dayLabel(week)} – ${dayLabel(addDays(week, 6))}`}</p>
          <Button variant="secondary" className="px-2 py-1" aria-label="Next" onClick={() => (view === "month" ? setMonth(shiftMonth(month, 1)) : setWeek(addDays(week, 7)))}>
            →
          </Button>
          <Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => (setMonth(istMonth()), setWeek(mondayOf(istToday())))}>
            Today
          </Button>
        </div>
        <Tabs value={view} onChange={setView} options={[{ value: "month", label: "Month" }, { value: "week", label: "Week" }]} />
      </div>
      {actionError && (
        <p role="alert" className="mb-3 border border-red bg-red/10 px-3 py-2 text-sm">
          {actionError}
        </p>
      )}
      <LoadState loading={!data && !error} error={error} />

      {data && (
        <div className={canSchedule ? "grid gap-4 xl:grid-cols-[1fr_300px]" : ""}>
          <div className="overflow-x-auto">
            <div className="grid min-w-[640px] grid-cols-7 gap-px border border-border bg-border text-xs">
              {WEEKDAYS.map((w) => (
                <div key={w} className="bg-canvas px-2 py-1.5 font-medium text-ink-muted">
                  {w}
                </div>
              ))}
              {days.map(({ day, inMonth }) => {
                const list = items.filter((i) => itemDay(i) === day).sort((a, b) => (a.scheduledAt ?? "").localeCompare(b.scheduledAt ?? ""));
                return (
                  <div
                    key={day}
                    data-day={day}
                    onDragOver={(e) => {
                      if (!dragging) return;
                      e.preventDefault();
                      if (over !== day) setOver(day);
                    }}
                    onDragLeave={() => over === day && setOver(undefined)}
                    onDrop={(e) => {
                      e.preventDefault();
                      const id = e.dataTransfer.getData("text/plain") || dragging;
                      setOver(undefined);
                      setDragging(undefined);
                      if (id) moveTo(id, day);
                    }}
                    className={`${view === "week" ? "min-h-64" : "min-h-24"} bg-surface-raised p-1.5 ${inMonth ? "" : "bg-canvas/50 text-ink-muted"} ${over === day ? "outline-1 outline-dashed outline-green" : ""}`}
                  >
                    <p className={`mb-1 text-[11px] ${day === today ? "font-semibold text-ink" : "text-ink-muted"}`}>{view === "week" ? dayLabel(day) : Number(day.slice(8))}</p>
                    <div className="grid gap-1">
                      {list.map((i) => (
                        <button
                          key={i.deliverableId}
                          type="button"
                          draggable={canSchedule && i.status !== "published"}
                          onDragStart={(e) => {
                            e.dataTransfer.setData("text/plain", i.deliverableId);
                            setDragging(i.deliverableId);
                          }}
                          onDragEnd={() => setDragging(undefined)}
                          onClick={() => setSelected(i.deliverableId)}
                          data-item={i.deliverableId}
                          className={`block w-full truncate border-l-2 px-1.5 py-1 text-left text-[11px] ${tone(i.status, i.dueToPublish)} ${selected === i.deliverableId ? "ring-1 ring-charcoal" : ""} ${canSchedule && i.status !== "published" ? "cursor-grab" : ""}`}
                          title={`${i.title} · ${i.client.name}`}
                        >
                          <span className="tabular-nums text-ink-muted">{i.scheduledAt ? istTime(i.scheduledAt) : ""}</span> {i.title}
                          {mode === "team" && <span className="block truncate text-[10px] text-ink-muted">{i.client.name}</span>}
                          <span className="block text-[10px] text-ink-muted">
                            {i.channel ? deliverChannelLabels[i.channel] : ""} {i.status === "published" ? "· Live" : i.dueToPublish ? "· Due to post" : ""}
                            {i.metrics ? ` · ${num(i.metrics.reach)} reach` : ""}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="mt-2 text-xs text-ink-muted">
              {canSchedule ? "Drag a post onto a day to schedule or move it. Click a post to change its time and channel or mark it published." : "What goes out when. Green means it is live."}
            </p>
          </div>

          {canSchedule && (
            <aside className="space-y-4">
              {!!data.dueToPublish?.length && (
                <section className="border border-amber bg-amber/10" data-testid="due-to-post">
                  <h3 className="border-b border-amber px-4 py-3 text-sm font-semibold">Due to post now ({data.dueToPublish.length})</h3>
                  <p className="px-4 pt-2 text-xs text-ink-muted">Their time has passed. Post them on the channel, then mark each published with its live link.</p>
                  <div className="grid gap-1 p-2">
                    {data.dueToPublish.map((i) => (
                      <button key={i.deliverableId} type="button" onClick={() => setSelected(i.deliverableId)} className="border border-border bg-surface-raised px-2 py-1.5 text-left text-xs hover:border-ink">
                        <span className="font-medium">{i.title}</span>
                        <span className="block text-ink-muted">
                          {i.client.name} · {i.channel ? deliverChannelLabels[i.channel] : ""} · {i.scheduledAt ? `${istDay(i.scheduledAt)} ${istTime(i.scheduledAt)}` : ""}
                        </span>
                      </button>
                    ))}
                  </div>
                </section>
              )}
              <section className="border border-border bg-surface-raised">
                <h3 className="border-b border-border px-4 py-3 text-sm font-semibold">Ready to schedule ({data.unscheduled.length})</h3>
                <div className="grid max-h-80 gap-1 overflow-y-auto p-2">
                  {data.unscheduled.map((i) => (
                    <button
                      key={i.deliverableId}
                      type="button"
                      draggable
                      data-unscheduled={i.deliverableId}
                      onDragStart={(e) => {
                        e.dataTransfer.setData("text/plain", i.deliverableId);
                        setDragging(i.deliverableId);
                      }}
                      onDragEnd={() => setDragging(undefined)}
                      onClick={() => setSelected(i.deliverableId)}
                      className={`cursor-grab border border-border px-2 py-1.5 text-left text-xs hover:border-ink ${selected === i.deliverableId ? "ring-1 ring-charcoal" : ""}`}
                    >
                      <span className="font-medium">{i.title}</span>
                      <span className="block text-ink-muted">
                        {i.client.name} · {i.type}
                      </span>
                    </button>
                  ))}
                  {data.unscheduled.length === 0 && <p className="px-2 py-3 text-xs text-ink-muted">Approved social posts appear here until they get a date.</p>}
                </div>
              </section>
              {sel && <ItemEditor key={`${sel.deliverableId}-${sel.scheduledAt}-${sel.status}-${sel.metrics?.at ?? ""}`} item={sel} onSaved={load} onError={setActionError} />}
            </aside>
          )}
          {!canSchedule && sel && (
            <div className="mt-4 border border-border bg-surface-raised p-4 text-sm">
              <p className="font-medium">{sel.title}</p>
              <p className="text-xs text-ink-muted">
                {sel.serviceName} · {sel.channel ? deliverChannelLabels[sel.channel] : ""} · {sel.scheduledAt ? new Date(sel.scheduledAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" }) : ""}
              </p>
              {sel.preview?.kind === "image" && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={sel.preview.url} alt={sel.title} className="mt-2 max-h-48 border border-border" />
              )}
              {sel.caption && <p className="mt-2 whitespace-pre-wrap text-xs">{sel.caption}</p>}
              {sel.metrics && <Metrics m={sel.metrics} />}
              {sel.liveUrl ? (
                <a href={sel.liveUrl} target="_blank" rel="noreferrer" className="mt-2 inline-block underline">
                  See it live
                </a>
              ) : (
                <p className="mt-2 text-xs text-ink-muted">Scheduled. The live link appears here once it is published.</p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function ItemEditor({ item, onSaved, onError }: { item: DeliverCalendarItem; onSaved: () => void; onError: (m?: string) => void }) {
  const [date, setDate] = useState(item.scheduledAt ? istDay(item.scheduledAt) : istToday());
  const [time, setTime] = useState(item.scheduledAt ? istTime(item.scheduledAt) : "11:00");
  const [channel, setChannel] = useState<DeliverChannel>(item.channel ?? "instagram");
  const [liveUrl, setLiveUrl] = useState("");
  const [caption, setCaption] = useState(item.caption ?? "");
  const [results, setResults] = useState({ reach: "", impressions: "", engagement: "", clicks: "", spendRupees: "" });
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    onError(undefined);
    try {
      await fn();
      onSaved();
    } catch (e) {
      onError(`${item.title}: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="border border-border bg-surface-raised p-4 text-sm" data-testid="calendar-editor">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-medium">{item.title}</p>
          <p className="text-xs text-ink-muted">
            {item.client.name} · {item.serviceName}
          </p>
        </div>
        <Badge tone={item.status === "published" ? "green" : item.status === "scheduled" ? "dark" : "amber"}>{item.status === "approved" ? "Not scheduled" : item.status === "scheduled" ? "Scheduled" : "Published"}</Badge>
      </div>
      {item.preview?.kind === "image" && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={item.preview.url} alt={item.title} className="mt-2 max-h-36 border border-border" />
      )}
      <Link href={`/team/deliverables/${item.deliverableId}`} className="mt-1 inline-block text-xs underline">
        Open deliverable
      </Link>
      {item.status !== "published" ? (
        <form
          className="mt-3 grid gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => api.deliver.schedule(item.deliverableId, `${date}T${time}:00+05:30`, channel));
          }}
        >
          <div className="grid grid-cols-2 gap-2">
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} required aria-label="Date" />
            <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} required aria-label="Time" />
          </div>
          <Select value={channel} onChange={(e) => setChannel(e.target.value as DeliverChannel)} aria-label="Channel">
            {DELIVER_CHANNELS.map((c) => (
              <option key={c} value={c}>
                {deliverChannelLabels[c]}
              </option>
            ))}
          </Select>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy}>
              {item.scheduledAt ? "Save time" : "Schedule"}
            </Button>
            {item.status === "scheduled" && (
              <Button type="button" variant="ghost" disabled={busy} onClick={() => run(() => api.deliver.unschedule(item.deliverableId))}>
                Unschedule
              </Button>
            )}
          </div>
        </form>
      ) : (
        <p className="mt-3 text-xs">
          Live:{" "}
          <a className="break-all underline" href={item.liveUrl ?? "#"} target="_blank" rel="noreferrer">
            {item.liveUrl}
          </a>
        </p>
      )}
      {item.status !== "published" && (
        <form
          className="mt-4 grid gap-2 border-t border-border pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => api.creative.setCaption(item.deliverableId, caption.trim() || null));
          }}
        >
          <p className="text-xs font-medium">Caption</p>
          <textarea className="w-full border border-border bg-surface-raised px-2 py-1.5 text-xs" rows={3} maxLength={2200} value={caption} onChange={(e) => setCaption(e.target.value)} placeholder="Caption and hashtags" aria-label="Caption" />
          <Button type="submit" variant="ghost" className="justify-self-start px-2 py-1 text-xs" disabled={busy || caption === (item.caption ?? "")}>
            Save caption
          </Button>
        </form>
      )}
      {item.status === "published" && item.caption && <p className="mt-2 whitespace-pre-wrap text-xs text-ink-muted">{item.caption}</p>}
      {item.status === "published" && (
        <form
          className="mt-4 grid gap-2 border-t border-border pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            const n = (v: string) => (v.trim() ? Number(v) : 0);
            run(() => api.creative.recordResults(item.deliverableId, { reach: n(results.reach), impressions: n(results.impressions), engagement: n(results.engagement), clicks: n(results.clicks), spendRupees: n(results.spendRupees) }));
          }}
        >
          <p className="text-xs font-medium">Results</p>
          {item.metrics ? <Metrics m={item.metrics} /> : <p className="text-xs text-ink-muted">Copy the numbers from the platform&apos;s insights. You can update them as the post keeps running.</p>}
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                ["reach", "Reach"],
                ["impressions", "Impressions"],
                ["engagement", "Likes, comments, shares"],
                ["clicks", "Link clicks"],
                ["spendRupees", "Ad spend (₹)"],
              ] as const
            ).map(([k, label]) => (
              <Input key={k} type="number" min={0} step={k === "spendRupees" ? "0.01" : "1"} placeholder={label} aria-label={label} value={results[k]} onChange={(e) => setResults({ ...results, [k]: e.target.value })} />
            ))}
          </div>
          <Button type="submit" variant="secondary" disabled={busy}>
            {item.metrics ? "Update results" : "Save results"}
          </Button>
        </form>
      )}
      {item.channel && CHANNEL_PROVIDER[item.channel] && item.status !== "approved" && <AutoPublish item={item} busy={busy} run={run} />}
      {item.status === "scheduled" && (
        <form
          className="mt-4 grid gap-2 border-t border-border pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => api.deliver.publish(item.deliverableId, liveUrl));
          }}
        >
          <p className="text-xs font-medium">Posted? Mark it published</p>
          <Input type="url" value={liveUrl} onChange={(e) => setLiveUrl(e.target.value)} placeholder="Live post link (https://…)" required />
          <Button type="submit" variant="secondary" disabled={busy}>
            Mark published
          </Button>
        </form>
      )}
    </section>
  );
}

const PUB_TEXT = { queued: "Publishing failed, retrying soon", publishing: "Publishing now…", published: "Published automatically", failed: "Could not publish" } as const;

/** v19: auto-publishing status for posts on a channel BMU Hub can publish to, with a Publish now button. */
function AutoPublish({ item, busy, run }: { item: DeliverCalendarItem; busy: boolean; run: (fn: () => Promise<unknown>) => Promise<void> }) {
  const pub = useLoad(() => api.integrations.publication(item.deliverableId), { live: ["PostPublication"] });
  const p = pub.data;
  if (item.status === "published" && !p) return null;
  return (
    <div className="mt-4 grid gap-2 border-t border-border pt-3" data-testid="auto-publish">
      <p className="text-xs font-medium">Auto-publish</p>
      {p ? (
        <p className={`text-xs ${p.status === "failed" ? "text-[#b4432c]" : "text-ink-muted"}`}>
          {PUB_TEXT[p.status]} to {p.accountName}
          {p.attempts > 1 ? ` (try ${p.attempts})` : ""}
          {p.error ? `: ${p.error}` : ""}
        </p>
      ) : (
        <p className="text-xs text-ink-muted">Publishes by itself at the scheduled time if the client&apos;s {deliverChannelLabels[item.channel as DeliverChannel]} account is connected in Integrations.</p>
      )}
      {item.status === "scheduled" && p?.status !== "publishing" && (
        <Button type="button" variant="secondary" disabled={busy} onClick={() => run(async () => (p?.status === "failed" ? api.integrations.retryPublication(p.id) : api.integrations.publishNow(item.deliverableId)).then(() => pub.reload()))}>
          {p?.status === "failed" ? "Try again" : "Publish now"}
        </Button>
      )}
    </div>
  );
}

function Metrics({ m }: { m: NonNullable<DeliverCalendarItem["metrics"]> }) {
  return (
    <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs" data-testid="post-metrics">
      <dt className="text-ink-muted">Reach</dt>
      <dd className="tabular-nums">{num(m.reach)}</dd>
      <dt className="text-ink-muted">Impressions</dt>
      <dd className="tabular-nums">{num(m.impressions)}</dd>
      <dt className="text-ink-muted">Engagement</dt>
      <dd className="tabular-nums">{num(m.engagement)}</dd>
      <dt className="text-ink-muted">Clicks</dt>
      <dd className="tabular-nums">{num(m.clicks)}</dd>
      {m.spendPaise > 0 && (
        <>
          <dt className="text-ink-muted">Spend</dt>
          <dd className="tabular-nums">{formatINR(m.spendPaise)}</dd>
        </>
      )}
    </dl>
  );
}
