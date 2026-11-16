"use client";

import { useCallback, useEffect, useState } from "react";
import type { ClientChatList, ThreadView } from "@bmu/shared";
import { Chat } from "@/components/chat";
import { LoadState, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

type ChatKey = "owner" | "am";

const timeOf = (iso: string) => {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return new Intl.DateTimeFormat("en-IN", today ? { timeStyle: "short", timeZone: "Asia/Kolkata" } : { day: "numeric", month: "short", timeZone: "Asia/Kolkata" }).format(d);
};

/**
 * Client messages, WhatsApp style: a chat list (BMU Owner once the Founder has written, then the Client Manager)
 * and the open chat. Phone and tablet: the list first, tap a chat to open it, ← goes back. Desktop: list left, chat right.
 */
export default function ClientMessagesPage() {
  const loaded = useLoad(() => api.client.chats());
  const [list, setList] = useState<ClientChatList>();
  const chats = list ?? loaded.data;

  // A notification for the Owner chat links to ?chat=owner: open that chat straight away.
  // (The first render is the loading state on server and browser alike, so reading the address here is safe.)
  const [fromOwnerLink] = useState(() => typeof window !== "undefined" && new URLSearchParams(window.location.search).get("chat") === "owner");
  const [selected, setSelected] = useState<ChatKey>(fromOwnerLink ? "owner" : "am");
  /** Phone only: the chat is open (otherwise the list shows). */
  const [phoneChatOpen, setPhoneChatOpen] = useState(fromOwnerLink);
  const [thread, setThread] = useState<ThreadView>();
  const [threadError, setThreadError] = useState<string>();

  const refreshList = useCallback(async () => setList(await api.client.chats()), []);
  const loadThread = useCallback(async (key: ChatKey) => (key === "owner" ? api.client.ownerThread() : api.client.thread()), []);

  // Open the selected chat (this marks it read), then refresh the list so its unread count clears.
  useEffect(() => {
    if (!chats) return;
    const key: ChatKey = selected === "owner" && !chats.owner ? "am" : selected;
    let stale = false;
    loadThread(key)
      .then((t) => {
        if (stale) return;
        setThreadError(undefined);
        setThread(t);
        refreshList().catch(() => {});
      })
      .catch((err: Error) => !stale && setThreadError(err.message));
    return () => {
      stale = true;
    };
    // When the list first arrives, the chosen chat changes, or the Owner chat first appears.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!chats, selected, !!chats?.owner, loadThread, refreshList]);

  // The list refreshes every 15 seconds (new chats, unread counts), like the open chat does.
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === "visible") refreshList().catch(() => {});
    }, 15_000);
    return () => clearInterval(t);
  }, [refreshList]);

  if (!chats) return <LoadState loading={loaded.loading} error={loaded.error} />;

  const current: ChatKey = selected === "owner" && !chats.owner ? "am" : selected;
  const amName = chats.am.name;
  const open = (key: ChatKey) => {
    if (key !== current) {
      setThread(undefined);
      setThreadError(undefined);
    }
    setSelected(key);
    setPhoneChatOpen(true);
  };

  const rows: { key: ChatKey; name: string; line: string; at?: string; unread: number; initial: string }[] = [
    ...(chats.owner
      ? [{ key: "owner" as const, name: "BMU Owner", line: chats.owner.lastMessage?.body || "No messages yet", at: chats.owner.lastMessage?.at, unread: chats.owner.unread, initial: "B" }]
      : []),
    { key: "am", name: amName ?? "Client Manager", line: amName ? "Client Manager" : "Not assigned yet", at: chats.am.lastMessage?.at, unread: chats.am.unread, initial: (amName ?? "C").charAt(0).toUpperCase() },
  ];
  const head = rows.find((r) => r.key === current)!;

  return (
    <>
      <PageTitle
        title="Messages"
        subtitle={amName ? `Talk to ${amName}, your Client Manager. Replies come the same working day (9:30–6:30, Mon–Sat).` : "Talk to your Client Manager. Replies come the same working day."}
      />
      <div className="grid border border-border bg-surface-raised lg:grid-cols-[280px_1fr]" data-testid="client-chat-layout">
        {/* Chat list */}
        <ul className={`border-border lg:block lg:border-r ${phoneChatOpen ? "hidden" : "block"}`} aria-label="Chats" data-testid="client-chat-list">
          {rows.map((r) => (
            <li key={r.key}>
              <button
                type="button"
                onClick={() => open(r.key)}
                aria-current={r.key === current ? "true" : undefined}
                data-testid={`client-chat-row-${r.key}`}
                className={`flex w-full items-center gap-3 border-b border-border px-4 py-3 text-left hover:bg-canvas ${r.key === current ? "lg:bg-canvas" : ""}`}
              >
                <span aria-hidden className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-charcoal text-sm font-semibold text-ivory">
                  {r.initial}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="truncate font-medium text-charcoal">{r.name}</span>
                    {r.at && <span className={`shrink-0 text-[11px] ${r.unread ? "font-semibold text-green" : "text-ink-muted"}`}>{timeOf(r.at)}</span>}
                  </span>
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm text-ink-muted">{r.line}</span>
                    {r.unread > 0 && (
                      <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-green px-1.5 text-[11px] font-semibold text-white" aria-label={`${r.unread} unread`}>
                        {r.unread}
                      </span>
                    )}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>

        {/* Open chat */}
        <section className={`min-w-0 lg:block ${phoneChatOpen ? "block" : "hidden"}`} aria-label={`Chat with ${head.name}`} data-testid="client-chat-panel">
          <div className="flex items-center gap-3 border-b border-border px-4 py-3">
            <button type="button" onClick={() => setPhoneChatOpen(false)} className="-ml-1 px-1 text-lg text-charcoal lg:hidden" aria-label="Back to chats" data-testid="client-chat-back">
              ←
            </button>
            <span aria-hidden className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-charcoal text-sm font-semibold text-ivory">
              {head.initial}
            </span>
            <span className="min-w-0">
              <span className="block truncate font-medium text-charcoal">{head.name}</span>
              <span className="block truncate text-xs text-ink-muted">{current === "owner" ? "BMU Owner" : amName ? "Client Manager" : "Not assigned yet"}</span>
            </span>
          </div>
          {threadError ? (
            <p className="p-4 text-sm text-red">{threadError}</p>
          ) : !thread ? (
            <p className="p-4 text-sm text-ink-muted">Loading…</p>
          ) : (
            // The chat box has its own border; this panel already has one, so hide the inner one here.
            <div className="[&>div]:border-0" data-testid="client-chat-box">
              <Chat
                key={current}
                thread={thread}
                onSend={async (body, _internal, files) => {
                  setThread(current === "owner" ? await api.client.sendOwnerMessage(body, files) : await api.client.sendMessage(body, files));
                  refreshList().catch(() => {});
                }}
                onRefresh={async () => setThread(await loadThread(current))}
                onUpload={(f) => (current === "owner" ? api.service.uploadOwnerAttachment(f) : api.service.uploadAttachment(f))}
              />
            </div>
          )}
        </section>
      </div>
    </>
  );
}
