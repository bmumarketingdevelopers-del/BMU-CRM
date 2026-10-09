"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { NotificationView } from "@bmu/shared";
import { api } from "@/lib/api";
import { when } from "@/components/request-bits";
import { useLiveChanges } from "@/lib/live";

/** In-app notifications. v13: new ones appear at once (live updates); still checks every 30 seconds as a fallback. Every item deep-links to the exact screen. */
export function NotificationBell() {
  const [data, setData] = useState<{ unread: number; items: NotificationView[] }>();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  const refresh = useCallback(() => {
    api.notifications.list().then(setData, () => {});
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 30_000);
    return () => clearInterval(t);
  }, [refresh]);
  useLiveChanges(refresh, ["Notification"]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const unread = data?.unread ?? 0;
  const markAll = () => api.notifications.read("all").then(setData, () => {});
  const markOne = (id: string) => api.notifications.read([id]).then(setData, () => {});

  return (
    <div ref={box} className="relative">
      <button
        aria-label={unread ? `${unread} unread notifications` : "Notifications"}
        onClick={() => (setOpen((o) => !o), refresh())}
        className="relative flex h-9 w-9 items-center justify-center text-ink-muted hover:bg-canvas hover:text-ink"
      >
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
          <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red px-1 text-[10px] font-bold text-white">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>
      {open && (
        <div className="fixed left-4 right-4 top-16 z-50 border border-border bg-surface-raised text-ink shadow-xl sm:left-auto sm:right-4 sm:w-80 md:left-[15.5rem] md:right-auto md:top-4">
          <div className="flex items-center justify-between border-b border-border px-3 py-2 text-sm">
            <span className="font-semibold">Notifications</span>
            {unread > 0 && (
              <button className="text-xs underline" onClick={markAll}>
                Mark all read
              </button>
            )}
          </div>
          <ul className="max-h-96 divide-y divide-border overflow-y-auto text-sm">
            {data?.items.map((n) => {
              const inner = (
                <>
                  <p className={`${n.read ? "" : "font-semibold"} ${n.critical && !n.read ? "text-red" : ""}`}>{n.title}</p>
                  {n.body && <p className="mt-0.5 line-clamp-2 text-xs text-ink-muted">{n.body}</p>}
                  <p className="mt-0.5 text-[11px] text-ink-muted">{when.format(new Date(n.at))}</p>
                </>
              );
              return (
                <li key={n.id} className={n.read ? "" : "bg-green/5"}>
                  {n.link ? (
                    <Link href={n.link} className="block px-3 py-2 hover:bg-canvas/50" onClick={() => (markOne(n.id), setOpen(false))}>
                      {inner}
                    </Link>
                  ) : (
                    <div className="px-3 py-2">{inner}</div>
                  )}
                </li>
              );
            })}
            {data && data.items.length === 0 && <li className="px-3 py-6 text-center text-ink-muted">You&apos;re all caught up.</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
