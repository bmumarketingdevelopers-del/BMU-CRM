"use client";

import Link from "next/link";
import { useEffect } from "react";
import { Badge, LoadState, PageTitle } from "@/components/ui";
import { when } from "@/components/request-bits";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

export default function TeamMessagesPage() {
  const list = useLoad(() => api.threads.list());
  const { reload } = list;
  useEffect(() => {
    const t = setInterval(() => document.visibilityState === "visible" && reload(), 30_000);
    return () => clearInterval(t);
  }, [reload]);
  if (!list.data) return <LoadState loading={list.loading} error={list.error} />;
  const waiting = list.data.filter((t) => t.awaitingReply);
  const overdue = waiting.filter((t) => t.awaitingReply?.overdue);
  return (
    <>
      <PageTitle
        action={
          <Link href="/team/discussions?new=1" className="bg-charcoal px-3 py-1.5 text-sm font-medium text-ivory" data-testid="start-discussion">
            Start discussion
          </Link>
        }
        title="Messages"
        subtitle={`Client conversations. Reply the same working day.${waiting.length ? ` ${waiting.length} waiting for you${overdue.length ? `, ${overdue.length} overdue` : ""}.` : " Nobody is waiting."}`}
      />
      <div className="border-t border-border">
        {list.data.map((t) => (
          <Link key={t.id} href={`/team/messages/${t.id}`} className="flex items-center justify-between gap-3 border-b border-border py-4 text-sm hover:bg-canvas/40">
            <div className="min-w-0">
              <p className={t.unread ? "font-semibold" : "font-medium"}>
                {t.client.name}
                {!!t.unread && (
                  <span className="ml-2 inline-flex h-5 min-w-5 items-center justify-center bg-green px-1.5 text-[11px] font-bold text-charcoal" aria-label={`${t.unread} unread`}>
                    {t.unread}
                  </span>
                )}
              </p>
              <p className="truncate text-xs text-ink-muted">{t.lastMessage ? `${t.lastMessage.author}: ${t.lastMessage.body}` : "No messages yet"}</p>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1 text-xs text-ink-muted sm:flex-row sm:items-center sm:gap-2">
              {t.awaitingReply && <Badge tone={t.awaitingReply.overdue ? "red" : "amber"}>{t.awaitingReply.overdue ? "Reply overdue" : "Awaiting reply"}</Badge>}
              {t.lastMessage && when.format(new Date(t.lastMessage.at))}
            </div>
          </Link>
        ))}
        {list.data.length === 0 && <p className="py-8 text-center text-sm text-ink-muted">No client conversations yet.</p>}
      </div>
    </>
  );
}
