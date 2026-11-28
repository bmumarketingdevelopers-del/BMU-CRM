"use client";

import { useLive } from "@/lib/live";

/** v13: a quiet "Live" dot in the sidebar. Amber while reconnecting; hidden when live updates are off. */
export function LiveStatus({ look = "text" }: { look?: "text" | "pill" | "dot" }) {
  const live = useLive();
  if (!live || live.status === "off" || live.status === "connecting") return null;
  const ok = live.status === "live";
  // v54 redesign preview: a small status pill with a softly pulsing dot (green; amber while reconnecting).
  if (look === "dot")
    return (
      <span className={`relative inline-flex h-2.5 w-2.5 ${ok ? "live-status-pill-ok" : "live-status-pill-wait"}`} data-testid="live-status" data-status={live.status} title={ok ? "Live: screens update by themselves" : "Reconnecting. Checking for changes every 20 seconds."}>
        <span className="live-status-ping absolute inline-flex h-full w-full rounded-full" />
        <span className="live-status-dot relative inline-flex h-2.5 w-2.5 rounded-full" />
      </span>
    );
  if (look === "pill")
    return (
      <span className={`live-status-pill inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium ${ok ? "live-status-pill-ok" : "live-status-pill-wait"}`} data-testid="live-status" data-status={live.status} title={ok ? "Screens update by themselves" : "Reconnecting. Checking for changes every 20 seconds."}>
        <span className="relative inline-flex h-2 w-2">
          <span className="live-status-ping absolute inline-flex h-full w-full rounded-full" />
          <span className="relative inline-flex h-2 w-2 rounded-full live-status-dot" />
        </span>
        {ok ? "Live" : "Reconnecting"}
      </span>
    );
  return (
    <span className="ml-1 inline-flex items-center gap-1 align-middle" data-testid="live-status" data-status={live.status} title={ok ? "Screens update by themselves" : "Reconnecting. Checking for changes every 20 seconds."}>
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${ok ? "bg-green" : "bg-amber"}`} />
      {ok ? "Live" : "Reconnecting"}
    </span>
  );
}
