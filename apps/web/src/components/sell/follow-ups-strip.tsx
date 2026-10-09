"use client";

import Link from "next/link";
import { leadStageLabels } from "@bmu/shared";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

const dFmt = new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });
const istDay = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(d);

/** "Your follow-ups": overdue, today and the next 7 days. */
export function FollowUpsStrip() {
  const list = useLoad(() => api.sell.followUps());
  if (!list.data || list.data.length === 0) return null;
  const today = istDay(new Date());
  const due = list.data.filter((f) => istDay(new Date(f.nextFollowUpAt)) <= today);
  return (
    <section aria-label="Your follow-ups" className="mb-6 border border-border bg-surface-raised p-4">
      <h2 className="text-sm font-semibold">
        Your follow-ups{" "}
        <span className="font-normal text-ink-muted">
          · {due.length} due today or overdue, {list.data.length - due.length} this week
        </span>
      </h2>
      <ul className="mt-2 flex flex-wrap gap-2 text-sm">
        {list.data.slice(0, 12).map((f) => {
          const isDue = istDay(new Date(f.nextFollowUpAt)) <= today;
          return (
            <li key={f.leadId}>
              <Link href={`/team/leads/${f.leadId}`} className={`inline-block border px-3 py-1 ${f.overdue ? "border-red" : isDue ? "border-amber" : "border-border"}`}>
                <span className="font-medium">{f.name}</span>{" "}
                <span className="text-xs text-ink-muted">
                  {f.overdue ? "overdue · " : ""}
                  {dFmt.format(new Date(f.nextFollowUpAt))} · {leadStageLabels[f.stage]}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
