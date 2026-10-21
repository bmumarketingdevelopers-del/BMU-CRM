"use client";

// v34: social content at a glance on the Founder's Weekly Review: the next 7 days, work waiting on clients, posts
// past their time and failed auto-publishing. Hidden for people who can't see it (the API answers 403).
import Link from "next/link";
import { deliverChannelLabels, type ContentWeekPost, type DeliverChannel } from "@bmu/shared";
import { Panel, StatRow, StatTile } from "@/components/dash";
import { LoadState } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

const when = new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" });
const channel = (c: string | null) => (c ? (deliverChannelLabels[c as DeliverChannel] ?? c) : null);

function List({ title, rows, empty, extra }: { title: string; rows: ContentWeekPost[]; empty: string; extra?: (r: ContentWeekPost) => string | null }) {
  return (
    <div className="min-w-0">
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-muted">{title}</h3>
      {rows.length ? (
        <ul className="divide-y divide-border border-y border-border text-sm">
          {rows.map((r) => (
            <li key={r.id} className="py-2">
              <Link href={`/team/deliverables/${r.id}`} className="font-medium hover:underline">
                {r.title}
              </Link>
              <div className="text-xs text-ink-muted">{[r.client, channel(r.channel), r.at ? when.format(new Date(r.at)) : null, extra?.(r)].filter(Boolean).join(" · ")}</div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-ink-muted">{empty}</p>
      )}
    </div>
  );
}

export function ContentWeekPanel() {
  const s = useLoad(() => api.insights.contentWeek(), { live: ["Deliverable", "PostPublication"] });
  if (!s.data) return s.error ? null : <LoadState loading={s.loading} />;
  const d = s.data;
  return (
    <Panel
      className="min-w-0"
      title="Content this week"
      subtitle="Social posts in the next 7 days, work waiting on clients, posts past their time and failed auto-publishing."
      action={
        <Link href="/team/content-calendar" className="text-xs text-ink-muted hover:text-ink">
          Content calendar →
        </Link>
      }
    >
      <div data-testid="content-week" className="space-y-5">
        <StatRow cols={5}>
          <StatTile label="Scheduled, next 7 days" value={d.scheduledCount} />
          <StatTile label="Published, last 7 days" value={d.publishedLast7} tone={d.publishedLast7 ? "good" : "default"} />
          <StatTile label="Waiting on clients" value={d.waitingCount} tone={d.waitingCount ? "warn" : "default"} href="/team/reviews" />
          <StatTile label="Past time, not posted" value={d.dueToPost.length} tone={d.dueToPost.length ? "bad" : "default"} href="/team/content-calendar" />
          <StatTile label="Failed to publish" value={d.failed.length} tone={d.failed.length ? "bad" : "default"} />
        </StatRow>
        <div className="grid gap-6 lg:grid-cols-2">
          <List title="Coming up" rows={d.scheduled} empty="Nothing scheduled for the next 7 days." />
          <List title="Waiting on clients" rows={d.waitingOnClient} empty="Nothing waiting on clients." extra={(r) => `waiting ${(r as ContentWeekPost & { days: number }).days} day(s)`} />
          {d.dueToPost.length > 0 && <List title="Past their time, not marked published" rows={d.dueToPost} empty="" />}
          {d.failed.length > 0 && <List title="Failed to publish" rows={d.failed} empty="" extra={(r) => r.note ?? null} />}
        </div>
      </div>
    </Panel>
  );
}
