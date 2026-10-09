"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { api } from "@/lib/api";

/** Unread client messages, shown next to "Messages" in the menu. Refreshes every 30 seconds and on navigation. */
export function UnreadBadge() {
  const [n, setN] = useState(0);
  const path = usePathname()!;
  useEffect(() => {
    let alive = true;
    const load = () =>
      api.service.unread().then(
        (r) => alive && setN(r.messages),
        () => {},
      );
    load();
    const t = setInterval(() => document.visibilityState === "visible" && load(), 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [path]);
  if (!n) return null;
  return (
    <span className="ml-1.5 inline-flex h-4 min-w-4 items-center justify-center bg-green px-1 text-[10px] font-bold text-charcoal" aria-label={`${n} unread messages`} data-testid="unread-badge">
      {n > 99 ? "99+" : n}
    </span>
  );
}
