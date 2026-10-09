"use client";

import { useLive } from "@/lib/live";

/** v13: a quiet "Live" dot in the sidebar. Amber while reconnecting; hidden when live updates are off. */
export function LiveStatus() {
  const live = useLive();
  if (!live || live.status === "off" || live.status === "connecting") return null;
  const ok = live.status === "live";
  return (
    <span className="ml-1 inline-flex items-center gap-1 align-middle" data-testid="live-status" data-status={live.status} title={ok ? "Screens update by themselves" : "Reconnecting. Checking for changes every 20 seconds."}>
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${ok ? "bg-green" : "bg-amber"}`} />
      {ok ? "Live" : "Reconnecting"}
    </span>
  );
}
